import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Handle, Position } from '@xyflow/react'
import {
  Button, FileTypeIcon, IconBranchOutlineRegular, IconChevronDownOutlineRegular,
  IconCopyOutlineRegular, IconEditOutlineRegular, IconFullscreenOutlineRegular,
  IconLinkOutlineRegular, IconListPenOutlineRegular, IconPlanOutlineRegular, IconPlayOutlineRegular,
  IconPlusOutlineRegular, IconSlidersTwoOutlineRegular, IconSparkleRegular, IconTrashOutlineRegular,
  Input, Menu, Modal, Tag, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  assetFolders, groupFields, isMedia, mediaTypes, modeLabels, nodeLabels, nodeTitle,
  profileCandidates, referenceIds, referenceLimit, resolveProfile, shotLabel, textTypes, videoMode,
} from './canvas-node.jsx'
import { TaskStatus, taskActive } from './task-drawer.jsx'
import { useNodeEditorPlacement } from './node-editor-placement.js'
import { DurationControl, NodeParameterPopover } from './node-parameter-popover.jsx'
import cardStyle from './node-card.css'

export { cardStyle }

const interactions = 'nodrag nopan nowheel'
const typeIcons = {
  script: IconListPenOutlineRegular,
  shot: IconPlanOutlineRegular,
  prompt: IconSparkleRegular,
  note: IconEditOutlineRegular,
}

function NodeIcon({ type, size = 16 }) {
  if (type === 'audio') return <IconPlayOutlineRegular size={size} />
  if (mediaTypes.has(type)) return <FileTypeIcon kind={type} size={size} />
  const Icon = typeIcons[type] ?? IconPlanOutlineRegular
  return <Icon size={size} />
}

function textValue(content, ...fields) {
  return fields.map(field => content[field]).find(value => typeof value === 'string' && value.trim()) ?? ''
}

function savedText(node) {
  return textValue(node.content, 'text', 'description', 'prompt').trim()
}

function nodeName(node) {
  return nodeTitle(node) || (isMedia(node) ? savedText(node).split('\n')[0].slice(0, 80) : '')
    || (node.shotId ? String(node.shotId) : nodeLabels[node.type])
}

function fieldLabel(node) {
  return groupFields.map(([field, label]) => node[field] && label + ' ' + node[field]).filter(Boolean).join(' · ')
}

function stopCanvasKeys(event) {
  if (event.key !== 'Tab') event.stopPropagation()
  if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229
    && event.target instanceof HTMLInputElement) event.preventDefault()
}

function preventCanvasDoubleClick(event) {
  event.stopPropagation()
}

function MenuSelect({ label, value, items, onChange, disabled = false, placeholder = '请选择', compact = false }) {
  const [open, setOpen] = useState(false)
  const selected = items.find(item => item.id === value)
  const id = useId()
  return <div className="drama-node-field">
    {!compact && <label id={id}>{label}</label>}
    <Menu open={open} portal compact autoFocus minWidthFromAnchor selectedId={value}
      onClose={() => setOpen(false)}
      onSelect={id => { onChange(id); setOpen(false) }}
      items={items}
      anchor={<Button size="sm" className="drama-node-select" aria-label={compact ? label : undefined}
        aria-labelledby={compact ? undefined : id}
        aria-haspopup="menu" aria-expanded={open} disabled={disabled || items.length === 0}
        onClick={() => setOpen(current => !current)}>
        <span title={selected?.title}>{selected?.label ?? placeholder}</span>
        <IconChevronDownOutlineRegular size={14} />
      </Button>} />
  </div>
}

function SourceMedia({ node, url, openPreview, selected }) {
  const [error, setError] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const videoRef = useRef(null)
  const [dimensions, setDimensions] = useState('')
  const [duration, setDuration] = useState('')
  const isImage = node.type === 'image'
  const name = nodeName(node)
  const storedDimensions = Number.isFinite(node.content.width) && Number.isFinite(node.content.height)
    ? node.content.width + ' × ' + node.content.height : ''
  const storedDuration = Number.isFinite(node.content.duration) && node.content.duration > 0
    ? node.content.duration + ' 秒' : ''

  useEffect(() => {
    if (!selected) videoRef.current?.pause()
  }, [selected])

  if (!url) return null
  if (node.type === 'audio') return <div className={'drama-node-media ' + interactions}>
    {error ? <span role="status">无法播放音频</span>
      : <audio controls preload="none" src={url} aria-label={name} onError={() => setError(true)} />}
  </div>
  return <div className="drama-node-media">
    <div className="drama-node-media-frame" data-media-type={node.type}>
      {error ? <div className="drama-node-media-placeholder" role="status">
        <NodeIcon type={node.type} size={21} /><span>{isImage ? '无法读取图片' : '无法播放视频'}</span>
      </div> : isImage ? <>
        <img src={url} alt={name} loading="lazy" decoding="async" draggable={false} onError={() => setError(true)}
          onLoad={event => {
            const image = event.currentTarget
            if (image.naturalWidth > 0 && image.naturalHeight > 0) {
              setDimensions(image.naturalWidth + ' × ' + image.naturalHeight)
            }
            setLoaded(true)
          }} />
        {!loaded && <span className="drama-node-media-loading" role="status">正在读取图片</span>}
        <div className={'drama-node-media-overlay ' + interactions}>
          <Tooltip label="查看大图" portal>
            <Button variant="toolbar" size="sm" aria-label="查看大图" onClick={openPreview}>
              <IconFullscreenOutlineRegular size={15} />
            </Button>
          </Tooltip>
        </div>
      </> : selected || enabled ? <video ref={videoRef} className={interactions} src={url} controls controlsList="nofullscreen" playsInline
        preload="metadata" aria-label={name} onDoubleClick={event => { event.preventDefault(); event.stopPropagation() }}
        onLoadedData={() => setEnabled(true)}
        onError={() => setError(true)}
        onLoadedMetadata={event => {
          const video = event.currentTarget
          if (video.videoWidth && video.videoHeight) setDimensions(video.videoWidth + ' × ' + video.videoHeight)
          if (Number.isFinite(video.duration)) setDuration(Math.round(video.duration * 10) / 10 + ' 秒')
        }} /> : <Button size="sm" variant="outline" icon={<IconPlayOutlineRegular size={15} />}
          onClick={() => setEnabled(true)}>打开视频预览</Button>}
    </div>
    <div className="drama-node-media-meta">
      <span>{[dimensions || storedDimensions, duration || storedDuration].filter(Boolean).join(' · ')}</span>
      {!isImage && <Button size="sm" variant="ghost" icon={<IconFullscreenOutlineRegular size={14} />}
        onClick={openPreview}>放大预览</Button>}
    </div>
  </div>
}

function ReadableText({ text, label }) {
  const [expanded, setExpanded] = useState(false)
  const id = useId()
  if (!text) return null
  const mayExpand = text.length > 90 || text.split('\n').length > 3
  return <section className="drama-node-reading">
    {label && <span className="drama-node-caption">{label}</span>}
    <p id={id} className={(expanded ? 'is-expanded ' : '') + interactions}>{text}</p>
    {mayExpand && <Button size="sm" className={'drama-node-expand ' + interactions}
      aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(current => !current)}>
      {expanded ? '收起全文' : '展开全文'}
    </Button>}
  </section>
}

function NodeReferences({ node, index, edges = [], actions }) {
  const incoming = edges.filter(edge => edge.target === node.id)
  if (!incoming.length) return null
  return <div className={'drama-node-reference-scroll ' + interactions}>
    {incoming.map(({ source }) => {
      const related = index?.get(source)
      const title = related ? nodeName(related) : '画布外来源 ' + source
      return <div key={source} className="drama-node-reference-entry">
        <Button size="sm" variant="outline" aria-label={'引用 · ' + title}
          onClick={() => actions.locate?.(source)}>{related ? title : '画布外来源'}</Button>
        {actions.removeReference && <Tooltip label={actions.mutationReason || '删除引用连线'} portal>
          <span><Button size="sm" aria-label={'删除引用连线 · ' + title} disabled={Boolean(actions.mutationReason)}
            onClick={() => actions.removeReference(source, node)}><IconTrashOutlineRegular size={14} /></Button></span>
        </Tooltip>}
      </div>
    })}
  </div>
}

