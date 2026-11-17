import React, { useEffect, useId, useState } from 'react'
import { Button, IconSettingsOutlineRegular, Input, Modal, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { operation } from './studio-api.js'

const aspectOptions = [
  { value: '', label: '暂不指定', frame: 'default' },
  { value: '16:9', label: '横屏 16:9', frame: 'landscape' },
  { value: '9:16', label: '竖屏 9:16', frame: 'portrait' },
]

function productionSummary(settings) {
  if (!settings) return ''
  const { aspectRatio, targetDurationSeconds } = settings.productionSpec
  return [
    aspectRatio || '画幅未设置',
    targetDurationSeconds ? targetDurationSeconds + ' 秒' : '时长未设',
  ].join(' · ')
}

export function ProductionSettings({ ticket, workspaceTitle, onSaved, onDisconnect }) {
  const summaryId = useId()
  const [open, setOpen] = useState(false)
  const [settings, setSettings] = useState(null)
  const [draft, setDraft] = useState(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [refresh, setRefresh] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setError('')
    operation(ticket, 'production_settings_get', {}, controller.signal).then(result => {
      if (controller.signal.aborted) return
      setSettings(result)
      if (open) {
        setDraft({
          aspectRatio: result.productionSpec.aspectRatio,
          duration: String(result.productionSpec.targetDurationSeconds ?? ''),
        })
      }
    }).catch(failure => {
      if (!controller.signal.aborted) setError(failure.message)
    })
    return () => controller.abort()
  }, [ticket, open, refresh])

  const duration = draft?.duration ? Number(draft.duration) : null
  const dirty = draft && (draft.aspectRatio !== settings.productionSpec.aspectRatio ||
    duration !== settings.productionSpec.targetDurationSeconds)

  async function save(data, label) {
    if (pending) return
    setPending(true)
    setError('')
    setNotice('')
    try {
      const result = await operation(ticket, 'production_settings_save', { operationId: crypto.randomUUID(), ...data })
      setSettings(result)
      onSaved()
      if (data.productionSpec || !dirty) {
        setDraft({
          aspectRatio: result.productionSpec.aspectRatio,
          duration: String(result.productionSpec.targetDurationSeconds ?? ''),
        })
      }
      setNotice(data.productionSpec ? '制作规格已保存。' : label)
    } catch (failure) {
      setError(failure.message)
    } finally {
      setPending(false)
    }
  }

  async function disconnect() {
    setPending(true)
    setError('')
    try {
      await onDisconnect()
      setOpen(false)
    } catch (failure) {
      setError(failure.message)
    } finally {
      setPending(false)
    }
  }

  return <>
    <Button aria-label="制作设置" aria-haspopup="dialog" aria-expanded={open} size="sm"
      aria-describedby={settings ? summaryId : undefined}
      className="drama-production-entry" icon={<IconSettingsOutlineRegular size={14} />}
      onClick={() => { setDraft(null); setNotice(''); setOpen(true) }}>
      制作设置
      {settings && <span id={summaryId} className="drama-production-summary" data-testid="drama-production-summary">
        {productionSummary(settings)}
      </span>}
    </Button>
    {open && <Modal open title="制作设置" description={workspaceTitle} closeLabel="关闭制作设置"
      onClose={() => { if (!pending) setOpen(false) }}
      className="drama-production-dialog" contentClassName="drama-production-scroll">
      {error && <p className="drama-production-error" role="alert">{error}</p>}
      {!draft && (error ? <Button size="sm" onClick={() => setRefresh(value => value + 1)}>重新读取</Button>
        : <p role="status">正在读取制作设置…</p>)}
      {draft && <div className="drama-production-settings">
        <form onSubmit={event => {
          event.preventDefault()
          if (dirty) void save({ productionSpec: { aspectRatio: draft.aspectRatio, targetDurationSeconds: duration } })
        }}>
          <h3>制作规格</h3>
          <fieldset disabled={pending} className="drama-production-aspects">
            <legend>成片画幅</legend>
            <div className="drama-production-options">
              {aspectOptions.map(({ value, label, frame }) => <label key={value} className="drama-production-option">
                <input type="radio" name="production-aspect" value={value} checked={draft.aspectRatio === value}
                  onChange={() => setDraft(current => ({ ...current, aspectRatio: value }))} />
                <span><i aria-hidden="true" data-frame={frame} />{label}</span>
              </label>)}
            </div>
          </fieldset>
          <label className="drama-production-duration">
            目标成片时长（秒）
            <Input type="number" min={1} step={1} placeholder="留空则不指定" value={draft.duration}
              disabled={pending} onChange={event => {
                const { value } = event.target
                setDraft(current => ({ ...current, duration: value }))
              }} />
          </label>
          <p className="drama-production-help">成片时长用于整片规划。单段视频时长在节点中设置。规格变更从下一轮生效，已有阶段成果可能需要重核。</p>
          <Button type="submit" variant="primary" size="sm" disabled={pending || !dirty}>保存制作规格</Button>
        </form>
        <section className="drama-production-execution">
          <h3>生成执行设置</h3>
          <div className="drama-production-switch">
            <div><span>自动执行生成</span><small>仅限当前会话</small></div>
            <Switch label="自动执行生成" checked={settings.autoGenerate} disabled={pending}
              onChange={enabled => { void save({ autoGenerate: enabled }, enabled ? '已开启自动生成。' : '已关闭自动生成。') }} />
          </div>
          <p className="drama-production-help">工作流生成沿用画布授权，只在当前部署及授权范围内创建任务。关闭后停止自动入队，已有任务继续执行，可在生成任务中取消。</p>
        </section>
        {notice && <p className="drama-production-notice" role="status">{notice}</p>}
        {onDisconnect && <Button size="sm" variant="ghost" disabled={pending}
          onClick={() => { void disconnect() }}>断开当前会话画布</Button>}
      </div>}
    </Modal>}
  </>
}
