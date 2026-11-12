import React, { useState } from 'react'
import { Button, Checkbox, IconChevronDownOutlineRegular, Input, Menu, Modal, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import { providerRequest } from './studio-api.js'
import style from './provider-settings.css'

export const providerNames = { ark: '火山方舟', byteplus: 'BytePlus ModelArk', replicate: 'Replicate' }
const modeNames = { t2i: 'T2I · 文生图', t2v: 'T2V · 文生视频', i2v: 'I2V · 首帧生视频', r2v: 'R2V · 参考图生视频' }

export function generationMode(node) {
  if (node.type === 'image') return 't2i'
  if (node.content.mode) return node.content.mode
  const count = node.content.mixedListOrder?.length ?? 0
  return count === 0 ? 't2v' : count === 1 ? 'i2v' : 'r2v'
}

export function generationLabel(mode) {
  return modeNames[mode] ?? mode
}

function initialProfile() {
  return { name: '', provider: 'ark', mode: 't2v', model: '', inputField: '', aspectRatio: '', duration: '', options: '' }
}

function draftProfile(profile) {
  return { ...initialProfile(), ...profile, options: profile.options ? JSON.stringify(profile.options, null, 2) : '' }
}

function Choice({ label, value, items, onChange, disabled }) {
  const [open, setOpen] = useState(false)
  return <Menu open={!disabled && open} portal compact onClose={() => setOpen(false)}
    anchor={<Button variant="outline" size="sm" aria-label={label} aria-haspopup="menu" aria-expanded={!disabled && open}
      disabled={disabled} className="drama-provider-choice" onClick={() => setOpen(current => !current)}>
      <span>{items.find(item => item.id === value)?.label || label}</span>
      <IconChevronDownOutlineRegular size={12} />
    </Button>}
    items={items} selectedId={value} onSelect={next => {
      setOpen(false)
      onChange(next)
    }} />
}

export function ProviderSettings({ data, error: loadError, close, update }) {
  const [form, setForm] = useState(null)
  const [apiKey, setApiKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [error, setError] = useState('')
  const profiles = data?.profiles ?? []

  function openForm(profile) {
    setForm(draftProfile(profile))
    setConfirmRemove(false)
    setApiKey('')
    setClearKey(false)
    setError('')
    setMessage('')
  }

  function change(field, value) {
    setForm(current => ({ ...current, [field]: value }))
  }

  async function run(action, input, success) {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const result = await providerRequest(action, input)
      if (action !== 'provider_test') {
        update(result)
        setForm(null)
        setApiKey('')
        setClearKey(false)
      }
      setMessage(success)
    } catch (failure) {
      setError(failure.message)
    } finally {
      setBusy(false)
    }
  }

  function save(event) {
    event.preventDefault()
    let options
    try {
      if (form.options.trim()) {
        options = JSON.parse(form.options)
        if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error()
      }
    } catch {
      setError('模型参数需要有效的 JSON 对象。')
      return
    }
    const { id, name, provider, mode, model, inputField, aspectRatio, duration } = form
    run('provider_save', {
      profile: { id, name, provider, mode, model,
        inputField: provider === 'replicate' && (mode === 'i2v' || mode === 'r2v') ? inputField : undefined,
        aspectRatio, duration: duration ? Number(duration) : 0, options },
      apiKey: clearKey ? '' : apiKey.trim() || undefined,
      makeDefault: Boolean(form.default),
    }, '预设已保存')
  }

  const providerItems = Object.entries(providerNames).map(([id, label]) => ({ id, label }))
  const modeItems = Object.entries(modeNames).filter(([id]) => id !== 't2i' || form?.provider === 'replicate')
    .map(([id, label]) => ({ id, label }))
  const keyPresent = profiles.some(p => p.provider === form?.provider && p.configured)
  return <Modal open onClose={close} title="生成服务设置" closeLabel="关闭设置"
    className="drama-provider-dialog" contentClassName="drama-provider-scroll">
    <style>{style}</style>
    <div className="drama-provider-panel">
      {(error || loadError) && <p className="drama-provider-error" role="alert">{error || loadError}</p>}
      {message && <p role="status">{message}</p>}
      {!data && !loadError && <p>正在加载预设…</p>}
      {data && !form && <>
        <div className="drama-provider-actions">
          <Button size="sm" disabled={busy} variant="primary" onClick={() => openForm()}>新建预设</Button>
          <Choice label="从模板创建" disabled={busy}
            items={data.templates.map((template, index) => ({
              id: String(index), label: providerNames[template.provider] + ' · ' + template.name,
            }))}
            onChange={value => openForm(data.templates[Number(value)])} />
        </div>
        {!profiles.length && <p>选择模板，填写 API 密钥后保存。每种生成方式可指定默认预设。</p>}
        <ul className="drama-provider-list">
          {profiles.map(profile => <li key={profile.id}>
            <div><strong>{profile.name}</strong>
              {profile.default && <Pill className="drama-provider-default">默认</Pill>}
              <small>{providerNames[profile.provider]} · {generationLabel(profile.mode)}</small>
              <small>{profile.model} · {profile.configured ? '已保存密钥' : '缺少密钥'}</small>
            </div>
            <div className="drama-provider-actions">
              <Button size="sm" disabled={busy} onClick={() => openForm(profile)}>编辑</Button>
              <Button size="sm" disabled={busy || !profile.configured}
                onClick={() => run('provider_test', { provider: profile.provider }, '凭据通过只读检查')}>测试密钥</Button>
            </div>
          </li>)}
        </ul>
      </>}
      {form && <form className="drama-provider-form" onSubmit={save}>
        <label>预设名称<Input required value={form.name} onChange={event => change('name', event.target.value)} /></label>
        <div className="drama-provider-fields">
          <div className="drama-provider-field">
            <span>供应商</span>
            <Choice label="供应商" disabled={Boolean(form.id)} value={form.provider} items={providerItems}
              onChange={provider => {
                setForm(current => ({ ...current, provider,
                  mode: current.mode === 't2i' && provider !== 'replicate' ? 't2v' : current.mode, inputField: '',
                }))
                setApiKey('')
                setClearKey(false)
              }} />
          </div>
          <div className="drama-provider-field">
            <span>生成方式</span>
            <Choice label="生成方式" disabled={Boolean(form.id)} value={form.mode} items={modeItems}
              onChange={value => change('mode', value)} />
          </div>
        </div>
        <label>模型 ID<Input required value={form.model} onChange={event => change('model', event.target.value)} /></label>
        {form.provider === 'replicate' && ['i2v', 'r2v'].includes(form.mode) &&
          <label>模型的图片输入字段<Input required value={form.inputField}
            onChange={event => change('inputField', event.target.value)} /></label>}
        <label>API 密钥<Input type="password" autoComplete="new-password" disabled={clearKey} value={apiKey}
          placeholder={keyPresent ? '已保存，留空保留' : '输入供应商密钥'}
          onChange={event => setApiKey(event.target.value)} />
          <small>同一供应商的预设共用密钥。</small>
        </label>
        {keyPresent && <Checkbox className="drama-provider-checkbox" label="移除该供应商的密钥"
          checked={clearKey} onChange={setClearKey} />}
        <Checkbox className="drama-provider-checkbox" label="设为该生成方式的默认预设"
          checked={Boolean(form.default)} onChange={value => change('default', value)} />
        <details>
          <summary>模型参数</summary>
          <label>画面比例<Input placeholder="留空使用模型默认值" value={form.aspectRatio}
            onChange={event => change('aspectRatio', event.target.value)} /></label>
          {form.mode !== 't2i' && <label>时长（秒）
            <Input type="number" min={form.provider === 'replicate' ? 1 : -1} max="60" value={form.duration}
              placeholder="留空使用模型默认值" onChange={event => change('duration', event.target.value)} />
            {form.provider !== 'replicate' && <small>模型支持时填 -1，由模型决定时长。</small>}
          </label>}
          <label>模型文档中的其他参数<textarea rows={3} value={form.options}
            placeholder={'{ "resolution": "720p" }'} onChange={event => change('options', event.target.value)} /></label>
        </details>
        <div className="drama-provider-actions">
          <Button type="submit" variant="primary" size="sm" disabled={busy}>保存预设</Button>
          <Button size="sm" disabled={busy} onClick={() => setForm(null)}>取消编辑</Button>
          {form.id && !confirmRemove &&
            <Button size="sm" disabled={busy} onClick={() => setConfirmRemove(true)}>删除预设</Button>}
        </div>
        {confirmRemove && <div className="drama-provider-remove">
          <p>已提交的任务会保留。</p>
          <div className="drama-provider-actions">
            <Button size="sm" variant="outline" disabled={busy}
              onClick={() => run('provider_remove', { id: form.id }, '预设已删除')}>确认删除</Button>
            <Button size="sm" disabled={busy} onClick={() => setConfirmRemove(false)}>保留预设</Button>
          </div>
        </div>}
      </form>}
    </div>
  </Modal>
}