function TaskDetail({ task, nodeId, locate }) {
  if (!task) return null
  return <section className={'drama-node-task-detail ' + interactions} aria-label="节点任务">
    <small title={task.providerTaskId ?? task.id}>任务 {(task.providerTaskId ?? task.id).slice(0, 12)}</small>
    {task.resultNodeId && task.resultNodeId !== nodeId && <Button size="sm" onClick={() => locate?.(task.resultNodeId)}>查看结果</Button>}
    {task.error && <details className="drama-node-task-error">
      <summary>查看任务信息</summary><p>{task.error}</p>
    </details>}
  </section>
}

const generationFields = { duration: '时长（秒）', resolution: '分辨率', aspectRatio: '画幅', generateAudio: '生成音频' }

function durationAllowed(profile, value) {
  const limits = profile.limits ?? {}
  return Number.isInteger(value) && value !== 0 && value >= -1 && value <= 3600 &&
    (value > 0 || ['ark', 'byteplus'].includes(profile.provider)) &&
    (!limits.durations?.length || limits.durations.includes(value)) &&
    (!limits.durationMin || value >= limits.durationMin) && (!limits.durationMax || value <= limits.durationMax)
}

function modelValue(profile, key, defaults) {
  if (!profile?.parameters?.includes(key)) return undefined
  const limits = profile.limits ?? {}
  return [profile.defaults?.[key], defaults?.[key]].find(value => {
    if (value == null || value === '' || value === 0) return false
    if (key === 'duration') return durationAllowed(profile, value)
    if (key === 'resolution') return !limits.resolutions?.length ||
      limits.resolutions.some(item => item.toLowerCase() === String(value).toLowerCase())
    if (key === 'aspectRatio') return !limits.aspectRatios?.length || limits.aspectRatios.includes(value)
    return true
  })
}

function inheritsFirstFrameRatio(profile, mode) {
  return profile?.provider === 'minimax-h3' && mode === 'i2v'
}

function paramSummary(profile, generationDefaults, overrides, mode) {
  const duration = overrides?.duration ?? modelValue(profile, 'duration', generationDefaults) ?? profile?.duration
  const audio = overrides?.generateAudio ?? modelValue(profile, 'generateAudio', generationDefaults)
  return [
    overrides?.resolution ?? modelValue(profile, 'resolution', generationDefaults),
    inheritsFirstFrameRatio(profile, mode) ? '继承首帧画幅' :
      overrides?.aspectRatio ?? modelValue(profile, 'aspectRatio', generationDefaults) ?? profile?.aspectRatio,
    duration === -1 ? '自动时长' : duration > 0 ? duration + ' 秒' : '',
    audio == null ? '' : audio ? '生成音频' : '关闭音频生成',
  ].filter(Boolean)
}

function GenerateControl({ node, profile, generationDefaults, actions, unavailable, latest }) {
  const mode = node.type === 'image' ? 't2i' : videoMode(node)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  if (!actions.submitGeneration || !['image', 'video'].includes(node.type) || mode === 'asset') return null
  async function submit() {
    if (!profile?.configured || busy || unavailable) return
    setBusy(true)
    setError('')
    try {
      await actions.submitGeneration(node, profile.id)
      setConfirming(false)
    } catch (failure) {
      setError(failure.message)
    } finally {
      setBusy(false)
    }
  }

  return <>
    <Button size="sm" variant="primary" className="drama-node-generate" icon={<IconSparkleRegular size={14} />}
      disabled={Boolean(unavailable)} title={unavailable}
      onClick={() => { setError(''); setConfirming(true) }}>{latest ? '重新生成…' : '生成…'}</Button>
    {confirming && <Modal open title="确认生成" closeLabel="关闭生成确认"
      onClose={() => { if (!busy) setConfirming(false) }} footer={<>
        <Button size="sm" disabled={busy} onClick={() => setConfirming(false)}>取消</Button>
        <Button size="sm" variant="primary" disabled={busy || !profile?.configured || Boolean(unavailable)} onClick={submit}>
          {busy ? '正在提交' : '确认提交'}
        </Button>
      </>}>
      {profile && <p className="drama-node-dialog-summary">{[profile.name, profile.model,
        ...paramSummary(profile, generationDefaults, node.content.params, mode)].join(' · ')}</p>}
      {error && <p className="drama-node-form-error" role="alert">{error}</p>}
    </Modal>}
  </>
}

function FileAction({ label, accept, onFile, disabled = false }) {
  const input = useRef(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!onFile) return null
  return <>
    <input type="file" accept={accept} aria-label={label + '文件'} hidden ref={input}
      onChange={async event => {
        event.stopPropagation()
        const file = event.target.files?.[0]
        event.target.value = ''
        if (!file || disabled || busy) return
        setBusy(true)
        setError('')
        try { await onFile(file) }
        catch (failure) { setError(failure.message) }
        finally { setBusy(false) }
      }} />
    <Button size="sm" disabled={disabled || busy} onClick={() => input.current?.click()}>
      {busy ? '正在上传' : label}
    </Button>
    {error && <p className="drama-node-form-error" role="alert">{error}</p>}
  </>
}

function EmptyMedia({ node, draft, actions, hasSource, pending }) {
  const kind = nodeLabels[node.type]
  const canUpload = !node.id.startsWith('draft-')
  const disabled = Boolean(actions.mutationReason)
  return <div className={'drama-node-media-placeholder drama-node-media-empty ' + interactions}>
    <NodeIcon type={node.type} size={27} />
    <span>{hasSource ? '素材地址不可用' : pending ? '等待上游素材' : '暂无' + kind}</span>
    <div className="drama-node-empty-actions">
      {canUpload && <>
        <FileAction label={'上传' + kind} accept={node.type + '/*'} disabled={disabled}
          onFile={actions.upload && (file => actions.upload(node, file))} />
        {actions.chooseAsset && <Button size="sm" disabled={disabled}
          onClick={() => actions.chooseAsset(node)}>选择项目素材</Button>}
      </>}
      {!draft && actions.edit && (node.type === 'image' || videoMode(node) !== 'asset') &&
        <Button size="sm" variant="ghost" onClick={() => actions.edit(node)}>设置生成</Button>}
    </div>
  </div>
}

function QuickAction({ label, disabled, onClick, children }) {
  if (!onClick) return null
  return <Tooltip label={label} portal>
    <span><Button size="sm" variant="toolbar" aria-label={label} disabled={disabled} onClick={onClick}>
      {children}
    </Button></span>
  </Tooltip>
}

function referenceReady(item, resolvedMedia) {
  return Boolean(item && !item.deleted && (textTypes.has(item.type)
    ? savedText(item) : isMedia(resolvedMedia?.get(item.id) ?? item)))
}

