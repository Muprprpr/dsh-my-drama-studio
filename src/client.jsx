import React, { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { CanvasViewport } from './canvas.jsx'
import { ProviderSettings } from './provider-settings.jsx'
import {
  Button, IconChevronDownOutlineRegular, IconEllipsisOutlineRegular, IconPanelLeftOutlineRegular,
  IconSettingsOutlineRegular, Menu, MenuItemButton, StateDot, Switch, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import shellStyle from './studio-shell.css'
import { initialize, mediaURL, operation, providerRequest, subscribe } from './studio-api.js'

const kind = 'drama-canvas'
const tabId = 'dsh-my-drama-studio.canvas'
const statusChanges = new EventTarget()

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
  const [filters, setFilters] = useState({})
  const [providerData, setProviderData] = useState(null)
  const [providerError, setProviderError] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState('')
  const ticket = session?.ticket
  const connected = session?.status.connected
  const workspaceTitle = useWorkspaces(snapshot => snapshot.items.find(item => item.workspaceId === session?.status.workspaceId)?.title)
  const queryCanvas = useCallback((query, signal) => operation(ticket, 'query', query, signal), [ticket])
  const closeMore = useCallback(() => setMoreOpen(false), [])
  const openProviderSettings = useCallback(() => {
    setMoreOpen(false)
    setSettingsOpen(true)
  }, [])

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
    if (!visible) return
    const controller = new AbortController()
    providerRequest('provider_settings', {}, controller.signal).then(result => {
      if (!controller.signal.aborted) { setProviderData(result); setProviderError('') }
    }).catch(failure => {
      if (!controller.signal.aborted) setProviderError(failure.message)
    })
    return () => controller.abort()
  }, [visible, settingsOpen])

  async function append(data) {
    const result = await operation(ticket, 'append', { ...data, operationId: crypto.randomUUID() })
    setRevision(value => value + 1)
    return result
  }

  async function submitGeneration(node, profileId) {
    const result = await operation(ticket, 'submit_manual', {
      operationId: crypto.randomUUID(), nodeId: node.id, profileId, confirmed: true,
    })
    setRevision(value => value + 1)
    return result
  }

  useEffect(() => {
    if (!visible) {
      setMoreOpen(false)
      setSettingsOpen(false)
    }
  }, [visible])

  const snapshot = view?.ticket === ticket && view?.result.status.canvasId === session?.status.canvasId
    ? view?.result : null
  const status = snapshot?.status ?? session?.status
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
      <Menu open={visible && moreOpen} onClose={closeMore} portal compact align="end"
        anchor={<Tooltip portal side="bottom" label="画布更多">
          <Button size="sm" className="drama-shell-more" aria-label="画布更多" aria-haspopup="menu"
            aria-expanded={visible && moreOpen} onClick={() => setMoreOpen(value => !value)}>
            <IconEllipsisOutlineRegular />
          </Button>
        </Tooltip>}
        items={[{ id: 'settings', label: '生成服务设置', icon: <IconSettingsOutlineRegular /> }]}
        onSelect={openProviderSettings} />
    </header>
    <div className="drama-shell-body">
      {connected && snapshot ? <CanvasViewport snapshot={snapshot} filters={filters}
        setFilters={setFilters} append={append} mediaURL={node => mediaURL(ticket, node)}
        generationProfiles={providerData?.profiles ?? []} queryCanvas={queryCanvas}
        submitGeneration={submitGeneration} openProviderSettings={openProviderSettings} />
        : !issue && <p className="drama-shell-empty">{session && !connected ? '从输入栏连接项目画布' : '正在读取画布…'}</p>}
      {issue && <p role="alert" className="drama-shell-error">{issue}</p>}
    </div>
    {settingsOpen && visible && <ProviderSettings data={providerData} error={providerError}
      close={() => setSettingsOpen(false)} update={setProviderData} />}
  </section>
}
