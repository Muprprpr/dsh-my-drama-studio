import React, { useEffect, useId, useRef, useState } from 'react'
import { Handle, NodeToolbar, Position } from '@xyflow/react'
import {
  Button, FileTypeIcon, IconBranchOutlineRegular, IconChevronDownOutlineRegular,
  IconCopyOutlineRegular, IconEditOutlineRegular, IconEllipsisOutlineRegular, IconFullscreenOutlineRegular,
  IconLinkOutlineRegular, IconListPenOutlineRegular, IconPlanOutlineRegular, IconPlayOutlineRegular,
  IconPlusOutlineRegular, IconSparkleRegular, IconTrashOutlineRegular, Input, Menu, Tag, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  assetFolders, groupFields, isMedia, mediaTypes, modeLabels, nodeLabels, nodeTitle,
  profileCandidates, referenceIds, referenceLimit, resolveProfile, shotLabel, videoMode,
} from './canvas-node.jsx'
import { TaskStatus } from './task-drawer.jsx'
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
  return node.type === 'prompt'
    ? textValue(node.content, 'prompt', 'description', 'text')
    : textValue(node.content, 'description', 'text')
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
  if (event.key === 'Enter' && event.target instanceof HTMLInputElement) event.preventDefault()
}

function preventCanvasDoubleClick(event) {
  event.stopPropagation()
}

function MenuSelect({ label, value, items, onChange, disabled = false, placeholder = '请选择' }) {
  const [open, setOpen] = useState(false)
  const selected = items.find(item => item.id === value)
  const id = useId()
  return <div className="drama-node-field">
    <label id={id}>{label}</label>
    <Menu open={open} portal compact autoFocus minWidthFromAnchor selectedId={value}
      onClose={() => setOpen(false)}
      onSelect={id => { onChange(id); setOpen(false) }}
      items={items}
      anchor={<Button size="sm" className="drama-node-select" aria-labelledby={id}
        aria-haspopup="menu" aria-expanded={open} disabled={disabled || items.length === 0}
        onClick={() => setOpen(current => !current)}>
        <span title={selected?.title}>{selected?.label ?? placeholder}</span>
        <IconChevronDownOutlineRegular size={14} />
      </Button>} />
  </div>
}

function SourceMedia({ node, url, openPreview }) {
  const [error, setError] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [dimensions, setDimensions] = useState('')
  const [duration, setDuration] = useState('')
  const isImage = node.type === 'image'
  const name = nodeName(node)
  const storedDimensions = Number.isFinite(node.content.width) && Number.isFinite(node.content.height)
    ? node.content.width + ' × ' + node.content.height : ''
  const storedDuration = Number.isFinite(node.content.duration) && node.content.duration > 0
    ? node.content.duration + ' 秒' : ''

  if (!url) return null
  if (node.type === 'audio') return <div className={'drama-node-media ' + interactions}>
    {error ? <span role="status">无法播放音频</span>
      : <audio controls preload="none" src={url} aria-label={name} onError={() => setError(true)} />}
  </div>
  return <div className={'drama-node-media ' + interactions} onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); openPreview() }}>
    <div className="drama-node-media-frame" data-media-type={node.type}>
      {error ? <div className="drama-node-media-placeholder" role="status">
        <NodeIcon type={node.type} size={21} /><span>{isImage ? '无法读取图片' : '无法播放视频'}</span>
      </div> : isImage ? <>
        <img src={url} alt={name} loading="lazy" decoding="async" onClick={openPreview} onError={() => setError(true)}
          onLoad={event => {
            const image = event.currentTarget
            if (image.naturalWidth > 0 && image.naturalHeight > 0) {
              setDimensions(image.naturalWidth + ' × ' + image.naturalHeight)
            }
            setLoaded(true)
          }} />
        {!loaded && <span className="drama-node-media-loading" role="status">正在读取图片</span>}
        <div className="drama-node-media-overlay">
          <Tooltip label="查看大图" portal>
            <Button variant="toolbar" size="sm" aria-label="查看大图" onClick={openPreview}>
              <IconFullscreenOutlineRegular size={15} />
            </Button>
          </Tooltip>
        </div>
      </> : enabled ? <video src={url} controls playsInline preload="metadata" aria-label={name}
        onError={() => setError(true)}
        onLoadedMetadata={event => {
          const video = event.currentTarget
          if (video.videoWidth && video.videoHeight) setDimensions(video.videoWidth + ' × ' + video.videoHeight)
          if (Number.isFinite(video.duration)) setDuration(Math.round(video.duration * 10) / 10 + ' 秒')
        }} /> : <div className="drama-node-media-placeholder">
        <Button size="sm" variant="outline" icon={<IconPlayOutlineRegular size={15} />}
          onClick={() => setEnabled(true)}>打开视频预览</Button>
      </div>}
    </div>
    {(dimensions || duration || storedDimensions || storedDuration || !isImage) &&
      <div className="drama-node-media-meta">
        <span>{[dimensions || storedDimensions, duration || storedDuration].filter(Boolean).join(' · ')}</span>
        {!isImage && <Button size="sm" variant="ghost" icon={<IconFullscreenOutlineRegular size={14} />}
          onClick={openPreview}>放大预览</Button>}
      </div>}
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