export function GraphNode({ data, selected }) {
  const { node, draft, editor, compact, mediaURL, index, edges, tasks = [], generationProfiles = [],
    generationDefaults, resolvedMedia, rename, referenceFocus, selectedResult, isFocused, actions = {} } = data
  const compactEditor = draft?.edit && (node.type === 'image' || node.type === 'video')
  const panelRef = useNodeEditorPlacement(node.id, Boolean(compactEditor && editor), Boolean(isFocused))
  const latest = tasks[0]
  const mode = videoMode(node)
  const mediaKind = mediaTypes.has(node.type)
  const result = resolvedMedia?.get(node.id)
  const displayed = isMedia(node) ? node : result
  const url = displayed && mediaURL?.(displayed)
  const candidate = Boolean(node.content.providerTaskId || tasks.some(task => task.resultNodeId === node.id))
  const title = draft && !draft.edit ? (nodeTitle(node) || '新建' + nodeLabels[node.type]) : nodeName(node)
  const mainText = savedText(node)
  const preview = () => displayed && actions.preview?.(displayed)
  const source = node.basedOn && index?.get(node.basedOn)
  const saved = !node.id.startsWith('draft-')
  const locked = Boolean(actions.mutationReason)
  const generationNode = node.type === 'image' || node.type === 'video' && mode !== 'asset'
  const ordered = referenceIds(node)
  const pending = generationNode && ordered.some(id => !referenceReady(index?.get(id), resolvedMedia))
  const configured = Boolean(textValue(node.content, 'prompt')) ||
    node.type === 'image' && ordered.some(id => textTypes.has(index?.get(id)?.type))
  return <article className={'drama-node-card' + (selected ? ' is-selected' : '') + (draft && !draft.edit ? ' is-draft' : '')
    + (compact && saved ? ' is-compact' : '')}
    data-node-kind={node.type} data-drama-node-id={node.id}
    data-drama-draft={draft && !draft.edit ? 'true' : undefined}
    data-drama-editing={draft?.edit ? 'true' : undefined}>
    {saved && <Handle className="drama-port drama-port-input" type="target" id="in" position={Position.Left}
      isConnectable={!node.deleted && mode !== 'asset' && !locked}
      aria-label={generationNode ? '生成参考输入' : '节点引用输入'} />}
    {saved && <Handle className="drama-lineage-port" type="target" id="lineage" position={Position.Left}
      isConnectable={false} aria-hidden="true" />}
    <header className="drama-node-titlebar">
      <span className="drama-node-type-icon" title={nodeLabels[node.type]}><NodeIcon type={node.type} /></span>
      <div className="drama-node-heading">
        <strong title={title}>{title}</strong>
        <span className="drama-node-caption" title={fieldLabel(node)}>{mode ? modeLabels[mode] : nodeLabels[node.type]}
          {fieldLabel(node) && ' · ' + fieldLabel(node)}</span>
      </div>
      {node.deleted ? <Tag tone="neutral">已删除</Tag>
        : latest ? <TaskStatus status={latest.status} phase={latest.phase} taskId={latest.id} />
        : mediaKind && <Tag tone={pending ? 'warning' : 'neutral'}>
          {pending ? '等待素材' : url ? '已完成' : configured
            ? (node.type === 'video' && !mode ? '待选方式' : '待生成') : '空节点'}
        </Tag>}
    </header>
    {compact && saved ? <div className="drama-node-compact-content">
      {node.type === 'image' && url && <img src={url} alt="" loading="lazy" decoding="async" />}
      <span>{mainText || (url ? nodeLabels[node.type] + '素材' : configured ? '待生成' : '暂无正文')}</span>
    </div> : <div className="drama-node-body">
      {mediaKind ? url ? <SourceMedia key={url} node={displayed} url={url} openPreview={preview} selected={selected} />
        : <EmptyMedia node={node} draft={draft} actions={actions} hasSource={isMedia(node)} pending={pending} />
        : <>
          <ReadableText text={mainText} />
          {!mainText && <span className="drama-node-caption">暂无正文</span>}
          {saved && <NodeReferences node={node} index={index} edges={edges} actions={actions} />}
        </>}
      {candidate && <div className={'drama-node-candidate ' + interactions}>
        <Tag tone={selectedResult ? 'info' : 'neutral'}>{selectedResult ? '已选定' : '候选结果'}</Tag>
        {actions.selectResult && !selectedResult &&
          <Button size="sm" onClick={() => actions.selectResult(node)}>选定此结果</Button>}
        {source && textValue(source.content, 'prompt') && actions.revise &&
          <Button size="sm" onClick={() => actions.revise(source)}>从来源重抽</Button>}
      </div>}
    </div>}
    {saved && <Handle className="drama-port drama-port-output" data-port-kind={mediaKind ? node.type : 'reference'}
      type="source" id="out" position={Position.Right} isConnectable={!node.deleted}
      aria-label={nodeLabels[node.type] + '输出'} />}
    {saved && !node.deleted && <div className={'drama-node-floating-tools ' + interactions}>
      <QuickAction label="派生版本" onClick={actions.revise && (() => actions.revise(node))}>
        <IconBranchOutlineRegular size={15} />
      </QuickAction>
      <QuickAction label="复制节点 · Ctrl+D" onClick={actions.duplicate && (() => actions.duplicate(node))}>
        <IconCopyOutlineRegular size={15} />
      </QuickAction>
      <QuickAction label="重命名" disabled={locked} onClick={(actions.rename ?? actions.edit) && (() => (actions.rename ?? actions.edit)(node))}>
        <IconEditOutlineRegular size={15} />
      </QuickAction>
      <QuickAction label="删除节点 · Delete" disabled={locked} onClick={actions.delete && (() => actions.delete(node))}>
        <IconTrashOutlineRegular size={15} />
      </QuickAction>
      <QuickAction label="新增后继节点" onClick={actions.addAfter && (event =>
        actions.addAfter(node, event.currentTarget.getBoundingClientRect()))}>
        <IconPlusOutlineRegular size={15} />
      </QuickAction>
    </div>}
    {draft && editor && <div ref={panelRef}
      className={'drama-node-editor-panel' + (compactEditor ? ' is-creative' : '')}>
      <NodeEditor draft={draft} {...editor} node={node} index={index} resolvedMedia={resolvedMedia} rename={rename} referenceFocus={referenceFocus}
        mediaURL={mediaURL} generationProfiles={generationProfiles} generationDefaults={generationDefaults}
        actions={actions} latest={latest} isFocused={isFocused} />
    </div>}
  </article>
}

const channelFields = new Set([
  'apikey', 'apitoken', 'authorization', 'credentials', 'baseurl', 'apiurl', 'protocol', 'headers',
  'authheader', 'auth', 'requestmapping', 'taskplugin', 'advanced', 'submiturl', 'queryurl',
])

function referenceIssue(mode, kinds, profile, ready = false) {
  if (mode === 't2v' && kinds.length) return '文生视频只需要完整提示词，请移除素材。'
  if (mode === 'i2v' && (ready && !kinds.length || kinds.length > 2 || kinds.some(kind => kind !== 'image'))) {
    return '图生视频需要一张首帧图片，可选一张模型支持的尾帧图片。'
  }
  if (mode === 'i2v' && kinds.length === 2 && profile && !profile.limits?.lastFrame) return '所选模型不支持尾帧。'
  if (mode === 'v2v' && (ready && !kinds.length || kinds.length > 1 || kinds.some(kind => kind !== 'video'))) return '视频转视频需要一个源视频。'
  if (mode === 'r2v' && ready && !kinds.length) return '参考生视频需要至少一个参考素材。'
  if (mode === 'r2v' && profile) {
    const max = profile.limits?.maxReferences
    if (max && kinds.length > max) return '所选模型最多支持 ' + max + ' 个参考素材。'
    for (const kind of mediaTypes) {
      const limit = referenceLimit(mode, kind, profile)
      if (kinds.filter(value => value === kind).length > limit) {
        return '所选模型最多支持 ' + limit + ' 个' + nodeLabels[kind] + '参考素材。'
      }
    }
  }
  if (mode === 't2i') {
    const count = kinds.filter(kind => kind === 'image').length
    const max = referenceLimit(mode, 'image', profile)
    if (count > max) return max ? '所选模型最多支持 ' + max + ' 张参考图片。' : '所选模型不接收参考图片。'
  }
  return ''
}

function inlineReferenceIssue(prompt, kinds) {
  const names = { 图片: 'image', 视频: 'video', 音频: 'audio' }
  const mentions = prompt.matchAll(/@(图片|视频|音频|文本|脚本|提示词|说明|image|video|audio|text|script|prompt|note)[ 	]*([0-9]+)|<<<(image|video|audio|text|script|prompt|note)_([0-9]+)>>>/giu)
  for (const [mention, name, ordinal, alias, aliasOrdinal] of mentions) {
    const label = (name ?? alias).toLowerCase()
    const kind = names[label] ?? label
    const index = Number(ordinal ?? aliasOrdinal)
    if (index < 1 || kinds.filter(value => value === kind).length < index) return mention + ' 没有对应的已连接素材。'
  }
  return ''
}

function generationParameters(value, profile, generationDefaults, mode) {
  const choices = { duration: profile?.limits?.durations, resolution: profile?.limits?.resolutions,
    aspectRatio: profile?.limits?.aspectRatios, generateAudio: ['true', 'false'] }
  return Object.entries(generationFields).flatMap(([key, label]) => {
    const selected = value[key] ?? ''
    if (!profile?.parameters?.includes(key)) return []
    const fixed = key === 'aspectRatio' && inheritsFirstFrameRatio(profile, mode)
    const inherited = modelValue(profile, key, generationDefaults)
    const format = entry => key === 'generateAudio' ? (String(entry) === 'true' ? '音频开' : '音频关') :
      key === 'duration' ? (String(entry) === '-1' ? '自动时长' : entry + ' 秒') : String(entry)
    const placeholder = inherited == null ? '模型默认' : '默认 · ' + format(inherited)
    const effective = selected || inherited
    const summary = fixed ? '继承首帧画幅' : effective == null || effective === ''
      ? label + ' · 默认' : format(effective)
    const numeric = key === 'duration'
    const durationStops = numeric ? [...new Set((choices.duration ?? []).filter(item => durationAllowed(profile, item)))]
      .sort((a, b) => a - b) : []
    const options = (numeric ? durationStops : choices[key] ?? []).map(item => ({ id: String(item), label: format(item) }))
    if (selected && options.length && !options.some(item => item.id === selected)) {
      options.push({ id: selected, label: format(selected) })
    }
    return [{ key, label, selected, inherited, placeholder, summary, fixed, numeric, options, durationStops,
      hasDurationStops: numeric && Boolean(choices.duration?.length),
      acceptDuration: numeric ? value => durationAllowed(profile, value) : undefined,
      min: numeric ? profile.limits?.durationMin || (['ark', 'byteplus'].includes(profile.provider) ? -1 : 1) : undefined,
      max: numeric ? profile.limits?.durationMax || 3600 : undefined }]
  })
}

