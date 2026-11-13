import React, { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { CanvasViewport } from './canvas.jsx'
import { videoMode } from './canvas-node.jsx'
import { ProviderSettings, getProviderSettingsRevision, subscribeProviderSettings } from './provider-settings.jsx'
import {
  Button, IconChevronDownOutlineRegular, IconPanelLeftOutlineRegular, Menu, MenuItemButton, StateDot, Switch, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import shellStyle from './studio-shell.css'
import { generateT2V, generateI2V, generateR2V, generateV2V, initialize, mediaURL, operation, providerRequest, subscribe, uploadMedia } from './studio-api.js'

const kind = 'drama-canvas'
const tabId = 'dsh-my-drama-studio.canvas'
const statusChanges = new EventTarget()
const videoGeneration = { t2v: generateT2V, i2v: generateI2V, r2v: generateR2V, v2v: generateV2V }

export const inject = ['slots', 'sidebarRight', 'sidebarRightTabs', 'locale']

export function apply(ctx) {
  const sidebar = ctx.sidebarRight
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.dramaStudioShell = ''
    style.textContent = shellStyle
    document.head.append(style)
    return () => style.remove()
  })
  ctx.effect(() => ctx.locale.register('dramaStudio', {
    en: { name: 'My Drama Studio' },
    zh: { name: '短剧工作台' },
  }))
  ctx.effect(() => ctx.sidebarRightTabs.register({ id: tabId, kind, title: () => 'Drama Canvas' }))
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () =>
    ctx.slots.register({ name: 'sidebar.right.pane.tab', key: tabId, locale: 'dramaStudio' }, DramaCanvasTab)))
  ctx.effect(() => ctx.slots.inject('conversation.input.left', () =>
    ctx.slots.register({ name: 'conversation.input.left', id: 'drama-session-control' },
      ({ sessionId, useWorkspaces }) => <SessionCanvasControl key={sessionId} sessionId={sessionId}
        sidebar={sidebar} useWorkspaces={useWorkspaces} />)))
  ctx.effect(() => ctx.slots.inject('settings.section', () =>
    ctx.slots.register({ name: 'settings.section', id: 'drama-studio', order: 60, label: 'Drama Studio' }, ProviderSettings)))
}

function notify(sessionId) {
  statusChanges.dispatchEvent(new CustomEvent('changed', { detail: sessionId }))
}

function useStudioSession(sessionId, active) {
  const [session, setSession] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    let latest = 0
    async function refresh() {
      const requestId = ++latest
      try {
        const result = await initialize(sessionId, controller.signal)
        if (!controller.signal.aborted && latest === requestId) {
          setSession(result)
          setError('')
        }
      } catch (failure) {
        if (!controller.signal.aborted && latest === requestId) {
          setSession(null)
          setError(failure.message)
        }
      }
    }
    const changed = event => {
      if (event.detail === sessionId) refresh()
    }
    refresh()
    statusChanges.addEventListener('changed', changed)
    return () => {
      controller.abort()
      statusChanges.removeEventListener('changed', changed)
    }
  }, [sessionId, active])
  return { session, error }
}