function NodeReferences({ node, index, edges = [], mediaURL, actions }) {
  const ids = [...new Set(referenceIds(node))]
  const mode = videoMode(node)
  const incoming = new Set(edges.filter(edge => edge.target === node.id).map(edge => edge.source))
  const other = mode ? [] : [...incoming].filter(source => !ids.includes(source))
  const entries = [
    ...ids.map((id, position) => [id, referenceLabel(mode, ids, position, index)]),
    ...other.map(source => [source, '引用']),
  ]
  if (!entries.length) return null
  return <div className="drama-node-reference-strip">
    <span className="drama-node-caption">{entries.length} 项参考</span>
    <div className={'drama-node-reference-scroll ' + interactions}>
      {entries.map(([id, label]) => {
        const related = index?.get(id)
        const title = related ? nodeName(related) : '画布外来源 ' + id
        const url = related?.type === 'image' ? mediaURL?.(related) : undefined
        return <div key={id} className="drama-node-reference-entry">
          <Tooltip label={label + ' · ' + title} portal>
            <Button size="sm" variant="outline" className="drama-node-reference-button" aria-label={label + ' · ' + title}
              onClick={() => actions.locate?.(id)}>
              {url && <img src={url} loading="lazy" decoding="async" alt="" />}
              <span>{label}{!related && ' · 画布外来源'}</span>
            </Button>
          </Tooltip>
          {!related && incoming.has(id) && actions.removeReference &&
            <Tooltip label={actions.mutationReason || '删除引用连线'} portal>
              <span>
                <Button size="sm" aria-label={'删除引用连线 · ' + title} disabled={Boolean(actions.mutationReason)}
                  onClick={() => actions.removeReference(id, node)}><IconTrashOutlineRegular size={14} /></Button>
              </span>
            </Tooltip>}
        </div>
      })}
    </div>
  </div>
}