function GenerationParams({ value, update, profile, generationDefaults, mode }) {
  return generationParameters(value, profile, generationDefaults, mode).filter(param => !param.fixed).map(param =>
    param.numeric ? <div key={param.key} className="drama-node-field"><span>{param.label}</span>
      <DurationControl param={param} update={next => update(param.key, next)} />
    </div> : param.options.length ? <MenuSelect key={param.key} label={param.label} value={param.selected}
      items={[{ id: '', label: param.placeholder }, ...param.options]} onChange={next => update(param.key, next)} />
      : <label key={param.key} className="drama-node-field">{param.label}
        <Input value={param.selected} placeholder={param.placeholder}
          onChange={event => update(param.key, event.target.value)} />
      </label>)
}

function NodeEditor({
  draft, append, mutate, mutationReason, media = [], queryCanvas, finish, close, mediaURL, index,
  generationProfiles, generationDefaults, node, actions, latest, resolvedMedia, rename, referenceFocus, uploadReference,
  importFile, attachAsset, reportSaveError, isFocused,
}) {
  const { base, preset, seed, duplicate, edit, group } = draft
  const type = node.type
  const compact = edit && (type === 'image' || type === 'video')
  const sameKind = base?.type === type
  const content = sameKind ? base.content : {}
  const savedMode = preset?.mode ?? (sameKind && type === 'video' ? videoMode(base) : 't2v')
  const [mode, setMode] = useState(savedMode)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [changeVersion, setChangeVersion] = useState(0)
  const promptField = type === 'prompt'
    ? ['text', 'description', 'prompt'].find(field => textValue(content, field)) ?? 'prompt'
    : 'prompt'
  const storedPrompt = textValue(content, promptField)
  const storedProfileId = textValue(content, 'profileId')
  const [prompt, setPrompt] = useState(storedPrompt)
  const [profileId, setProfileId] = useState(storedProfileId)
  const [overrides, setOverrides] = useState(() => parameterValues(content))
  const [metadata, setMetadata] = useState(() => nodeMetadata(base))
  const [settings, setSettings] = useState('')
  const [promptOpen, setPromptOpen] = useState(false)
  const [openParameter, setOpenParameter] = useState('')
  const promptInput = useRef(null)
  const promptExpand = useRef(null)
  const promptScroll = useRef(0)
  const composingPrompt = useRef(false)
  const generation = type === 'image' || type === 'video' && mode !== 'asset'
  const hasPrompt = type === 'prompt' || generation
  const assetNode = mediaTypes.has(type) && !(type === 'video' && generation)
  const [asset, setAsset] = useState(null)
  const supportsRefs = generation || type === 'shot'
  const persistedRefs = sameKind ? referenceIds(base) : []
  const persistedRefKey = persistedRefs.join(',')
  const previous = useRef({ mode: savedMode, ids: persistedRefs })
  const seedMode = type === 'image' ? 't2i' : type === 'video' ? mode : ''
  const seeded = seed && supportsRefs && referenceLimit(seedMode, seed.type) > 0
  const [references, setReferences] = useState(() => [...new Set([...persistedRefs,
    ...(seeded && !edit ? [seed.id] : []),
  ])])
  const [extraMedia, setExtraMedia] = useState(() => seed ? [seed] : [])
  const available = new Map([...extraMedia, ...media, ...(index?.values() ?? [])]
    .filter(item => item.id !== node.id).map(item => [item.id, item]))
  const missing = references.filter(id => !available.has(id)).join(',')
  const titleInput = useRef(null)
  const referenceArea = useRef(null)
  const formRef = useRef(null)
  const revision = useRef(base?.revision)
  const committed = useRef(base)
  const mounted = useRef(false)
  const queue = useRef({ pending: null, saving: false, savedVersion: 0, timer: 0, error: '' })

  function markDirty() {
    setDirty(true)
    if (compact) setChangeVersion(version => version + 1)
  }

  useEffect(() => {
    if (!edit) return
    if (compact && (dirty || base.revision < revision.current)) return
    const old = previous.current
    const incoming = persistedRefKey ? persistedRefKey.split(',') : []
    setReferences(current => {
      if (current.join(',') === old.ids.join(',')) return incoming
      return [...new Set([...current.filter(id => !old.ids.includes(id) || incoming.includes(id)),
        ...incoming.filter(id => !old.ids.includes(id))])]
    })
    setMode(current => current === old.mode ? savedMode : current)
    previous.current = { mode: savedMode, ids: incoming }
  }, [persistedRefKey, savedMode, edit, compact, compact && dirty, compact && base?.revision])

  useEffect(() => {
    if (!edit || dirty || base.revision < revision.current) return
    revision.current = base.revision
    committed.current = base
    setPrompt(storedPrompt)
    setProfileId(storedProfileId)
    setOverrides(parameterValues(content))
    setAsset(null)
    if (compact) setMetadata(nodeMetadata(base))
    formRef.current?.reset()
  }, [base?.revision, dirty, edit])

  useEffect(() => {
    if (!queryCanvas || !missing) return
    const request = new AbortController()
    Promise.all(missing.split(',').map(id => queryCanvas({ id, limit: 1 }, request.signal))).then(results => {
      if (!request.signal.aborted) setExtraMedia(current => [...current, ...results.flatMap(result => result.nodes)])
    }).catch(failure => {
      if (!request.signal.aborted) setError(failure.message)
    })
    return () => request.abort()
  }, [missing, queryCanvas])

  useEffect(() => {
    if (compact) {
      if (rename) setSettings('metadata')
      return
    }
    if (edit && !rename) return
    let frame
    let attempts = 0
    function focusName() {
      const input = titleInput.current
      if (!input) return
      if (!edit && input.form?.contains(document.activeElement)) return
      const details = input.closest('details')
      if (details) details.open = true
      if (getComputedStyle(input).visibility === 'visible' && input.getClientRects().length) {
        input.focus({ preventScroll: true })
        if (document.activeElement === input) {
          if (edit) {
            input.select()
            const fields = input.closest('.drama-node-editor-fields')
            if (fields) fields.scrollTop += Math.max(0, input.getBoundingClientRect().bottom -
              fields.getBoundingClientRect().bottom + 8)
          }
          return
        }
      }
      if (++attempts < 30) frame = requestAnimationFrame(focusName)
    }
    frame = requestAnimationFrame(focusName)
    return () => cancelAnimationFrame(frame)
  }, [rename, edit, compact])

  useEffect(() => {
    if (!referenceFocus) return
    const frame = requestAnimationFrame(() => {
      const area = referenceArea.current
      const button = area?.querySelector('.drama-node-reference-add:not([disabled])') ??
        area?.querySelector('button:not([disabled])')
      if (!area || !button) return
      button.focus({ preventScroll: true })
      const fields = area.closest('.drama-node-editor-fields')
      if (fields) fields.scrollTop += Math.max(0, button.getBoundingClientRect().bottom -
        fields.getBoundingClientRect().bottom + 8)
    })
    return () => cancelAnimationFrame(frame)
  }, [referenceFocus])

  const textField = textValue(content, 'text') || ('text' in content && !('description' in content)) ? 'text' : 'description'
  const referenceMode = type === 'image' ? 't2i' : type === 'video' ? mode : ''
  const currentProfiles = profileCandidates(generationProfiles, referenceMode)
  const activeProfile = resolveProfile(currentProfiles, profileId)
  const parameters = generationParameters(overrides, activeProfile, generationDefaults, mode)
  const formLabel = edit ? '编辑节点' : duplicate ? '复制为新节点' : base ? '另存为新版本' : '新建节点'
  const choices = [{ id: '', label: '使用默认预设' },
    ...(profileId && !currentProfiles.some(item => item.id === profileId) ? [{ id: profileId, label: '原预设不可用' }] : []),
    ...currentProfiles.map(item => ({ id: item.id, label: item.name, title: item.model, disabled: item.configured === false }))]
  const referenceItems = references.map(id => available.get(id))
  const referenceKinds = referenceItems.map(item => item?.type)
  const hasTextRef = type === 'image' && referenceItems.some(item => textTypes.has(item?.type) && savedText(item))
  const issue = referenceIssue(referenceMode, referenceKinds, activeProfile, true)
    || (type === 'video' ? inlineReferenceIssue(prompt, referenceKinds) : '')
  const savedProfile = compact ? activeProfile : resolveProfile(currentProfiles, storedProfileId)
  const unavailable = mutationReason || [
    taskActive(latest ?? {}) && '此节点正在生成。',
    saving && '正在保存修改。',
    dirty && (compact ? error || '正在保存修改。' : '请先保存修改。'),
    type === 'video' && !mode && '请选择视频生成方式。',
    !prompt.trim() && !hasTextRef && (type === 'video' ? '生成前请填写完整视频提示词。' : '请填写提示词。'),
    referenceItems.some(item => !referenceReady(item, resolvedMedia)) && '等待上游素材。',
    issue,
    !savedProfile?.configured && '请选择已配置的生成预设。',
  ].find(Boolean)
  const blocked = Boolean(edit && mutationReason)

  function changeMode(value) {
    if (compact) {
      const issue = value === 'asset'
        ? (references.length || prompt.trim() ? '切换到素材前，请清空提示词并移除参考素材。' : '')
        : referenceIssue(value, referenceKinds)
      if (issue) { setError(issue); return }
    }
    setMode(value)
    setProfileId('')
    setOverrides({})
    markDirty()
    setError('')
  }

  function changeReferences(ids) {
    setReferences(ids)
    markDirty()
  }

  function attachReference(item) {
    setExtraMedia(current => [...current, item])
    setReferences(current => [...new Set([...current, item.id])])
    markDirty()
  }

  function updatePrompt(value) {
    setPrompt(value)
    markDirty()
  }

  function setAssetSource(item) {
    setAsset(item)
    setDirty(true)
    if (titleInput.current && !titleInput.current.value) titleInput.current.value = item.title ?? ''
  }

  function buildEdit(form) {
    const next = { ...content }
    const description = String(form.get('description') ?? '').trim()
    if (form.has('description')) next[textField] = description
    if (compact && !hasPrompt) next[textField] = metadata.description
    const title = String(compact ? metadata.title : form.get('title') ?? '').trim()
    if (title) next.title = title
    else delete next.title
    if (hasPrompt) next[promptField] = prompt
    if (assetNode && (compact || asset || form.has('path') || form.has('url'))) {
      for (const field of ['path', 'url']) {
        const value = compact ? metadata[field].trim() : asset ? asset[field] : String(form.get(field) ?? '').trim()
        if (value) next[field] = value
        else delete next[field]
      }
    }
    const ordered = supportsRefs ? references : []
    if (generation) {
      const structuralIssue = referenceIssue(referenceMode, referenceKinds, activeProfile)
      if (structuralIssue) throw new Error(structuralIssue)
      const params = Object.fromEntries(Object.entries(overrides).filter(([key, value]) =>
        value.trim() && activeProfile?.parameters?.includes(key) &&
        (key !== 'aspectRatio' || !inheritsFirstFrameRatio(activeProfile, mode))).map(([key, value]) =>
        [key, key === 'duration' ? Number(value) : key === 'generateAudio' ? value === 'true' : value.trim()]))
      if (activeProfile?.parameters || mode !== savedMode || profileId !== storedProfileId) {
        if (Object.keys(params).length) next.params = params
        else delete next.params
      }
      if (profileId) next.profileId = profileId
      else delete next.profileId
      next.mixedListOrder = ordered
      if (type === 'video') {
        next.mode = mode
        delete next.textList
      }
    } else if (type === 'video') {
      if (compact) next.mode = 'asset'
      else delete next.mode
      for (const key of ['profileId', 'params', 'prompt', 'textList', 'mixedListOrder']) delete next[key]
    } else if (type === 'shot') {
      if (ordered.length) next.mixedListOrder = ordered
      else delete next.mixedListOrder
    }
    if (type === 'video') {
      for (const key of Object.keys(next)) if (channelFields.has(key.toLowerCase().replace(/[_-]/gu, ''))) delete next[key]
    }
    if (!edit && mediaTypes.has(type)) delete next.providerTaskId
    const fields = Object.fromEntries(groupFields.map(([field]) => [field,
      String(compact ? metadata[field] : form.get(field) ?? '').trim()]))
    return { content: next, fields, ordered }
  }

  async function save(event) {
    event.preventDefault()
    if (saving || blocked || compact) return
    const form = new FormData(event.currentTarget)
    setSaving(true)
    setError('')
    try {
      const { content: next, fields, ordered } = buildEdit(form)
      const id = edit ? base.id : crypto.randomUUID()
      if (edit) {
        const result = await mutate('update_node', { id, revision: revision.current, ...fields, content: next,
          referenceSources: supportsRefs || type === 'video' ? ordered : undefined })
        revision.current = result.revision
      } else {
        const edges = new Set(ordered)
        if (!supportsRefs && textTypes.has(type) && seed?.id && seed.id !== base?.id) edges.add(seed.id)
        await append({ nodes: [{ id, type, basedOn: base?.id, content: next, ...fields }],
          edges: [...edges].map(source => ({ source, target: id })) })
      }
      setDirty(false)
      finish(id)
    } catch (failure) {
      setError(failure.message)
    } finally {
      setSaving(false)
    }
  }

  // Keep one in-flight update and coalesce typing into the latest pending edit.
  // The pending payload lives past deselection so a final keystroke is committed.
  async function flushAutosave() {
    const state = queue.current
    clearTimeout(state.timer)
    if (state.saving || !state.pending) return
    const { payload, version, send } = state.pending
    state.pending = null
    state.saving = true
    state.error = ''
    if (mounted.current) setSaving(true)
    try {
      const result = await send('update_node', { ...payload, revision: revision.current }, committed.current)
      revision.current = result.revision
      committed.current = { ...committed.current, ...payload, revision: result.revision }
      state.savedVersion = version
      if (mounted.current && !state.pending && !state.error) {
        setDirty(false)
        setError('')
      }
    } catch (failure) {
      if (failure.cause?.status === 409) state.pending = null
      state.error ||= failure.message
      if (mounted.current) setError(state.error)
      else reportSaveError?.(state.error)
    } finally {
      state.saving = false
      if (mounted.current) setSaving(false)
      if (state.pending) void flushAutosave()
    }
  }

  useLayoutEffect(() => {
    if (!compact) return
    mounted.current = true
    return () => {
      mounted.current = false
      if (queue.current.error) reportSaveError?.(queue.current.error)
      void flushAutosave()
    }
  }, [compact])

  useLayoutEffect(() => {
    if (!compact || !changeVersion || changeVersion <= queue.current.savedVersion) return
    const state = queue.current
    clearTimeout(state.timer)
    state.pending = null
    if (blocked) {
      state.error = mutationReason
      return
    }
    try {
      const { content, fields, ordered } = buildEdit(new FormData())
      const payload = { id: base.id, ...fields, content, referenceSources: ordered }
      state.pending = { payload, version: changeVersion, send: mutate }
      state.timer = setTimeout(flushAutosave, 360)
      state.error = ''
      setError('')
    } catch (failure) {
      state.error = failure.message
      setError(failure.message)
    }
  }, [compact, changeVersion, blocked])

  function changeProfile(id) {
    const profile = resolveProfile(currentProfiles, id)
    const issue = compact && referenceIssue(referenceMode, referenceKinds, profile)
    if (issue) { setError(issue); return }
    setProfileId(id)
    setOverrides(current => Object.fromEntries(Object.entries(current)
      .filter(([key]) => profile?.parameters?.includes(key))))
    markDirty()
  }

  function updateParam(key, value) {
    setOverrides(current => ({ ...current, [key]: value }))
    markDirty()
  }

  function updateMetadata(key, value) {
    setMetadata(current => ({ ...current, [key]: value }))
    markDirty()
  }

  function closePrompt() {
    if (composingPrompt.current) return
    setPromptOpen(false)
    void flushAutosave()
    requestAnimationFrame(() => {
      promptExpand.current?.focus({ preventScroll: true })
      if (promptInput.current) promptInput.current.scrollTop = promptScroll.current
    })
  }

  const promptEvents = {
    onCompositionStart: () => { composingPrompt.current = true },
    onCompositionEnd: event => {
      composingPrompt.current = false
      updatePrompt(event.currentTarget.value)
    },
    onChange: event => composingPrompt.current ? setPrompt(event.target.value) : updatePrompt(event.target.value),
  }

  const effectiveNode = node.revision >= revision.current ? node : committed.current
  if (compact) {
    const modeItems = Object.entries(modeLabels).map(([id, label]) => ({
      id, label: id === 'asset' ? '素材' : id.toUpperCase(), title: label,
      disabled: id === 'asset' && (references.length > 0 || Boolean(prompt.trim())),
    }))
    const shownError = error || (blocked ? mutationReason : '')
    return <form className={'drama-node-editor drama-node-creative ' + interactions} aria-label={formLabel}
      onSubmit={event => event.preventDefault()} onDoubleClick={preventCanvasDoubleClick}
      onKeyDown={event => {
        if (!event.currentTarget.contains(event.target)) return
        if (event.key === 'Escape' && !settings && !promptOpen && !openParameter &&
            !composingPrompt.current && !event.nativeEvent.isComposing && event.keyCode !== 229) {
          if (isFocused) return
          close()
        }
        stopCanvasKeys(event)
      }}>
      {generation && <>
        <div className="drama-node-creative-prompt">
          <textarea ref={promptInput} aria-label="提示词" name="prompt" rows={3}
            placeholder={type === 'video' ? '描述镜头、动作与声音…' : '描述要生成的画面…'} value={prompt} disabled={blocked}
            {...promptEvents} />
          <Button ref={promptExpand} size="sm" className="drama-node-prompt-expand" aria-haspopup="dialog" aria-expanded={promptOpen}
            aria-label="展开提示词" title="展开提示词" onClick={() => {
              promptScroll.current = promptInput.current?.scrollTop ?? 0
              setOpenParameter('')
              setPromptOpen(true)
            }}>
            <IconFullscreenOutlineRegular size={14} />
          </Button>
        </div>
        <div className="drama-node-creative-controls">
          {type === 'video'
            ? <MenuSelect compact label="视频方式" value={mode} items={modeItems} placeholder="选择方式"
              onChange={changeMode} disabled={blocked} />
            : <span className="drama-node-creative-mode" title="图片生成">T2I</span>}
          <MenuSelect compact label="生成预设" value={profileId} disabled={blocked || type === 'video' && !mode}
            items={profileId ? choices : [{ id: '', label: activeProfile ? '默认 · ' + activeProfile.name : '选择模型',
              title: activeProfile?.model }, ...choices.slice(1)]}
            onChange={changeProfile} />
          <Button size="sm" className="drama-node-creative-settings" aria-label="节点详情" aria-haspopup="dialog"
            title="节点详情" icon={<IconSlidersTwoOutlineRegular size={15} />}
            onClick={() => setSettings('metadata')} />
        </div>
        {parameters.length > 0 && <div className="drama-node-parameter-chips" role="group" aria-label="有效生成参数">
          {parameters.map(param => param.fixed
            ? <span className="drama-focus-param-chip is-fixed" key={param.key} title={param.label}>{param.summary}</span>
            : <NodeParameterPopover key={param.key} label={param.label} value={param.summary} disabled={blocked}
              open={openParameter === param.key} onToggle={() => setOpenParameter(current => current === param.key ? '' : param.key)}
              onClose={() => setOpenParameter(current => current === param.key ? '' : current)}>
              {param.numeric ? <DurationControl param={param} update={next => updateParam(param.key, next)} />
                : param.options.length ? <div className="drama-param-options" role="group" aria-label={param.label}>
                  {[{ id: '', label: param.placeholder }, ...param.options].map(option =>
                    <Button key={option.id} size="sm" variant={option.id === param.selected ? 'primary' : 'outline'}
                      aria-pressed={option.id === param.selected} onClick={() => updateParam(param.key, option.id)}>
                      {option.label}
                    </Button>)}
                </div> : <Input aria-label={param.label} value={param.selected} placeholder={param.placeholder}
                  onChange={event => updateParam(param.key, event.target.value)} />}
            </NodeParameterPopover>)}
        </div>}
        <div ref={referenceArea}>
          {(!mode || mode === 't2v') && type === 'video' ? <ReferenceModeMenu disabled={blocked} choose={changeMode} />
            : <MediaReferences compact mode={referenceMode} profile={activeProfile} media={available} mediaURL={mediaURL}
              resolvedMedia={resolvedMedia} queryCanvas={queryCanvas} nodeId={node.id} references={references}
              setReferences={changeReferences} onSelect={attachReference} uploadReference={uploadReference}
              attachAsset={attachAsset} locate={actions.locate} preview={actions.preview} disabled={blocked} />}
        </div>
        {promptOpen && <Modal open title="编辑提示词" closeLabel="关闭提示词编辑器" onClose={closePrompt}
          className="drama-node-prompt-dialog" contentClassName="drama-node-prompt-dialog-content" backdropBlur={false}
          footer={<>
            <span className="drama-node-prompt-save-status" role="status">
              {mutationReason || error || (saving || dirty ? '正在保存…' : '已保存')}
            </span>
            <Button size="sm" variant="primary" onClick={closePrompt}>完成编辑</Button>
          </>}>
          <textarea aria-label="提示词" data-modal-autofocus value={prompt} disabled={blocked}
            className={'drama-node-prompt-dialog-input ' + interactions} {...promptEvents} />
        </Modal>}
      </>}
      {!generation && <div className="drama-node-creative-controls">
        <MenuSelect compact label="视频方式" value={mode} items={modeItems} placeholder="选择方式"
          onChange={changeMode} disabled={blocked} />
        <Button size="sm" aria-haspopup="dialog" onClick={() => setSettings('metadata')}>节点详情</Button>
      </div>}
      <div className="drama-node-creative-footer">
        {(shownError || generation && (prompt.trim() || references.length > 0) && !dirty && unavailable) &&
          <p className="drama-node-creative-status" role={error ? 'alert' : 'status'}>{shownError || unavailable}</p>}
        {generation && <GenerateControl node={effectiveNode} profile={savedProfile} generationDefaults={generationDefaults}
          actions={actions} unavailable={unavailable} latest={latest} />}
      </div>
      {settings && <Modal open title="节点详情" closeLabel="关闭节点详情"
        backdropBlur={false} onClose={() => setSettings('')}>
        <fieldset className="drama-node-settings drama-node-dialog-fields" disabled={blocked}>
          <label className="drama-node-field">节点名称
            <Input data-modal-autofocus value={metadata.title} onChange={event => updateMetadata('title', event.target.value)} />
          </label>
          <div className="drama-node-group-fields">{groupFields.map(([field, label]) =>
            <label className="drama-node-field" key={field}>{label}
              <Input value={metadata[field]} onChange={event => updateMetadata(field, event.target.value)} />
            </label>)}</div>
          {assetNode && <>
            <label className="drama-node-field">项目内素材路径
              <Input value={metadata.path} onChange={event => updateMetadata('path', event.target.value)} />
            </label>
            <label className="drama-node-field">素材网址
              <Input value={metadata.url} onChange={event => updateMetadata('url', event.target.value)} />
            </label>
          </>}
          {!generation && <label className="drama-node-field">正文
            <textarea rows={3} value={metadata.description} onChange={event => updateMetadata('description', event.target.value)} />
          </label>}
          <TaskDetail task={latest} nodeId={node.id} locate={actions.locate} />
        </fieldset>
      </Modal>}
    </form>
  }

  const showReferences = supportsRefs && (type !== 'video' ||
    Boolean(referenceMode && referenceMode !== 't2v') || references.length > 0)
  return <form ref={formRef} className={'drama-node-editor ' + interactions} onSubmit={save} aria-label={formLabel}
    onChange={() => setDirty(true)} onKeyDown={event => {
      if (event.key === 'Escape' && !event.nativeEvent.isComposing && event.keyCode !== 229) {
        if (isFocused) return
        close()
      }
      stopCanvasKeys(event)
    }} onDoubleClick={preventCanvasDoubleClick}>
    <div className="drama-node-editor-fields">
      <fieldset className="drama-node-settings" disabled={blocked || saving}>
        {!edit && <label className="drama-node-field">节点名称
          <Input ref={titleInput} name="title" defaultValue={nodeTitle(base ?? { content })} placeholder={nodeLabels[type]} />
        </label>}
        {!edit && assetNode && <AssetSources type={type} queryCanvas={queryCanvas} asset={asset}
          importFile={importFile} onSelect={setAssetSource} />}
        {type === 'video' && <MenuSelect label="视频方式" value={mode} placeholder="选择方式" onChange={changeMode}
          items={Object.entries(modeLabels).map(([id, label]) => ({ id, label }))} />}
        {hasPrompt && <label className="drama-node-field">{type === 'video' ? '完整视频提示词' : '提示词'}
          <textarea name="prompt" rows={4} value={prompt} onChange={event => setPrompt(event.target.value)} />
        </label>}
        {!hasPrompt && <label className="drama-node-field">正文
          <textarea name="description" rows={3} defaultValue={content[textField] ?? ''} />
        </label>}
        {supportsRefs && <div ref={referenceArea}>
          {showReferences ? <MediaReferences mode={referenceMode} profile={activeProfile} media={available} mediaURL={mediaURL}
            resolvedMedia={resolvedMedia} queryCanvas={queryCanvas} nodeId={node.id} references={references}
            setReferences={changeReferences} onSelect={attachReference} uploadReference={uploadReference}
            attachAsset={attachAsset} locate={actions.locate} preview={actions.preview} disabled={blocked || saving} />
            : <MenuSelect label="添加参考素材" value="" placeholder="选择参考生成方式" onChange={changeMode}
              items={['i2v', 'r2v', 'v2v'].map(id => ({ id, label: modeLabels[id] }))} />}
        </div>}
        {generation && <>
          <MenuSelect label="生成预设" value={profileId} onChange={changeProfile} items={choices}
            disabled={type === 'video' && !mode} />
          {activeProfile && <span className="drama-node-caption">
            {[activeProfile.model, ...paramSummary(activeProfile, generationDefaults, undefined, mode)].join(' · ')}
          </span>}
          <div className="drama-node-parameter-fields">
            <GenerationParams value={overrides} profile={activeProfile} generationDefaults={generationDefaults} mode={mode}
              update={(key, value) => { setDirty(true); setOverrides(current => ({ ...current, [key]: value })) }} />
          </div>
        </>}
        {assetNode && <details className="drama-node-editor-optional" open={!edit && !generation ? true : undefined}>
          <summary>素材来源</summary>
          {asset ? <Button size="sm" onClick={() => { setAsset(null); setDirty(true) }}>改用路径或网址</Button> : <>
            <label className="drama-node-field">素材网址
              <Input type="url" name="url" defaultValue={content.url ?? ''} placeholder="https://" />
            </label>
            <label className="drama-node-field">项目内素材路径
              <Input name="path" defaultValue={content.path ?? ''} placeholder={assetFolders[type]} />
            </label>
          </>}
        </details>}
        <details className="drama-node-editor-optional" open={!edit ? true : undefined}>
          <summary>名称与镜头</summary>
          {edit && <label className="drama-node-field">节点名称
            <Input ref={titleInput} name="title" defaultValue={nodeTitle(base ?? { content })} placeholder={nodeLabels[type]} />
          </label>}
          <div className="drama-node-group-fields">{groupFields.map(([field, label]) =>
            <label className="drama-node-field" key={field}>{label}
              <Input name={field} defaultValue={base?.[field] ?? group?.[field] ?? ''} />
            </label>)}</div>
        </details>
      </fieldset>
      {edit && <TaskDetail task={latest} nodeId={node.id} locate={actions.locate} />}
    </div>
    {blocked && <p className="drama-node-lock-notice" role="status">{mutationReason}</p>}
    {edit && generation && !blocked && !saving && unavailable &&
      <p className="drama-node-editor-hint" role="status">{unavailable}</p>}
    {error && <p className="drama-node-form-error" role="alert">{error}</p>}
    <div className="drama-node-editor-footer">
      <Button size="sm" disabled={saving} onClick={close}>取消</Button>
      <Button size="sm" type="submit" variant={edit && !dirty ? 'outline' : 'primary'} disabled={saving || blocked}>
        {saving ? '正在保存' : edit ? '保存修改' : duplicate ? '保存副本' : base ? '保存新版本' : '创建节点'}
      </Button>
    </div>
  </form>
}