function SessionCanvasControl({ sessionId, sidebar, useWorkspaces }) {
  const active = useSyncExternalStore(listener => sidebar.mounted.subscribe(listener),
    () => sidebar.mounted.getSnapshot() === sessionId)
  const { session, error: sessionError } = useStudioSession(sessionId, active)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const closeMenu = useCallback(() => setMenuOpen(false), [])
  const workspaceTitle = useWorkspaces(snapshot => snapshot.items.find(item => item.workspaceId === session?.status.workspaceId)?.title)

  async function run(action, enabled) {
    setPending(true)
    setError('')
    try {
      const captured = await initialize(sessionId)
      if (action === 'disconnect') {
        await operation(captured.ticket, 'disconnect', { operationId: crypto.randomUUID() })
        notify(sessionId)
        return
      }
      if (action === 'permission') {
        await operation(captured.ticket, 'permission', {
          operationId: crypto.randomUUID(), enabled,
        })
        notify(sessionId)
        return
      }
      if (!captured.status.connected) {
        await operation(captured.ticket, 'bind', { operationId: crypto.randomUUID() })
        notify(sessionId)
      }
      if (sidebar.mounted.getSnapshot() !== sessionId) return
      const existing = sidebar.tabsIn(sessionId).find(tab => tab.kind === kind)
      if (existing) {
        if (!sidebar.isExpanded()) sidebar.toggleExpanded()
        sidebar.focus(existing.id)
      } else {
        sidebar.openTab(kind)
      }
    } catch (failure) {
      setError(failure.message)
    } finally {
      setPending(false)
    }
  }

  const connected = session?.status.connected
  const automatic = session?.status.autoGenerate === true
  const mode = connected ? automatic ? '自动' : '手动' : ''
  const issue = error || sessionError
  return <span className="drama-entry">
    <Menu open={active && menuOpen} onClose={closeMenu} side="top" portal compact
      listClassName="drama-entry-menu"
      anchor={<span className="drama-entry-split">
        <Tooltip portal side="top" label={connected ? '打开项目画布' : '连接并打开项目画布'}>
          <Button aria-label="Drama" size="sm" disabled={pending} className="drama-entry-main"
            onClick={() => { closeMenu(); void run('open') }}>
            Drama{connected && <span className="drama-entry-mode" data-testid="drama-permission"> · {mode}</span>}
          </Button>
        </Tooltip>
        <Tooltip portal side="top" label="Drama 设置">
          <Button size="sm" aria-label="Drama 设置" aria-haspopup="menu" aria-expanded={active && menuOpen}
            className="drama-entry-caret" onClick={() => setMenuOpen(value => !value)}>
            <IconChevronDownOutlineRegular size={12} />
          </Button>
        </Tooltip>
      </span>}
      items={[{ id: 'workspace', type: 'label', text: workspaceTitle || '项目画布' }]}>
      <MenuItemButton disabled={pending} icon={<IconPanelLeftOutlineRegular />}
        onSelect={() => { closeMenu(); void run('open') }}>打开项目画布</MenuItemButton>
      <div className="drama-entry-permission" role="presentation">
        <div>
          <span>自动执行生成</span>
          <small>{!connected ? '连接后可授权' : automatic ? 'Agent 可以提交生成任务' : '仅允许手动确认生成'}</small>
        </div>
        <Switch label="自动执行生成" checked={automatic} disabled={!connected || pending}
          onChange={next => { void run('permission', next) }} />
      </div>
      {connected && <MenuItemButton danger separatorBefore disabled={pending}
        onSelect={() => { closeMenu(); void run('disconnect') }}>断开当前会话</MenuItemButton>}
    </Menu>
    {issue && <span role="alert" className="drama-entry-error" title={issue}>{issue}</span>}
  </span>
}

function DramaCanvasTab({ sessionId, useTabInfo, useWorkspaces, t }) {
  const { tab } = useTabInfo()
  return <SessionPanel key={sessionId} sessionId={sessionId} visible={tab.visible}
    useWorkspaces={useWorkspaces} title={t('name')} />
}

