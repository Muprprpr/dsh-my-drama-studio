import React, { useEffect, useId, useState } from 'react'
import { Button, Checkbox, IconChevronDownOutlineRegular, Input, Menu, SegmentedTabs, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { providerRequest } from './studio-api.js'
import style from './provider-settings.css'

const protocols = {
  'new-api': 'New API Task / Video',
  'openai-video': 'OpenAI 兼容视频',
  'custom-rest': 'Custom REST',
  'minimax-h3': '秘塔 MiniMax H3',
  ark: '火山方舟',
  byteplus: 'BytePlus ModelArk',
  replicate: 'Replicate',
}
const modes = {
  t2v: 'T2V · 文生视频',
  i2v: 'I2V · 首帧生视频',
  r2v: 'R2V · 参考生视频',
  v2v: 'V2V · 视频转视频',
  t2i: 'T2I · 文生图',
}
const tabs = { channels: '视频渠道', models: '模型预设', generation: '生成设置' }
const optionalNumber = value => value === '' ? undefined : Number(value)
const optionList = (value = '') => [...new Set(value.split(/[,，]/u).map(item => item.trim()).filter(Boolean))]
const items = labels => Object.entries(labels).map(([id, label]) => ({ id, label }))

const changes = new EventTarget()
let settingsRevision = 0
export const getProviderSettingsRevision = () => settingsRevision
export function subscribeProviderSettings(listener) {
  changes.addEventListener('changed', listener)
  return () => changes.removeEventListener('changed', listener)
}
function notifyProviderSettings() {
  settingsRevision += 1
  changes.dispatchEvent(new Event('changed'))
}

function Choice({ label, value, items: entries, onChange, disabled }) {
  const [open, setOpen] = useState(false)
  return <Menu open={!disabled && open} portal compact onClose={() => setOpen(false)}
    anchor={<Button variant="outline" size="sm" aria-label={label} aria-haspopup="menu" aria-expanded={!disabled && open}
      disabled={disabled} className="drama-provider-choice" onClick={() => setOpen(current => !current)}>
      <span>{entries.find(item => item.id === value)?.label || label}</span>
      <IconChevronDownOutlineRegular size={12} />
    </Button>}
    items={entries} selectedId={value} onSelect={next => {
      setOpen(false)
      onChange(next)
    }} />
}

function Field({ label, value, onChange, help, ...input }) {
  const id = useId()
  return <div className="drama-provider-field">
    <label htmlFor={id}>{label}</label>
    <Input id={id} value={value ?? ''} onChange={event => onChange(event.target.value)}
      aria-describedby={help ? id + '-help' : undefined} {...input} />
    {help && <small id={id + '-help'}>{help}</small>}
  </div>
}

function ChoiceField({ label, ...props }) {
  return <div className="drama-provider-field">
    <span>{label}</span>
    <Choice label={label} {...props} />
  </div>
}

function FormActions({ busy, onCancel, label }) {
  return <div className="drama-provider-actions">
    <Button type="submit" variant="primary" size="sm" disabled={busy}>{label}</Button>
    {onCancel && <Button size="sm" disabled={busy} onClick={onCancel}>取消编辑</Button>}
  </div>
}

function Removal({ name, onRemove, onCancel, busy }) {
  return <div className="drama-provider-remove">
    <p>删除「{name}」？已提交的任务会保留。</p>
    <div className="drama-provider-actions">
      <Button size="sm" variant="outline" disabled={busy} onClick={onRemove}>确认删除</Button>
      <Button size="sm" disabled={busy} onClick={onCancel}>取消</Button>
    </div>
  </div>
}

const advancedFields = {
  model: '模型',
  prompt: '提示词',
  duration: '时长',
  resolution: '分辨率',
  aspectRatio: '画幅',
  generateAudio: '生成音频',
  firstFrame: '首帧',
  lastFrame: '尾帧',
  references: '参考素材',
  sourceVideo: '源视频',
}
const lifecycle = { queued: '排队', processing: '处理中', completed: '成功', failed: '失败', cancelled: '取消' }

function customDraft({ fields, statusMap = {}, ...settings } = {}) {
  return {
    submitMethod: 'POST', queryMethod: 'GET', auth: 'bearer', ...settings,
    fields: { ...fields },
    statusValues: Object.fromEntries(Object.keys(lifecycle).map(status =>
      [status, Object.entries(statusMap).filter(([, local]) => local === status).map(([remote]) => remote).join(', ')])),
  }
}

function CustomFields({ value, onChange, disabled }) {
  const change = (field, next) => onChange({ ...value, [field]: next })
  const field = (label, key, props) => <Field label={label} value={value[key]} disabled={disabled}
    onChange={next => change(key, next)} {...props} />
  const pick = (label, key, choices) => <ChoiceField label={label} value={value[key]} items={items(choices)}
    disabled={disabled} onChange={next => change(key, next)} />
  return <details open className="drama-provider-details">
    <summary>高级协议配置</summary>
    <div className="drama-provider-fields">
      {field('提交任务 URL', 'submitUrl', { required: true, placeholder: '/jobs' })}
      {pick('提交方法', 'submitMethod', { POST: 'POST', PUT: 'PUT', PATCH: 'PATCH' })}
      {field('查询任务 URL', 'queryUrl', { required: true, placeholder: '/jobs/{taskId}' })}
      {pick('查询方法', 'queryMethod', { GET: 'GET', POST: 'POST' })}
      {pick('鉴权方式', 'auth', { bearer: 'Bearer Token', header: '自定义请求头', none: '无鉴权' })}
      {value.auth === 'header' && field('鉴权请求头名称', 'authHeader', { required: true, placeholder: 'X-API-Key' })}
      {field('任务 ID 字段路径', 'taskIdPath', { required: true, placeholder: 'data.id' })}
      {field('任务状态字段路径', 'statusPath', { required: true, placeholder: 'data.status' })}
      {field('下载地址字段路径', 'outputUrlPath', { required: !value.downloadUrl, placeholder: 'data.output.url' })}
      {field('下载 URL', 'downloadUrl', { required: !value.outputUrlPath, placeholder: '/jobs/{taskId}/content',
        help: '查询结果不带下载链接时填写此项。与下载地址字段路径二选一。' })}
      {field('连接验证 URL', 'probeUrl', { placeholder: '/account' })}
      {field('模型验证 URL', 'modelProbeUrl', { placeholder: '/models/{model}' })}
    </div>
    <h4>请求体字段映射</h4>
    <div className="drama-provider-fields">
      {Object.entries(advancedFields).map(([key, label]) => <Field key={key} label={label + '字段'}
        value={value.fields[key]} disabled={disabled} placeholder={key}
        onChange={next => change('fields', { ...value.fields, [key]: next })} />)}
    </div>
    <h4>上游状态值</h4>
    <div className="drama-provider-fields">
      {Object.entries(lifecycle).map(([status, label]) => <Field key={status} label={label + '状态值'}
        value={value.statusValues[status]} disabled={disabled} placeholder="多个值用逗号分隔"
        onChange={next => change('statusValues', { ...value.statusValues, [status]: next })} />)}
    </div>
  </details>
}

function channelPayload(channel, custom) {
  const { id, name, protocol, baseUrl, taskPlugin } = channel
  const result = { id, name: name.trim(), protocol }
  if (['new-api', 'openai-video', 'custom-rest'].includes(protocol)) result.baseUrl = baseUrl?.trim()
  if (protocol === 'new-api' && taskPlugin?.trim()) result.taskPlugin = taskPlugin.trim()
  if (protocol !== 'custom-rest') return result
  const { statusValues, fields, ...settings } = custom
  const statuses = Object.entries(statusValues).flatMap(([status, values]) => optionList(values).map(remote => [remote, status]))
  if (new Set(statuses.map(([remote]) => remote)).size !== statuses.length) {
    throw new Error('同一上游状态值只能映射到一种任务状态。')
  }
  result.advanced = {
    ...Object.fromEntries(Object.entries(settings).map(([key, value]) => [key, value?.trim()])),
    fields: Object.fromEntries(Object.entries(fields).filter(([, value]) => value.trim())
      .map(([key, value]) => [key, value.trim()])),
    statusMap: Object.fromEntries(statuses),
  }
  return result
}

function ChannelForm({ original, busy, onSave, onCancel, onError }) {
  const [channel, setChannel] = useState(original)
  const [custom, setCustom] = useState(() => customDraft(original.advanced))
  const [apiKey, setAPIKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const configurableURL = ['new-api', 'openai-video', 'custom-rest'].includes(channel.protocol)
  const needsKey = channel.protocol !== 'custom-rest' || custom.auth !== 'none'
  const change = (key, value) => setChannel(current => ({ ...current, [key]: value }))

  function save(event) {
    event.preventDefault()
    try {
      const payload = channelPayload(channel, custom)
      void onSave({ channel: payload, apiKey: clearKey || !needsKey ? '' : apiKey.trim() || undefined })
    } catch (error) {
      onError(error.message)
    }
  }

  return <form className="drama-provider-form" onSubmit={save}>
    <Field label="渠道名称" value={channel.name} onChange={value => change('name', value)} required disabled={busy} />
    <ChoiceField label="协议" value={channel.protocol} items={items(protocols)} disabled={busy || Boolean(channel.id)}
      onChange={value => {
        change('protocol', value)
        setAPIKey('')
        setClearKey(false)
      }} />
    {configurableURL && <Field label="Base URL" value={channel.baseUrl} onChange={value => change('baseUrl', value)}
      required disabled={busy} placeholder="https://api.example.com"
      help={channel.id ? '更换服务源站时，请新增渠道。' : undefined} />}
    {needsKey && <Field label="API 密钥" value={apiKey} onChange={setAPIKey} type="password" autoComplete="new-password"
      placeholder={original.configured ? '已设置，留空保留' : '输入渠道密钥'} disabled={busy || clearKey} />}
    {needsKey && original.configured && <Checkbox label="移除已保存的 API 密钥" checked={clearKey}
      disabled={busy} onChange={setClearKey} />}
    {channel.protocol === 'new-api' && <details className="drama-provider-details">
      <summary>高级协议配置</summary>
      <Field label="Task 插件" value={channel.taskPlugin} disabled={busy} onChange={value => change('taskPlugin', value)} />
    </details>}
    {channel.protocol === 'custom-rest' && <CustomFields value={custom} onChange={setCustom} disabled={busy} />}
    <FormActions busy={busy} onCancel={onCancel} label="保存渠道" />
  </form>
}

const verificationLabels = {
  verified: ['通过', 'success'],
  failed: ['失败', 'danger'],
  unverified: ['未验证', 'neutral'],
  listed: ['目录可见', 'neutral'],
  not_listed: ['目录未列出', 'neutral'],
  not_required: ['无需验证', 'quiet'],
}

function Verification({ value }) {
  return <div className="drama-provider-verification">
    <div className="drama-provider-actions">
      {[
        ['配置', value.configValid === true ? 'verified' : value.configValid === false ? 'failed' : value.configValid],
        ['鉴权', value.authentication],
        ['模型可调用', value.modelCallable],
        ['真实任务', value.taskSucceeded],
      ].map(([label, state]) => {
        const [text, tone] = verificationLabels[state] ?? verificationLabels.unverified
        return <Tag key={label} tone={tone}>{label} · {text}</Tag>
      })}
    </div>
    {value.message && <p>{value.message}</p>}
  </div>
}

function ConnectionTest({ channel, profiles, busy, run }) {
  const candidates = profiles.filter(profile => profile.channelId === channel.id)
  const [modelId, setModelId] = useState(candidates.length === 1 ? candidates[0].id : '')
  const choices = [{ id: '', label: '仅检查渠道' }, ...candidates.map(model => ({ id: model.id, label: model.name }))]
  return <div className="drama-provider-actions">
    {candidates.length > 0 && <Choice label="验证模型" value={modelId} items={choices} disabled={busy} onChange={setModelId} />}
    <Button size="sm" variant="primary" disabled={busy}
      onClick={() => void run('channel_test', { id: channel.id, modelId: modelId || undefined })}>开始测试</Button>
  </div>
}

function Channels({ data, busy, run, clearFeedback, setError }) {
  const [draft, setDraft] = useState(null)
  const [removing, setRemoving] = useState(null)
  const [testing, setTesting] = useState(null)
  const { channels = [], profiles = [], revision } = data
  const edit = next => {
    clearFeedback()
    setDraft(next)
    setRemoving(null)
    setTesting(null)
  }

  async function save(value) {
    const next = await run('channel_save', { ...value, revision }, '渠道已保存')
    if (next) setDraft(null)
  }

  return draft ? <ChannelForm original={draft} busy={busy} onSave={save}
    onCancel={() => edit(null)} onError={setError} /> : <>
    <Button size="sm" variant="primary" disabled={busy}
      onClick={() => edit({ name: '', protocol: 'new-api', baseUrl: '' })}>新增渠道</Button>
    {!channels.length && <p>添加渠道后，可为同一个渠道创建多个模型预设。</p>}
    <ul className="drama-provider-list">
      {channels.map(channel =>
        <li key={channel.id}>
          <div className="drama-provider-row">
            <div>
              <strong>{channel.name}</strong>
              <small>{protocols[channel.protocol] ?? channel.protocol}{channel.baseUrl ? ' · ' + channel.baseUrl : ''}</small>
              <small>{channel.configured ? '密钥已设置' : channel.advanced?.auth === 'none' ? '无鉴权' : '密钥未设置'}</small>
            </div>
            <div className="drama-provider-actions">
              <Button size="sm" disabled={busy} onClick={() => edit(channel)}>编辑渠道</Button>
              <Button size="sm" disabled={busy} onClick={() => {
                setTesting(current => current === channel.id ? null : channel.id)
                setRemoving(null)
                clearFeedback()
              }}>测试连接</Button>
              <Button size="sm" disabled={busy} onClick={() => {
                setRemoving(channel.id)
                setTesting(null)
                clearFeedback()
              }}>删除渠道</Button>
            </div>
          </div>
          {testing === channel.id && <ConnectionTest channel={channel} profiles={profiles} busy={busy} run={run} />}
          {channel.verification ? <Verification value={channel.verification} /> : <small>连接未测试</small>}
          {removing === channel.id && <Removal name={channel.name} busy={busy} onCancel={() => setRemoving(null)}
            onRemove={async () => {
              if (await run('channel_remove', { id: channel.id, revision }, '渠道已删除')) setRemoving(null)
            }} />}
        </li>)}
    </ul>
  </>
}

function profileDraft(profile, channels) {
  const { defaults, limits } = profile
  const references = limits?.references ?? {}
  const channelId = channels.find(channel => channel.id === profile.channelId)?.id ??
    channels.find(channel => channel.protocol === profile.provider)?.id ?? channels[0]?.id
  return {
    id: profile.id,
    name: profile.name ?? '',
    channelId,
    model: profile.model ?? '',
    arkFamily: profile.arkFamily ?? '',
    modes: profile.modes?.length ? profile.modes : profile.mode ? [profile.mode] : ['t2v'],
    inputField: profile.inputField ?? '',
    options: profile.options ? JSON.stringify(profile.options, null, 2) : '',
    duration: String(defaults?.duration ?? profile.duration ?? ''),
    resolution: defaults?.resolution ?? '',
    aspectRatio: defaults?.aspectRatio || profile.aspectRatio || '',
    generateAudio: defaults?.generateAudio == null ? '' : String(defaults.generateAudio),
    durations: limits?.durations?.join(', ') ?? '',
    durationMin: String(limits?.durationMin ?? ''),
    durationMax: String(limits?.durationMax ?? ''),
    resolutions: limits?.resolutions?.join(', ') ?? '',
    aspectRatios: limits?.aspectRatios?.join(', ') ?? '',
    allowAudio: limits?.generateAudio ?? false,
    lastFrame: limits?.lastFrame ?? false,
    maxReferences: String(limits?.maxReferences ?? ''),
    imageReferences: String(references.image ?? ''),
    videoReferences: String(references.video ?? ''),
    audioReferences: String(references.audio ?? ''),
  }
}

function allowedModes(channel) {
  return (channel?.modes ?? Object.keys(modes)).filter(mode =>
    Object.hasOwn(modes, mode) && (mode !== 't2i' || channel?.protocol === 'replicate'))
}

function modelPayload(form, protocol) {
  if (!form.channelId) throw new Error('请选择绑定渠道。')
  if (!form.modes.length) throw new Error('请选择至少一种生成方式。')
  const durations = optionList(form.durations).map(Number)
  if (durations.some(value => !Number.isInteger(value) || value < 1)) throw new Error('可用时长应为正整数，用逗号分隔。')
  let options
  if (['ark', 'byteplus', 'replicate'].includes(protocol) && form.options.trim()) {
    options = JSON.parse(form.options)
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('模型扩展参数必须为 JSON 对象。')
  }
  const references = form.modes.includes('r2v') ? {
    image: optionalNumber(form.imageReferences),
    video: optionalNumber(form.videoReferences),
    audio: optionalNumber(form.audioReferences),
  } : form.modes.includes('t2i') && form.inputField.trim() ? {
    image: optionalNumber(form.imageReferences),
  } : undefined
  return {
    id: form.id,
    name: form.name.trim(),
    channelId: form.channelId,
    model: form.model.trim(),
    arkFamily: ['ark', 'byteplus'].includes(protocol) ? form.arkFamily || undefined : undefined,
    modes: form.modes,
    inputField: protocol === 'replicate' ? form.inputField.trim() || undefined : undefined,
    options,
    defaults: {
      duration: optionalNumber(form.duration),
      resolution: form.resolution.trim() || undefined,
      aspectRatio: form.aspectRatio.trim() || undefined,
      generateAudio: form.allowAudio && form.generateAudio !== '' ? form.generateAudio === 'true' : undefined,
    },
    limits: {
      durations: durations.length ? durations : undefined,
      durationMin: optionalNumber(form.durationMin),
      durationMax: optionalNumber(form.durationMax),
      resolutions: optionList(form.resolutions),
      aspectRatios: optionList(form.aspectRatios),
      generateAudio: form.allowAudio,
      lastFrame: form.modes.includes('i2v') && form.lastFrame,
      references,
      maxReferences: references ? optionalNumber(form.maxReferences) : undefined,
    },
  }
}

function ModelForm({ original, channels, busy, onSave, onCancel, onError }) {
  const [form, setForm] = useState(() => profileDraft(original, channels))
  const channel = channels.find(channel => channel.id === form.channelId)
  const protocol = channel?.protocol
  const ark = protocol === 'ark' || protocol === 'byteplus'
  const legacy = ark || protocol === 'replicate'
  const change = (key, value) => setForm(current => ({ ...current, [key]: value }))
  const field = (label, key, props) => <Field label={label} value={form[key]} disabled={busy}
    onChange={value => change(key, value)} {...props} />
  const capabilities = allowedModes(channel)

  function selectChannel(channelId) {
    const supported = allowedModes(channels.find(item => item.id === channelId))
    setForm(current => ({ ...current, channelId, modes: current.modes.filter(mode => supported.includes(mode)) }))
  }

  function selectMode(mode, checked) {
    if (!checked) change('modes', form.modes.filter(value => value !== mode))
    else if (mode === 't2i') change('modes', [mode])
    else change('modes', [...form.modes.filter(value => value !== 't2i'), mode])
  }

  function save(event) {
    event.preventDefault()
    try {
      void onSave(modelPayload(form, protocol))
    } catch (error) {
      onError(error.message)
    }
  }

  return <form className="drama-provider-form" onSubmit={save}>
    <div className="drama-provider-fields">
      {field('预设名称', 'name', { required: true })}
      {field('API Model ID', 'model', { required: true })}
      <ChoiceField label="绑定渠道" value={form.channelId} disabled={busy}
        items={channels.map(channel => ({ id: channel.id, label: channel.name }))}
        onChange={selectChannel} />
    </div>
    <fieldset className="drama-provider-modes">
      <legend>支持的生成方式</legend>
      <div className="drama-provider-actions">
        {capabilities.map(mode => <Checkbox key={mode} label={modes[mode]}
          checked={form.modes.includes(mode)} disabled={busy}
          onChange={checked => selectMode(mode, checked)} />)}
      </div>
    </fieldset>
    <details className="drama-provider-details">
      <summary>模型默认参数</summary>
      <div className="drama-provider-fields">
        {field('模型默认时长（秒）', 'duration', { type: 'number', min: legacy ? -1 : 1, max: 3600, placeholder: '继承生成设置' })}
        {field('模型默认分辨率', 'resolution', { placeholder: '继承生成设置' })}
        {field('模型默认画幅', 'aspectRatio', { placeholder: '继承生成设置' })}
        {form.allowAudio && <ChoiceField label="默认生成音频" value={form.generateAudio} disabled={busy}
          items={items({ '': '使用模型默认值', true: '开启', false: '关闭' })}
          onChange={value => change('generateAudio', value)} />}
      </div>
    </details>
    <details className="drama-provider-details" open={form.modes.includes('r2v') || undefined}>
      <summary>模型参数范围</summary>
      <div className="drama-provider-fields">
        {field('可用时长（秒）', 'durations', { placeholder: '5, 10, 15' })}
        {field('最短时长（秒）', 'durationMin', { type: 'number', min: 1, max: 3600 })}
        {field('最长时长（秒）', 'durationMax', { type: 'number', min: 1, max: 3600 })}
        {field('可用分辨率', 'resolutions', { placeholder: '720p, 1080p' })}
        {field('可用画幅', 'aspectRatios', { placeholder: '16:9, 9:16' })}
      </div>
      <div className="drama-provider-actions">
        <Checkbox label="支持生成音频" checked={form.allowAudio} onChange={value => change('allowAudio', value)} disabled={busy} />
        {form.modes.includes('i2v') && <Checkbox label="支持尾帧" checked={form.lastFrame}
          onChange={value => change('lastFrame', value)} disabled={busy} />}
      </div>
      {form.modes.includes('r2v') && <div className="drama-provider-fields">
        {field('最多参考图片', 'imageReferences', { type: 'number', min: 0, max: 32, placeholder: '0' })}
        {field('最多参考视频', 'videoReferences', { type: 'number', min: 0, max: 32, placeholder: '0' })}
        {field('最多参考音频', 'audioReferences', { type: 'number', min: 0, max: 32, placeholder: '0' })}
        {field('参考素材总数上限', 'maxReferences', { type: 'number', min: 1, max: 32, placeholder: '按各类型上限' })}
      </div>}
    </details>
    {legacy && <details className="drama-provider-details">
      <summary>供应商扩展参数</summary>
      {ark && <ChoiceField label="端点部署模型系列" value={form.arkFamily} disabled={busy}
        items={items({ '': '匹配已知模型 ID，否则使用通用配置',
          'seedance-1.0': 'Seedance 1.0', 'seedance-2.0': 'Seedance 2.0', 'seedance-2.5': 'Seedance 2.5' })}
        onChange={value => change('arkFamily', value)} />}
      {protocol === 'replicate' && form.modes.some(mode => ['i2v', 'r2v'].includes(mode)) &&
        field('模型图片输入字段', 'inputField', { required: true })}
      {protocol === 'replicate' && form.modes.includes('t2i') && <div className="drama-provider-fields">
        {field('模型参考图输入字段', 'inputField', { placeholder: '纯文生图留空' })}
        {form.inputField.trim() && field('最多参考图片', 'imageReferences', { type: 'number', min: 1, max: 32, placeholder: '1' })}
      </div>}
      <div className="drama-provider-field">
        <label>模型扩展参数<textarea value={form.options} disabled={busy} rows={3}
          placeholder={'{ "steps": 4 }'} onChange={event => change('options', event.target.value)} /></label>
      </div>
    </details>}
    <FormActions busy={busy} onCancel={onCancel} label="保存预设" />
  </form>
}

function Models({ data, busy, run, clearFeedback, setError }) {
  const [draft, setDraft] = useState(null)
  const [removing, setRemoving] = useState(null)
  const { profiles = [], channels = [], generation, revision } = data
  const templates = (data.templates ?? []).filter(template => channels.some(channel =>
    channel.id === template.channelId || channel.protocol === template.provider))
  const edit = value => {
    setDraft(value)
    setRemoving(null)
    clearFeedback()
  }
  const channelName = profile => channels.find(channel => channel.id === profile.channelId)?.name ??
    protocols[profile.provider] ?? '渠道不可用'

  return draft ? <ModelForm original={draft} channels={channels} busy={busy} onCancel={() => edit(null)} onError={setError}
    onSave={async profile => {
      if (await run('provider_save', { profile, revision }, '预设已保存')) setDraft(null)
    }} /> : <>
    <div className="drama-provider-actions">
      <Button size="sm" variant="primary" disabled={busy || !channels.length} onClick={() => edit({})}>新建预设</Button>
      {templates.length > 0 && <Choice label="从模板创建" disabled={busy}
        items={templates.map((template, index) => ({
          id: String(index), label: (protocols[template.provider] ?? channelName(template)) + ' · ' + template.name,
        }))}
        onChange={value => edit(templates[Number(value)])} />}
    </div>
    {!channels.length && <p>请先添加视频渠道。</p>}
    <ul className="drama-provider-list">
      {profiles.map(profile => <li key={profile.id}>
        <div className="drama-provider-row">
          <div>
            <strong>{profile.name}</strong>
            {generation?.defaultModelId === profile.id && <Tag className="drama-provider-default">默认</Tag>}
            <small>{channelName(profile)} · {profile.model}</small>
            <small>{(profile.modes ?? [profile.mode]).filter(Boolean).map(mode => mode.toUpperCase()).join(' / ')}</small>
          </div>
          <div className="drama-provider-actions">
            <Button size="sm" disabled={busy} onClick={() => edit(profile)}>编辑预设</Button>
            <Button size="sm" disabled={busy} onClick={() => { clearFeedback(); setRemoving(profile.id) }}>删除预设</Button>
          </div>
        </div>
        {removing === profile.id && <Removal name={profile.name} busy={busy} onCancel={() => setRemoving(null)}
          onRemove={async () => {
            if (await run('provider_remove', { id: profile.id, revision }, '预设已删除')) setRemoving(null)
          }} />}
      </li>)}
    </ul>
  </>
}

function GenerationSettings({ data, busy, run }) {
  const { generation = {}, profiles = [], revision } = data
  const [form, setForm] = useState(() => ({
    defaultModelId: generation.defaultModelId ?? '',
    duration: String(generation.duration ?? ''),
    resolution: generation.resolution ?? '',
    aspectRatio: generation.aspectRatio ?? '',
    maxConcurrent: String(generation.maxConcurrent ?? 2),
    outputDirectory: generation.outputDirectory ?? 'assets/videos',
  }))
  const videoModels = profiles.filter(profile => (profile.modes ?? [profile.mode]).some(mode => mode && mode !== 't2i'))
  const change = (key, value) => setForm(current => ({ ...current, [key]: value }))
  const field = (label, key, props) => <Field label={label} value={form[key]} disabled={busy}
    onChange={value => change(key, value)} {...props} />

  function save(event) {
    event.preventDefault()
    void run('generation_save', {
      revision,
      generation: {
        ...form,
        duration: optionalNumber(form.duration),
        maxConcurrent: Number(form.maxConcurrent),
      },
    }, '生成设置已保存')
  }

  return <form className="drama-provider-form" onSubmit={save}>
    <ChoiceField label="默认视频模型" value={form.defaultModelId} disabled={busy}
      items={[{ id: '', label: '按节点选择' }, ...videoModels.map(profile => ({ id: profile.id, label: profile.name }))]}
      onChange={value => change('defaultModelId', value)} />
    <div className="drama-provider-fields">
      {field('默认时长（秒）', 'duration', { type: 'number', min: 1, placeholder: '由模型决定' })}
      {field('默认分辨率', 'resolution', { placeholder: '由模型决定' })}
      {field('默认画幅', 'aspectRatio', { placeholder: '由模型决定' })}
      {field('最大并发数', 'maxConcurrent', { type: 'number', min: 1, max: 32, required: true })}
    </div>
    {field('结果保存目录', 'outputDirectory', { required: true, help: '相对于当前项目目录，须位于 assets 下。' })}
    <FormActions busy={busy} label="保存生成设置" />
  </form>
}

export function ProviderSettings() {
  const id = useId()
  const [tab, setTab] = useState('channels')
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [load, reload] = useState(0)
  const entries = items(tabs).map(({ id: key, label }) => ({
    value: key, label, id: id + '-' + key, panelId: id + '-panel-' + key,
  }))
  const active = entries.find(item => item.value === tab)

  useEffect(() => {
    const controller = new AbortController()
    providerRequest('provider_settings', {}, controller.signal).then(result => {
      if (!controller.signal.aborted) setData(result)
    }).catch(failure => {
      if (!controller.signal.aborted) setError(failure.message)
    })
    return () => controller.abort()
  }, [load])

  const clearFeedback = () => { setMessage(''); setError('') }
  async function run(action, input, success) {
    setBusy(true)
    clearFeedback()
    try {
      const result = await providerRequest(action, input)
      if (success) {
        setData(result)
        notifyProviderSettings()
        setMessage(success)
      } else if (action === 'channel_test') {
        setData(current => ({
          ...current,
          channels: current.channels.map(channel => channel.id === input.id ? { ...channel, verification: result } : channel),
        }))
      }
      return result
    } catch (failure) {
      setError(failure.message)
      return null
    } finally {
      setBusy(false)
    }
  }

  const props = { data, busy, run, clearFeedback, setError }
  return <section className="drama-provider-panel" aria-label="Drama Studio" data-testid="drama-settings">
    <style>{style}</style>
    <SegmentedTabs items={entries} value={tab} label="Drama Studio 设置" onChange={next => {
      if (!busy) { clearFeedback(); setTab(next) }
    }} />
    {error && <p className="drama-provider-error" role="alert">{error}</p>}
    {message && <p className="drama-provider-success" role="status">{message}</p>}
    {!data && !error && <p role="status">正在加载设置…</p>}
    {!data && error && <Button size="sm" onClick={() => { clearFeedback(); reload(value => value + 1) }}>重试</Button>}
    {data && <div className="drama-provider-content" id={active.panelId} role="tabpanel" aria-labelledby={active.id}>
      {tab === 'channels' && <Channels {...props} />}
      {tab === 'models' && <Models {...props} />}
      {tab === 'generation' && <GenerationSettings {...props} />}
    </div>}
  </section>
}