function parameterValues(content) {
  return Object.fromEntries(Object.keys(generationFields)
    .filter(key => content.params?.[key] != null).map(key => [key, String(content.params[key])]))
}

function nodeMetadata(node) {
  return {
    title: nodeTitle(node), path: node?.content.path ?? '', url: node?.content.url ?? '',
    description: node ? textValue(node.content, 'text', 'description') : '',
    ...Object.fromEntries(groupFields.map(([field]) => [field, node?.[field] ?? ''])),
  }
}

function useSourceSearch(queryCanvas, types, search, mediaOnly = false) {
  const [result, setResult] = useState({ nodes: [], error: '' })
  useEffect(() => {
    if (!queryCanvas || !types) return
    const request = new AbortController()
    const timer = setTimeout(() => {
      Promise.all(types.split(',').map(type =>
        queryCanvas({ type, q: search, mediaOnly, limit: 40 }, request.signal)))
        .then(snapshots => {
          if (!request.signal.aborted) setResult({ nodes: snapshots.flatMap(snapshot => snapshot.nodes), error: '' })
        }).catch(failure => {
          if (!request.signal.aborted) setResult({ nodes: [], error: failure.message })
        })
    }, 180)
    return () => { request.abort(); clearTimeout(timer) }
  }, [queryCanvas, types, search, mediaOnly])
  return result
}