function SessionPanel({ sessionId, visible, title, useWorkspaces }) {
  const { session, error: sessionError } = useStudioSession(sessionId, visible)
  const [view, setView] = useState(null)
  const [activity, setActivity] = useState(null)
  const [filters, setFilters] = useState({})
  const [providerData, setProviderData] = useState(null)
  const [providerError, setProviderError] = useState('')
  const settingsRevision = useSyncExternalStore(subscribeProviderSettings, getProviderSettingsRevision)
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState('')
  const ticket = session?.ticket
  const connected = session?.status.connected
  const workspaceTitle = useWorkspaces(snapshot => snapshot.items.find(item => item.workspaceId === session?.status.workspaceId)?.title)
  const queryCanvas = useCallback((query, signal) => operation(ticket, 'query', query, signal), [ticket])

  useEffect(() => {
    if (!visible || !connected) return
    const controller = new AbortController()
    Promise.all([
      operation(ticket, 'query', filters, controller.signal),
      operation(ticket, 'tasks', {}, controller.signal),
    ]).then(([result, taskResult]) => {
      result.tasks = taskResult.tasks
      if (!controller.signal.aborted) {
        setView({ ticket, result })
        setError('')
      }
    }).catch(failure => {
      if (!controller.signal.aborted) setError(failure.message)
    })
    return () => controller.abort()
  }, [ticket, connected, visible, filters, revision])

  useEffect(() => {
    if (!visible || !connected) return
    const controller = new AbortController()
    subscribe(ticket, session.status.eventSeq, controller.signal, batch => {
      if (typeof batch.aiRunning === 'boolean') {
        setActivity({ ticket, running: batch.aiRunning, nodeIds: batch.agentLockedNodeIds ?? [] })
        return
      }
      if (!batch.events.length || batch.events.some(event => event.type === 'binding' || event.type === 'permission')) {
        notify(sessionId)
      }
      setRevision(value => value + 1)
    }, failure => {
      setError(failure.message)
      notify(sessionId)
    })
    return () => controller.abort()
  }, [ticket, connected, visible, sessionId])

  useEffect(() => {
    if (!visible || !connected) return
    const controller = new AbortController()
    providerRequest('provider_settings', {}, controller.signal).then(result => {
      if (!controller.signal.aborted) { setProviderData(result); setProviderError('') }
    }).catch(failure => {
      if (!controller.signal.aborted) setProviderError(failure.message)
    })
    return () => controller.abort()
  }, [visible, connected, settingsRevision])

  async function append(data) {
    const result = await operation(ticket, 'append', { ...data, operationId: crypto.randomUUID() })
    setRevision(value => value + 1)
    return result
  }

  async function mutate(action, data) {
    try {
      const result = await operation(ticket, action, { ...data, operationId: crypto.randomUUID() })
      setRevision(value => value + 1)
      return result
    } catch (failure) {
      if (failure.status === 409) {
        setRevision(value => value + 1)
        throw new Error('画布内容已变化。请先查看最新内容，再决定如何保存。', { cause: failure })
      }
      throw failure
    }
  }

  async function submitGeneration(node, profileId) {
    const request = {
      operationId: crypto.randomUUID(), nodeId: node.id, profileId, confirmed: true,
    }
    const result = node.type === 'video'
      ? await videoGeneration[videoMode(node)](ticket, request)
      : await operation(ticket, 'submit_manual', request)
    setRevision(value => value + 1)
    return result
  }

  async function changeTask(action, taskId) {
    await operation(ticket, action, { operationId: crypto.randomUUID(), taskId })
    setRevision(value => value + 1)
  }

  const snapshot = view?.ticket === ticket && view?.result.status.canvasId === session?.status.canvasId
    ? view?.result : null
  const status = snapshot?.status ?? session?.status
  const aiRunning = activity?.ticket === ticket ? activity?.running : status?.aiRunning
  const agentLockedNodeIds = activity && activity.ticket === ticket ? activity.nodeIds : status?.agentLockedNodeIds
  const issue = error || sessionError
  return <section className="drama-shell" data-testid="drama-canvas" data-session-id={sessionId}
    data-workspace-id={session?.status.workspaceId} data-canvas-id={session?.status.canvasId ?? undefined}>
    <header className="drama-shell-header">
      <div className="drama-shell-heading">
        <strong>{title}</strong>
        {workspaceTitle && <span className="drama-shell-workspace" title={workspaceTitle}>{workspaceTitle}</span>}
      </div>
      {connected && <span className="drama-shell-connected" title={`${status.connectedSessions} 个会话已连接`}>
        <StateDot state="done" size={7} />{status.connectedSessions} 个会话
      </span>}
      {connected && aiRunning === true && <span className="drama-shell-connected drama-shell-activity"
        role="status" title="正在保护本轮使用的节点和依赖">AI 工作中</span>}
    </header>
    <div className="drama-shell-body">
      {connected && snapshot ? <CanvasViewport key={status.canvasId + ':' + sessionId} snapshot={snapshot} filters={filters}
        setFilters={setFilters} append={append} mutate={mutate} agentLockedNodeIds={agentLockedNodeIds}
        uploadFile={(type, file) => uploadMedia(ticket, type, file)}
        mediaURL={node => mediaURL(ticket, node)}
        generationProfiles={providerData?.profiles ?? []} generationDefaults={providerData?.generation}
        queryCanvas={queryCanvas} submitGeneration={submitGeneration} changeTask={changeTask} />
        : !issue && <p className="drama-shell-empty">{session && !connected ? '从输入栏连接项目画布' : '正在读取画布…'}</p>}
      {issue && <p role="alert" className="drama-shell-error">{issue}</p>}
      {providerError && <p role="alert" className="drama-shell-error">{providerError}</p>}
    </div>
  </section>
}