function TaskMark({ task }) {
  return task ? <TaskStatus status={task.status} phase={task.phase} taskId={task.id} /> : null
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

const videoFields = { duration: '时长（秒）', resolution: '分辨率', aspectRatio: '画幅', generateAudio: '生成音频' }

function modelValue(profile, key, defaults) {
  if (!profile?.parameters?.includes(key)) return undefined
  const value = profile.defaults?.[key] ?? defaults?.[key]
  const limits = profile.limits ?? {}
  if (key === 'duration' && (limits.durations?.length && !limits.durations.includes(value) ||
    limits.durationMin && value < limits.durationMin || limits.durationMax && value > limits.durationMax)) return undefined
  if (key === 'resolution' && limits.resolutions?.length && !limits.resolutions.some(item =>
    item.toLowerCase() === value?.toLowerCase())) return undefined
  if (key === 'aspectRatio' && limits.aspectRatios?.length && !limits.aspectRatios.includes(value)) return undefined
  return value
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

function GenerateControl({ node, profiles, generationDefaults, actions }) {
  const mode = node.type === 'image' ? 't2i' : videoMode(node)
  const candidates = profileCandidates(profiles, mode).filter(profile => profile.configured)
  const [confirming, setConfirming] = useState(false)
  const [profileId, setProfileId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  if (!actions.submitGeneration || !mode || mode === 'asset' || !textValue(node.content, 'prompt')) return null
  const current = candidates.find(item => item.id === profileId)
  async function submit() {
    if (!current || busy) return
    setBusy(true)
    setError('')
    try {
      await actions.submitGeneration(node, current.id)
      setConfirming(false)
    } catch (failure) {
      setError(failure.message)
    } finally {
      setBusy(false)
    }
  }

  if (!confirming) return <Button size="sm" variant="primary" icon={<IconSparkleRegular size={15} />}
    onClick={() => {
      setProfileId(resolveProfile(candidates, node.content.profileId)?.id ?? '')
      setError('')
      setConfirming(true)
    }}>生成…</Button>
  return <section className="drama-node-confirm" role="dialog" aria-label="确认生成">
    <strong>确认生成</strong>
    {candidates.length ? <MenuSelect label="生成预设" value={profileId} onChange={setProfileId}
      items={candidates.map(profile => ({ id: profile.id, label: profile.name, title: profile.model }))} />
      : <div className="drama-node-empty-settings">请在 Settings → Drama Studio 配置支持此方式的模型。</div>}
    {current && <span className="drama-node-caption">{[current.model, ...paramSummary(current, generationDefaults, node.content.params, mode)].join(' · ')}</span>}
    {error && <p className="drama-node-form-error" role="alert">{error}</p>}
    <div className="drama-node-actions">
      <Button size="sm" disabled={busy} onClick={() => setConfirming(false)}>取消</Button>
      <Button size="sm" variant="primary" disabled={busy || !current} onClick={submit}>
        {busy ? '正在提交' : '确认提交'}
      </Button>
    </div>
  </section>
}

function MoreActions({ node, compact, actions }) {
  const [open, setOpen] = useState(false)
  const items = [
    { id: 'duplicate', label: '复制为新节点', icon: <IconCopyOutlineRegular /> },
    { id: 'collapse', label: compact ? '展开卡片' : '折叠卡片' },
  ]
  if (node.basedOn) items.push({ id: 'source', label: '定位来源', icon: <IconLinkOutlineRegular /> })
  return <Menu open={open} portal compact autoFocus align="end" items={items}
    onClose={() => setOpen(false)}
    onSelect={id => {
      setOpen(false)
      if (id === 'duplicate') actions.duplicate?.(node)
      else if (id === 'collapse') actions.collapse?.(node)
      else if (id === 'source') actions.locate?.(node.basedOn)
    }}
    anchor={<Tooltip label="更多节点操作" portal>
      <Button size="sm" aria-label="更多节点操作" aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen(current => !current)}><IconEllipsisOutlineRegular size={16} /></Button>
    </Tooltip>} />
}

export function GraphNode({ data, selected }) {
  const { node, draft, editor, compact, mediaURL, index, edges, tasks = [], generationProfiles = [], generationDefaults,
    selectedResult, actions = {} } = data
  const latest = tasks[0]
  const mode = videoMode(node)
  const media = isMedia(node)
  const url = media ? mediaURL?.(node) : undefined
  const candidate = Boolean(node.content.providerTaskId || tasks.some(task => task.resultNodeId === node.id))
  const profile = mediaTypes.has(node.type)
    ? resolveProfile(profileCandidates(generationProfiles, node.type === 'image' ? 't2i' : mode), node.content.profileId)
    : undefined
  const parameters = paramSummary(profile, generationDefaults, node.content.params, mode)
  const title = draft ? (nodeTitle(node) || '新建' + nodeLabels[node.type]) : nodeName(node)
  const mainText = savedText(node)
  const prompt = node.type !== 'prompt' ? textValue(node.content, 'prompt') : ''
  const preview = () => actions.preview?.(node)
  const source = node.basedOn && index?.get(node.basedOn)
  const saved = !draft || draft.edit
  const disabled = Boolean(actions.mutationReason)
  return <article className={'drama-node-card' + (selected ? ' is-selected' : '') + (draft ? ' is-draft' : '')
    + (compact && !draft ? ' is-compact' : '')}
    data-node-kind={node.type} data-drama-node-id={node.id}
    data-drama-draft={draft && !draft.edit ? 'true' : undefined}
    data-drama-editing={draft?.edit ? 'true' : undefined}>
    {saved && <Handle className="drama-port drama-port-input" type="target" id="in" position={Position.Left}
      isConnectable={!node.deleted && !draft && mode !== 'asset' && (!mode || !disabled)}
      aria-label={mode && mode !== 'asset' ? '媒体输入' : '节点引用输入'} />}
    {saved && <Handle className="drama-lineage-port" type="target" id="lineage" position={Position.Left}
      isConnectable={false} aria-hidden="true" />}
    <header className="drama-node-titlebar">
      <span className="drama-node-type-icon" title={nodeLabels[node.type]}><NodeIcon type={node.type} /></span>
      <div className="drama-node-heading">
        <strong title={title}>{title}</strong>
        <span className="drama-node-caption" title={fieldLabel(node)}>{mode ? modeLabels[mode] : nodeLabels[node.type]}
          {fieldLabel(node) && ' · ' + fieldLabel(node)}</span>
      </div>
      {draft ? <Tag tone="warning">未保存</Tag>
        : node.deleted ? <Tag tone="neutral">已删除</Tag> : <TaskMark task={latest} />}
    </header>
    {draft ? <NodeEditor draft={draft} {...editor} mediaURL={mediaURL}
      generationProfiles={generationProfiles} generationDefaults={generationDefaults} />
      : compact ? <div className="drama-node-compact-content">
        {node.type === 'image' && url && <img src={url} alt="" loading="lazy" decoding="async" />}
        <span>{mainText || prompt || (media ? nodeLabels[node.type] + '素材' : '暂无正文')}</span>
      </div> : <div className="drama-node-body">
        {url && <SourceMedia key={url} node={node} url={url} openPreview={preview} />}
        <ReadableText text={mainText} label={node.type === 'prompt' ? '提示词' : undefined} />
        <ReadableText text={prompt} label={node.type === 'video' ? '完整视频提示词' : '提示词'} />
        {mediaTypes.has(node.type) && !url && !prompt && <div className="drama-node-media-placeholder">
          <NodeIcon type={node.type} size={21} />
          <span>{media ? '素材地址不可用' : '尚未添加素材或提示词'}</span>
          {actions.edit && <Button size="sm" disabled={disabled} title={actions.mutationReason}
            onClick={() => actions.edit(node)}>添加素材或提示词</Button>}
        </div>}
        {!mediaTypes.has(node.type) && !mainText && !prompt && <span className="drama-node-caption">暂无正文</span>}
        <NodeReferences node={node} index={index} edges={edges} mediaURL={mediaURL} actions={actions} />
        {(profile || latest?.model) && <div className="drama-node-model">
          <span className="drama-node-caption">模型</span>
          <span title={profile?.model ?? latest?.model}>{profile?.name ?? profile?.model ?? latest?.model}</span>
          {parameters.length > 0 && <small>{parameters.join(' · ')}</small>}
        </div>}
        {candidate && <div className="drama-node-candidate">
          <Tag tone={selectedResult ? 'info' : 'neutral'}>{selectedResult ? '已选定' : '候选结果'}</Tag>
          {actions.selectResult && !selectedResult &&
            <Button size="sm" onClick={() => actions.selectResult(node)}>选定此结果</Button>}
          {source && textValue(source.content, 'prompt') && actions.revise &&
            <Button size="sm" onClick={() => actions.revise(source)}>从来源重抽</Button>}
        </div>}
        <TaskDetail task={latest} nodeId={node.id} locate={actions.locate} />
        {!node.deleted && <footer className={'drama-node-actions ' + interactions} onDoubleClick={preventCanvasDoubleClick}>
          {actions.revise && <Button size="sm" icon={<IconBranchOutlineRegular size={15} />}
            onClick={() => actions.revise(node)}>派生版本</Button>}
          <GenerateControl node={node} profiles={generationProfiles} generationDefaults={generationDefaults} actions={actions} />
        </footer>}
      </div>}
    {saved &&
      <Handle className="drama-port drama-port-output" data-port-kind={media ? node.type : 'reference'}
        type="source" id="out" position={Position.Right} isConnectable={!draft && !node.deleted}
        aria-label={nodeLabels[node.type] + '输出'} />}
    {!draft && !node.deleted && <>
      {actions.addAfter && <div className={'drama-node-add-after ' + interactions}>
        <Tooltip label="新增后继节点" portal>
          <Button size="sm" variant="toolbar" aria-label="新增后继节点"
            onClick={event => actions.addAfter(node, event.currentTarget.getBoundingClientRect())}>
            <IconPlusOutlineRegular size={15} />
          </Button>
        </Tooltip>
      </div>}
      <NodeToolbar position={Position.Top} offset={7} isVisible={selected}>
        <div className={'drama-node-floating-tools ' + interactions}>
          <Tooltip label={actions.mutationReason || '编辑节点'} portal>
            <span>
              <Button size="sm" aria-label="编辑节点" disabled={disabled} onClick={() => actions.edit(node)}>
                <IconEditOutlineRegular size={15} />
              </Button>
            </span>
          </Tooltip>
          <Tooltip label={actions.mutationReason || '删除节点'} portal>
            <span>
              <Button size="sm" aria-label="删除节点" disabled={disabled} onClick={() => actions.delete(node)}>
                <IconTrashOutlineRegular size={15} />
              </Button>
            </span>
          </Tooltip>
          {url && <Tooltip label="放大预览" portal>
            <Button size="sm" aria-label="放大预览" onClick={preview}><IconFullscreenOutlineRegular size={15} /></Button>
          </Tooltip>}
          <MoreActions node={node} compact={compact} actions={actions} />
        </div>
      </NodeToolbar>
    </>}
  </article>
}

const channelFields = new Set([
  'apikey', 'apitoken', 'authorization', 'credentials', 'baseurl', 'apiurl', 'protocol', 'headers',
  'authheader', 'auth', 'requestmapping', 'taskplugin', 'advanced', 'submiturl', 'queryurl',
])

function draftReferenceIssue(mode, kinds, profile) {
  if (mode === 't2v' && kinds.length) return '文生视频只需要完整提示词，请移除素材。'
  if (mode === 'i2v' && (!kinds.length || kinds.length > 2 || kinds.some(kind => kind !== 'image'))) {
    return '图生视频需要一张首帧图片，可选一张模型支持的尾帧图片。'
  }
  if (mode === 'i2v' && kinds.length === 2 && profile && !profile.limits?.lastFrame) return '所选模型不支持尾帧。'
  if (mode === 'v2v' && (kinds.length !== 1 || kinds[0] !== 'video')) return '视频转视频需要一个源视频。'
  if (mode === 'r2v' && !kinds.length) return '参考生视频需要至少一个参考素材。'
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
  return ''
}

function VideoParamOverrides({ value, update, profile, generationDefaults, mode }) {
  const choices = { duration: profile?.limits?.durations, resolution: profile?.limits?.resolutions,
    aspectRatio: profile?.limits?.aspectRatios, generateAudio: ['true', 'false'] }
  return Object.entries(videoFields).map(([key, label]) => {
    if (key === 'aspectRatio' && inheritsFirstFrameRatio(profile, mode)) return null
    const selected = value[key] ?? ''
    const supported = profile?.parameters?.includes(key)
    if (!supported && selected === '') return null
    const inherited = modelValue(profile, key, generationDefaults)
    const placeholder = inherited == null ? '继承默认值' :
      key === 'generateAudio' ? (inherited ? '继承：开启' : '继承：关闭') : '继承：' + inherited
    const options = (choices[key] ?? []).map(item => ({
      id: String(item), label: key === 'generateAudio' ? (item === 'true' ? '开启' : '关闭') : String(item),
    }))
    if (selected && options.length && !options.some(item => item.id === selected)) options.push({ id: selected, label: selected })
    if (options.length) {
      return <MenuSelect key={key} label={label} value={selected}
        items={[{ id: '', label: placeholder }, ...options]} onChange={next => update(key, next)} />
    }
    return <label key={key} className="drama-node-field">{label}
      <Input value={selected} placeholder={placeholder} type={key === 'duration' ? 'number' : 'text'}
        min={key === 'duration' ? profile?.limits?.durationMin ?? -1 : undefined}
        max={key === 'duration' ? profile?.limits?.durationMax ?? 3600 : undefined}
        onChange={event => update(key, event.target.value)} />
    </label>
  })
}

function NodeEditor({ draft, append, mutate, mutationReason, media = [], queryCanvas, finish, close, mediaURL,
  generationProfiles, generationDefaults }) {
  const { base, preset, seed, duplicate, edit, group } = draft
  const type = preset?.type ?? base?.type ?? 'shot'
  const inherited = base?.content ?? (type === 'video' && seed && !isMedia(seed) ? seed.content : {})
  const sameKind = base?.type === type
  const content = sameKind ? inherited : {}
  const [mode, setMode] = useState(preset?.mode ?? (sameKind && base ? videoMode(base) : 't2v'))
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [prompt, setPrompt] = useState(() => sameKind && type !== 'prompt' ? textValue(content, 'prompt') : textValue(inherited, 'prompt', 'text', 'description'))
  const [profileId, setProfileId] = useState(sameKind && (!preset?.mode || preset.mode === videoMode(base))
    ? textValue(content, 'profileId') : '')
  const [overrides, setOverrides] = useState(() => Object.fromEntries(Object.keys(videoFields)
    .filter(key => content.params?.[key] != null).map(key => [key, String(content.params[key])])))
  const [references, setReferences] = useState(() => [...new Set([
    ...(sameKind && (type === 'video' || type === 'shot') ? referenceIds(base) : []),
    ...(isMedia(seed) && (type === 'video' || type === 'shot' && seed.type === 'image') ? [seed.id] : []),
  ])])
  const [extraMedia, setExtraMedia] = useState(() => isMedia(seed) ? [seed] : [])
  const mediaById = new Map([...media, ...extraMedia].map(item => [item.id, item]))
  const missing = references.filter(id => !mediaById.has(id)).join(',')
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
  const [referenceSearch, setReferenceSearch] = useState(type === 'video' && mode !== 't2v' && mode !== 'asset')
  const titleInput = useRef(null)
  useEffect(() => {
    // React Flow keeps a new node hidden while it measures the card.
    let frame
    let attempts = 0
    function focusName() {
      const input = titleInput.current
      if (!input || input.form?.contains(document.activeElement)) return
      if (getComputedStyle(input).visibility === 'visible' && input.getClientRects().length) {
        input.focus({ preventScroll: true })
        if (document.activeElement === input) return
      }
      if (++attempts < 30) frame = requestAnimationFrame(focusName)
    }
    frame = requestAnimationFrame(focusName)
    return () => cancelAnimationFrame(frame)
  }, [])
  const textField = 'text' in content && !('description' in content) ? 'text' : 'description'
  const videoDraft = type === 'video' && mode !== 'asset'
  const hasPrompt = type === 'prompt' || type === 'image' || videoDraft
  const hasAssetFields = mediaTypes.has(type) && !videoDraft
  const currentProfiles = profileCandidates(generationProfiles, type === 'image' ? 't2i' : mode)
  const activeProfile = resolveProfile(currentProfiles, profileId)
  const formLabel = edit ? '编辑节点' : duplicate ? '复制为新节点' : base ? '另存为新版本' : '新建节点'
  const choices = [{ id: '', label: '使用默认预设' },
    ...(profileId && !currentProfiles.some(item => item.id === profileId) ? [{ id: profileId, label: '原预设不可用' }] : []),
    ...currentProfiles.map(item => ({ id: item.id, label: item.name, title: item.model, disabled: item.configured === false }))]
  const referenceMode = type === 'video' ? mode : ''

  function changeMode(value) {
    setMode(value)
    setProfileId('')
    setReferenceSearch(value === 'i2v' || value === 'r2v' || value === 'v2v')
    setError('')
  }

  async function save(event) {
    event.preventDefault()
    if (saving || edit && mutationReason) return
    const form = new FormData(event.currentTarget)
    const next = { ...content }
    if (form.has('description')) next[textField] = String(form.get('description')).trim()
    const title = String(form.get('title') ?? '').trim()
    if (title) next.title = title
    else delete next.title
    if (hasPrompt) next.prompt = prompt
    if (hasAssetFields) {
      for (const field of ['path', 'url']) {
        const value = String(form.get(field) ?? '').trim()
        if (value) next[field] = value
        else delete next[field]
      }
    }
    let ordered = []
    if (videoDraft) {
      if (!prompt.trim()) { setError('请填写完整视频提示词。'); return }
      const attached = references.map(id => mediaById.get(id))
      if (attached.some(item => !isMedia(item))) { setError('请移除不可用的媒体输入。'); return }
      const issue = draftReferenceIssue(mode, attached.map(item => item.type), activeProfile)
      if (issue) { setError(issue); return }
      const params = Object.fromEntries(Object.entries(overrides).filter(([key, value]) =>
        value.trim() && (key !== 'aspectRatio' || !inheritsFirstFrameRatio(activeProfile, mode))).map(([key, value]) =>
        [key, key === 'duration' ? Number(value) : key === 'generateAudio' ? value === 'true' : value.trim()]))
      if (activeProfile?.parameters && Object.keys(params).some(key => !activeProfile.parameters.includes(key))) {
        setError('所选模型不支持部分参数覆盖。请清空对应字段或选择支持的模型。')
        return
      }
      if (Object.keys(params).length) next.params = params
      else delete next.params
      ordered = references
      next.mode = mode
      next.mixedListOrder = ordered
      delete next.path
      delete next.url
      delete next.textList
    } else if (type === 'video') {
      if (!next.path && !next.url) { setError('请填写项目内视频路径或视频网址。'); return }
      for (const key of ['mode', 'profileId', 'params', 'prompt', 'textList', 'mixedListOrder']) delete next[key]
    } else if (type === 'shot') {
      ordered = references
      if (ordered.length) next.mixedListOrder = ordered
      else delete next.mixedListOrder
    } else if (type === 'image') {
      if (!next.path && !next.url && !prompt.trim()) { setError('请填写图片素材地址或生成提示词。'); return }
      // Current T2I adapters do not take media generation inputs. A seed is an editorial edge.
      delete next.mixedListOrder
    } else if (type === 'audio' && !next.path && !next.url) {
      setError('请填写项目内音频路径或音频网址。')
      return
    }
    if (type === 'video') {
      for (const key of Object.keys(next)) if (channelFields.has(key.toLowerCase().replace(/[_-]/gu, ''))) delete next[key]
    }
    if (!edit && mediaTypes.has(type)) delete next.providerTaskId
    if (videoDraft || type === 'image') {
      if (profileId) next.profileId = profileId
      else delete next.profileId
    }
    setSaving(true)
    setError('')
    try {
      const id = edit ? base.id : crypto.randomUUID()
      const fields = Object.fromEntries(groupFields.map(([field]) => [field, String(form.get(field) ?? '').trim()]))
      if (edit) {
        await mutate('update_node', { id, revision: base.revision, ...fields, content: next,
          referenceSources: type === 'video' || type === 'shot' ? ordered : undefined })
      } else {
        const edges = new Set(ordered)
        if (type !== 'video' && seed?.id && seed.id !== base?.id) edges.add(seed.id)
        await append({ nodes: [{ id, type, basedOn: base?.id, content: next, ...fields }],
          edges: [...edges].map(source => ({ source, target: id })) })
      }
      finish(id)
    } catch (failure) {
      setError(failure.message)
    } finally {
      setSaving(false)
    }
  }

  const showReferences = videoDraft && (mode !== 't2v' || references.length > 0)
    || type === 'shot' && (referenceSearch || references.length > 0)
  return <form className={'drama-node-editor ' + interactions} onSubmit={save} aria-label={formLabel}
    onKeyDown={stopCanvasKeys} onDoubleClick={preventCanvasDoubleClick}>
    <div className="drama-node-editor-fields">
      <label className="drama-node-field">节点名称
        <Input ref={titleInput} name="title" defaultValue={nodeTitle(base ?? { content })} placeholder={nodeLabels[type]} />
      </label>
      <div className="drama-node-group-fields">{groupFields.map(([field, label]) =>
        <label className="drama-node-field" key={field}>{label}
          <Input name={field} defaultValue={base?.[field] ?? group?.[field] ?? ''} />
        </label>)}</div>
      {type === 'video' && <MenuSelect label="视频方式" value={mode} onChange={changeMode}
        items={Object.entries(modeLabels).map(([id, label]) => ({ id, label }))} />}
      {type !== 'prompt' && !videoDraft && <label className="drama-node-field">正文
        <textarea name="description" rows={3} defaultValue={content[textField] ?? ''} />
      </label>}
      {hasPrompt && <label className="drama-node-field">{type === 'video' ? '完整视频提示词' : '提示词'}
        <textarea name="prompt" rows={4} value={prompt} onChange={event => setPrompt(event.target.value)} />
      </label>}
      {hasAssetFields && <details className="drama-node-editor-optional" open={!base && type !== 'image' ? true : undefined}>
        <summary>素材来源</summary>
        <label className="drama-node-field">素材网址
          <Input type="url" name="url" defaultValue={content.url ?? ''} placeholder="https://" />
        </label>
        <label className="drama-node-field">项目内素材路径
          <Input name="path" defaultValue={content.path ?? ''} placeholder={assetFolders[type]} />
        </label>
      </details>}
      {type === 'shot' && !showReferences && <Button size="sm" icon={<IconLinkOutlineRegular size={14} />}
        onClick={() => setReferenceSearch(true)}>添加参考资产</Button>}
      {showReferences && <MediaReferences mode={referenceMode} profile={activeProfile} media={mediaById} mediaURL={mediaURL}
        queryCanvas={queryCanvas} references={references} setReferences={setReferences} onSelect={node => {
          setExtraMedia(current => [...current, node])
          setReferences(current => [...current, node.id])
        }} />}
      {(videoDraft || type === 'image' && choices.length > 1) && <details className="drama-node-editor-optional">
        <summary>更多参数</summary>
        <MenuSelect label="生成预设" value={profileId} onChange={setProfileId} items={choices} />
        {activeProfile && <span className="drama-node-caption">
          {[activeProfile.model, ...paramSummary(activeProfile, generationDefaults, undefined, mode)].join(' · ')}
        </span>}
        {videoDraft && <VideoParamOverrides value={overrides} profile={activeProfile} generationDefaults={generationDefaults} mode={mode}
          update={(key, value) => setOverrides(current => ({ ...current, [key]: value }))} />}
      </details>}
    </div>
    {edit && mutationReason && <p className="drama-node-lock-notice" role="status">{mutationReason} 草稿已保留。</p>}
    {error && <p className="drama-node-form-error" role="alert">{error}</p>}
    <div className="drama-node-editor-footer">
      <Button size="sm" disabled={saving} onClick={close}>取消</Button>
      <Button size="sm" type="submit" variant="primary" disabled={saving || Boolean(edit && mutationReason)}>
        {saving ? '正在保存' : edit ? '保存修改' : duplicate ? '保存副本' : base ? '保存新版本' : '创建节点'}
      </Button>
    </div>
  </form>
}

function referenceLabel(mode, references, position, known) {
  if (mode === 'i2v') return position === 0 ? '首帧' : '尾帧'
  if (mode === 'v2v') return '源视频'
  const kind = known?.get(references[position])?.type
  if (mode === 'r2v' && mediaTypes.has(kind)) {
    const ordinal = references.slice(0, position + 1).filter(id => known.get(id)?.type === kind).length
    return '@' + nodeLabels[kind] + ordinal
  }
  return '参考 ' + (position + 1)
}

function MediaReferences({ mode, profile, media, mediaURL, queryCanvas, references, setReferences, onSelect }) {
  const [search, setSearch] = useState('')
  const [results, setResults] = useState([])
  const [error, setError] = useState('')
  const totalLimit = mode === 'r2v' ? profile?.limits?.maxReferences ?? 32 : 32
  const allowedKinds = [...mediaTypes].filter(kind => {
    const count = references.filter(id => media.get(id)?.type === kind).length
    return references.length < totalLimit && count < referenceLimit(mode, kind, profile)
  }).join(',')
  useEffect(() => {
    if (!queryCanvas || !allowedKinds) return
    const request = new AbortController()
    const timer = setTimeout(() => {
      Promise.all(allowedKinds.split(',').map(type => queryCanvas({ type, q: search, limit: 30 }, request.signal)))
        .then(snapshots => {
          if (request.signal.aborted) return
          setResults(snapshots.flatMap(snapshot => snapshot.nodes))
          setError('')
        }).catch(failure => {
          if (!request.signal.aborted) setError(failure.message)
        })
    }, 180)
    return () => { request.abort(); clearTimeout(timer) }
  }, [queryCanvas, search, allowedKinds])
  const known = new Map([...results.map(node => [node.id, node]), ...media])
  const kinds = new Set(allowedKinds.split(','))
  const q = search.trim().toLowerCase()
  const available = [...known.values()].filter(node => !node.deleted && kinds.has(node.type) && isMedia(node) &&
    !references.includes(node.id) && (nodeName(node) + ' ' + savedText(node) + ' ' + shotLabel(node)).toLowerCase().includes(q))
  const labels = {
    i2v: [profile?.limits?.lastFrame ? '首帧与尾帧图片' : '首帧图片', '图片素材'],
    r2v: ['参考素材', '参考素材'],
    v2v: ['源视频', '视频素材'],
    t2v: ['素材输入', '媒体素材'],
    '': ['参考图片', '图片素材'],
  }
  const [legend, kindLabel] = labels[mode]

  function move(index, delta) {
    const next = [...references]
    const [id] = next.splice(index, 1)
    next.splice(index + delta, 0, id)
    setReferences(next)
  }

  return <fieldset className="drama-node-editor-references">
    <legend>{legend}</legend>
    {allowedKinds && <>
      {queryCanvas && <Input aria-label={'搜索' + kindLabel} placeholder={'搜索' + kindLabel} value={search}
        onChange={event => setSearch(event.target.value)} />}
      <MenuSelect label={'添加' + kindLabel} value="" placeholder={available.length ? '选择' + kindLabel : '暂无匹配素材'}
        items={available.map(item => ({ id: item.id, label: item.type === 'image' ? nodeName(item) :
          nodeLabels[item.type] + ' · ' + nodeName(item), title: item.id }))}
        onChange={id => { if (known.has(id)) onSelect(known.get(id)) }} />
    </>}
    {!allowedKinds && !references.length && mode === 'r2v' && <small>所选模型未配置可用的参考素材。</small>}
    {error && <p className="drama-node-form-error" role="alert">{error}</p>}
    {references.length > 0 && <ol>{references.map((id, index) => {
      const item = known.get(id)
      const url = item?.type === 'image' ? mediaURL?.(item) : undefined
      return <li key={id}>
        {url && <img src={url} loading="lazy" decoding="async" alt="" />}
        <span title={item ? nodeName(item) : id}>{referenceLabel(mode, references, index, known)}
          {item && ' · ' + nodeName(item)}{item?.deleted && '（已删除）'}</span>
        {references.length > 1 && <>
          <Button size="sm" aria-label={'上移参考 ' + (index + 1)} disabled={index === 0} onClick={() => move(index, -1)}>↑</Button>
          <Button size="sm" aria-label={'下移参考 ' + (index + 1)} disabled={index === references.length - 1}
            onClick={() => move(index, 1)}>↓</Button>
        </>}
        <Button size="sm" aria-label={'移除参考 ' + (index + 1)} onClick={() => setReferences(references.filter(ref => ref !== id))}>移除</Button>
      </li>
    })}</ol>}
  </fieldset>
}