function AssetSources({ type, queryCanvas, asset, importFile, onSelect }) {
  const [search, setSearch] = useState('')
  const { nodes, error } = useSourceSearch(queryCanvas, type, search, true)
  const assets = nodes.filter(item => item.type === type && isMedia(item))
  return <div className="drama-node-reference-picker">
    <FileAction label={'上传' + nodeLabels[type]} accept={type + '/*'}
      onFile={importFile && (async file => onSelect(await importFile(file)))} />
    {queryCanvas && <Input aria-label="搜索项目素材" placeholder="搜索项目素材" value={search}
      onChange={event => { event.stopPropagation(); setSearch(event.target.value) }} />}
    <MenuSelect label="选择项目素材" value={asset?.id ?? ''} items={assets.map(item => ({
      id: item.id, label: nodeName(item),
    }))} onChange={id => {
      const item = assets.find(asset => asset.id === id)
      if (item) onSelect({ ...item.content, id, title: nodeName(item) })
    }} />
    {asset && <span className="drama-node-caption">{asset.title || asset.path || asset.url}</span>}
    {error && <p className="drama-node-form-error" role="alert">{error}</p>}
  </div>
}

function referenceLabel(mode, references, position, known) {
  if (mode === 'i2v') return position === 0 ? '首帧' : '尾帧'
  if (mode === 'v2v') return '源视频'
  const kind = known.get(references[position])?.type
  if (mode === 't2i') return textTypes.has(kind) ? '文本参考' : '参考图片'
  if (mode === 'r2v' && mediaTypes.has(kind)) {
    const ordinal = references.slice(0, position + 1).filter(id => known.get(id)?.type === kind).length
    return '@' + nodeLabels[kind] + ordinal
  }
  return '参考 ' + (position + 1)
}

function ReferenceModeMenu({ disabled, choose }) {
  const [open, setOpen] = useState(false)
  return <div className="drama-node-reference-strip">
    <Menu open={open} portal compact onClose={() => setOpen(false)}
      items={['i2v', 'r2v', 'v2v'].map(id => ({ id, label: modeLabels[id] }))}
      onSelect={id => { choose(id); setOpen(false) }}
      anchor={<button type="button" className="drama-node-reference-add" aria-label="添加参考素材" aria-haspopup="menu"
        title="选择参考生成方式" disabled={disabled} onClick={() => setOpen(true)}>
        <IconPlusOutlineRegular size={15} /><span>参考素材</span>
      </button>} />
  </div>
}

function MediaReferences({ compact, mode, profile, media, mediaURL, resolvedMedia, queryCanvas, nodeId, references,
  setReferences, onSelect, uploadReference, attachAsset, locate, preview, disabled }) {
  const [search, setSearch] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const totalLimit = mode === 'r2v' ? profile?.limits?.maxReferences ?? 32 : 32
  const allowedKinds = [...mediaTypes, ...textTypes].filter(kind => {
    const count = references.filter(id => media.get(id)?.type === kind).length
    return references.length < totalLimit && count < referenceLimit(mode, kind, profile)
  })
  const types = allowedKinds.join(',')
  const { nodes: results, error } = useSourceSearch(queryCanvas, !compact || pickerOpen ? types : '', search)
  const known = new Map([...results.map(node => [node.id, node]), ...media])
  const q = search.trim().toLowerCase()
  const available = [...known.values()].filter(node => !node.deleted && node.id !== nodeId &&
    allowedKinds.includes(node.type) && !references.includes(node.id) &&
    (nodeName(node) + ' ' + savedText(node) + ' ' + shotLabel(node)).toLowerCase().includes(q))
  const labels = {
    i2v: [profile?.limits?.lastFrame ? '首帧与尾帧图片' : '首帧图片', '图片素材'],
    r2v: ['参考素材', '参考素材'],
    v2v: ['源视频', '视频素材'],
    t2v: ['素材输入', '媒体素材'],
    t2i: ['生成参考', '参考素材'],
    '': ['参考图片', '图片素材'],
  }
  const [legend, kindLabel] = labels[mode]
  const uploadKinds = allowedKinds.filter(kind => mediaTypes.has(kind))

  function move(index, delta) {
    const next = [...references]
    const [id] = next.splice(index, 1)
    next.splice(index + delta, 0, id)
    setReferences(next)
  }

  function select(item) {
    onSelect(item)
    setPickerOpen(false)
    setSearch('')
  }

  const picker = types && <div className="drama-node-reference-picker">
      {queryCanvas && <Input aria-label={'搜索' + kindLabel} placeholder={'搜索' + kindLabel} value={search}
        data-modal-autofocus={compact || undefined}
        onChange={event => { event.stopPropagation(); setSearch(event.target.value) }} />}
      <MenuSelect label={'添加' + kindLabel} value="" placeholder={available.length ? '选择' + kindLabel : '暂无匹配素材'}
        disabled={disabled} items={available.map(item => ({ id: item.id, label: item.type === 'image' ? nodeName(item) :
          nodeLabels[item.type] + ' · ' + nodeName(item), title: item.id }))}
        onChange={id => { if (known.has(id)) select(known.get(id)) }} />
      {uploadKinds.length > 0 && <>
        {attachAsset && <ProjectReferenceSelect types={uploadKinds.join(',')} queryCanvas={queryCanvas}
          disabled={disabled} search={search} excluded={[nodeId, ...references]} attachAsset={attachAsset} onSelect={select} />}
        <FileAction label="上传参考素材" disabled={disabled}
          accept={uploadKinds.map(kind => kind + '/*').join(',')}
          onFile={uploadReference && (async file => select(await uploadReference(file)))} />
      </>}
      {error && <p className="drama-node-form-error" role="alert">{error}</p>}
    </div>

  if (compact) {
    const slot = mode === 'i2v' ? (references.length ? '尾帧' : '首帧') : mode === 'v2v' ? '源视频' : '参考素材'
    const closePicker = () => { setPickerOpen(false); setSearch('') }
    return <>
      <div className="drama-node-reference-strip" aria-label={legend}>
        {!!references.length && <div className="drama-node-reference-track" onWheel={event => {
          const track = event.currentTarget
          if (!event.deltaX && track.scrollWidth > track.clientWidth) track.scrollLeft += event.deltaY
        }}>{references.map((id, index) => {
          const item = known.get(id)
          const asset = resolvedMedia?.get(id) ?? item
          const label = referenceLabel(mode, references, index, known)
          const title = label + ' · ' + (item ? nodeName(item) : '等待素材')
          return <ReferenceSlot key={id} id={id} item={item} asset={asset} title={title} label={label} disabled={disabled}
            index={index} count={references.length} mediaURL={mediaURL} locate={locate} preview={preview}
            move={delta => move(index, delta)} remove={() => setReferences(references.filter(ref => ref !== id))} />
        })}</div>}
        {types ? <button type="button" className="drama-node-reference-add" aria-label={'添加' + slot}
          aria-haspopup="dialog" title={'添加' + slot} disabled={disabled} onClick={() => setPickerOpen(true)}>
          <IconPlusOutlineRegular size={15} /><span>{slot}</span>
        </button> : !references.length && <span className="drama-node-caption">当前模型无可用参考槽</span>}
      </div>
      {pickerOpen && <Modal open title="添加参考素材" closeLabel="关闭参考素材选择" backdropBlur={false}
        onClose={closePicker}>{picker}</Modal>}
    </>
  }

  return <fieldset className="drama-node-editor-references">
    <legend>{legend}</legend>
    {picker}
    {!types && !references.length && mode === 'r2v' && <small>所选模型未配置可用的参考素材。</small>}
    {references.length > 0 && <ol>{references.map((id, index) => {
      const item = known.get(id)
      const asset = resolvedMedia?.get(id) ?? item
      const url = asset?.type === 'image' && isMedia(asset) ? mediaURL?.(asset) : undefined
      const ready = referenceReady(item, resolvedMedia)
      const excerpt = item && textTypes.has(item.type) && savedText(item)
      const label = referenceLabel(mode, references, index, known)
      return <li key={id}>
        {url ? <img src={url} loading="lazy" decoding="async" alt="" /> : <NodeIcon type={item?.type} size={14} />}
        <span title={excerpt || (item ? nodeName(item) : id)}>{label}
          {item && ' · ' + nodeName(item)}{!ready && (item?.deleted ? '（已删除）' : '（等待素材）')}
          {excerpt && <small>{excerpt}</small>}
        </span>
        <QuickAction label="查看参考" onClick={ready && isMedia(asset) && preview
          ? () => preview(asset) : locate && (() => locate(id))}><IconFullscreenOutlineRegular size={13} /></QuickAction>
        {references.length > 1 && <>
          <Button size="sm" aria-label={'上移参考 ' + (index + 1)} disabled={index === 0} onClick={() => move(index, -1)}>↑</Button>
          <Button size="sm" aria-label={'下移参考 ' + (index + 1)} disabled={index === references.length - 1}
            onClick={() => move(index, 1)}>↓</Button>
        </>}
        <Button size="sm" aria-label={'移除参考 ' + (index + 1)}
          onClick={() => setReferences(references.filter(ref => ref !== id))}>移除</Button>
      </li>
    })}</ol>}
  </fieldset>
}

function ReferenceSlot({ id: sourceId, item, asset, title, label, disabled, index, count, mediaURL, locate, preview, move, remove }) {
  const [menu, setMenu] = useState(false)
  const url = asset?.type === 'image' && isMedia(asset) ? mediaURL?.(asset) : undefined
  const canPreview = isMedia(asset) && preview
  return <div className="drama-node-reference-slot">
    <Menu open={menu} portal compact onClose={() => setMenu(false)}
      items={[
        { id: 'view', label: canPreview ? '查看素材' : '定位节点', disabled: !canPreview && !locate },
        ...(count > 1 ? [
          { id: 'left', label: '前移', disabled: disabled || index === 0 },
          { id: 'right', label: '后移', disabled: disabled || index === count - 1 },
        ] : []),
        { id: 'remove', label: '移除引用', disabled },
      ]} onSelect={id => {
        setMenu(false)
        if (id === 'view') canPreview ? preview(asset) : locate?.(sourceId)
        else if (id === 'remove') remove()
        else move(id === 'left' ? -1 : 1)
      }} anchor={<button type="button" className="drama-node-reference-thumb" aria-label={title}
        aria-haspopup="menu" aria-expanded={menu} title={title} onClick={() => setMenu(true)}>
        {url ? <img src={url} alt="" loading="lazy" decoding="async" /> :
          <NodeIcon type={item?.type} size={16} />}
        <span>{label}</span>
      </button>} />
    <button type="button" className="drama-node-reference-remove" aria-label={'移除参考 ' + (index + 1)}
      title="移除引用" disabled={disabled} onClick={remove}>×</button>
  </div>
}

function ProjectReferenceSelect({ types, queryCanvas, disabled, search, excluded, attachAsset, onSelect }) {
  const { nodes, error: searchError } = useSourceSearch(queryCanvas, types, search, true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const choices = nodes.filter(node => types.split(',').includes(node.type) && !excluded.includes(node.id))
  return <>
    <MenuSelect label="从项目资产添加" value="" items={choices.map(node => ({ id: node.id, label: nodeName(node) }))}
      placeholder={choices.length ? '选择项目素材' : '暂无匹配素材'} disabled={disabled || busy}
      onChange={async id => {
        const asset = choices.find(node => node.id === id)
        if (!asset || busy || disabled) return
        setBusy(true)
        setError('')
        try { onSelect(await attachAsset(asset)) }
        catch (failure) { setError(failure.message) }
        finally { setBusy(false) }
      }} />
    {(searchError || error) && <p className="drama-node-form-error" role="alert">{searchError || error}</p>}
  </>
}
