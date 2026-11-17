import React, { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { CanvasViewport } from './canvas.jsx'
import { videoMode } from './canvas-node.jsx'
import { ProviderSettings, protocols } from './provider-settings.jsx'
import { ProductionSettings } from './production-settings.jsx'
import { SkillsLibrary, WorkflowSkillBindings } from './skill-settings.jsx'
import { installWorkflowStyle, WorkflowArtifacts, WorkflowProgress } from './workflow-panel.jsx'
import {
  Button, StateDot, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import shellStyle from './studio-shell.css'
import { generateT2V, generateI2V, generateR2V, generateV2V, initialize, mediaURL, operation, providerRequest, subscribe, uploadMedia } from './studio-api.js'

const canvasKind = 'drama-canvas'
const canvasTabId = 'dsh-my-drama-studio.canvas'
const artifactsKind = 'drama-workflow-artifacts'
const artifactsTabId = 'dsh-my-drama-studio.artifacts'
const statusChanges = new EventTarget()
const canvasDrafts = new WeakMap()
const videoGeneration = { t2v: generateT2V, i2v: generateI2V, r2v: generateR2V, v2v: generateV2V }

export const inject = ['slots', 'sidebarRight', 'sidebarRightTabs', 'locale', 'uiWorkspace']

export function apply(ctx) {
  const sidebar = ctx.sidebarRight
  ctx.effect(installWorkflowStyle)
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
  ctx.effect(() => ctx.sidebarRightTabs.register({ id: canvasTabId, kind: canvasKind, title: () => 'Drama Canvas' }))
  ctx.effect(() => ctx.sidebarRightTabs.register({ id: artifactsTabId, kind: artifactsKind, title: () => '阶段产物' }))
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () =>
    ctx.slots.register({ name: 'sidebar.right.pane.tab', key: canvasTabId, locale: 'dramaStudio' }, DramaCanvasTab)))
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () =>
    ctx.slots.register({ name: 'sidebar.right.pane.tab', key: artifactsTabId },
      ({ sessionId, useTabInfo, useWorkspaces, useSessions, useSessionStatus }) =>
        <DramaArtifactsTab key={sessionId} sessionId={sessionId} useTabInfo={useTabInfo}
          useWorkspaces={useWorkspaces} useSessions={useSessions} useSessionStatus={useSessionStatus} sidebar={sidebar} />)))
  ctx.effect(() => ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register({ name: 'conversation.input.dock', id: 'drama-workflow-progress' },
      ({ sessionId, useSessionStatus }) => <SessionWorkflowDock key={sessionId} sessionId={sessionId}
        useSessionStatus={useSessionStatus} sidebar={sidebar} />)))
  ctx.effect(() => ctx.slots.inject('conversation.input.left', () =>
    ctx.slots.register({ name: 'conversation.input.left', id: 'drama-session-control' },
      ({ sessionId, useWorkspaces }) => <SessionCanvasControl key={sessionId} sessionId={sessionId}
        sidebar={sidebar} useWorkspaces={useWorkspaces} />)))
  ctx.effect(() => ctx.slots.inject('settings.section', function* () {
    yield ctx.slots.register({ name: 'settings.section', id: 'drama-studio', order: 60, label: 'Drama Studio' }, ProviderSettings)
    yield ctx.slots.register({ name: 'settings.section', id: 'drama-skills', order: 61, label: 'Skills Library' },
      () => <SkillsLibrary pickDirectory={() => {
        const desktop = globalThis.__DSH_DIRECTORY_PICKER__
        return typeof desktop?.pick === 'function' ? desktop.pick() : ctx.uiWorkspace.pickDirectory()
      }} />)
    yield ctx.slots.register({ name: 'settings.section', id: 'drama-skill-bindings', order: 62,
      label: 'Workflow Skill Bindings' }, WorkflowSkillBindings)
  }))
}

function notify(sessionId) {
  statusChanges.dispatchEvent(new CustomEvent('changed', { detail: sessionId }))
}

function openStudioTab(sidebar, sessionId, kind) {
  if (sidebar.mounted.getSnapshot() !== sessionId) return
  const existing = sidebar.tabsIn(sessionId).find(tab => tab.kind === kind)
  if (existing) {
    if (!sidebar.isExpanded()) sidebar.toggleExpanded()
    sidebar.focus(existing.id)
  } else {
    sidebar.openTab(kind)
  }
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
  const workspaceTitle = useWorkspaces(snapshot => snapshot.items.find(item => item.workspaceId === session?.status.workspaceId)?.title)
  const refreshSession = useCallback(() => notify(sessionId), [sessionId])

  async function run(action) {
    setPending(true)
    setError('')
    try {
      const captured = await initialize(sessionId)
      if (action === 'disconnect') {
        await operation(captured.ticket, 'disconnect', { operationId: crypto.randomUUID() })
        notify(sessionId)
        return
      }
      if (!captured.status.connected) {
        await operation(captured.ticket, 'bind', { operationId: crypto.randomUUID() })
        notify(sessionId)
      }
      openStudioTab(sidebar, sessionId, canvasKind)
    } catch (failure) {
      if (action === 'disconnect') throw failure
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
    <Tooltip portal side="top" label={connected ? '打开项目画布' : '连接并打开项目画布'}>
      <Button aria-label="Drama" size="sm" disabled={pending} className="drama-entry-main"
        onClick={() => { void run('open') }}>
        Drama{connected && <span className="drama-entry-mode" data-testid="drama-permission"> · {mode}</span>}
      </Button>
    </Tooltip>
    {active && session?.status.workspaceId && <ProductionSettings key={session.ticket}
      ticket={session.ticket} workspaceTitle={workspaceTitle} onSaved={refreshSession}
      onDisconnect={connected ? () => run('disconnect') : undefined} />}
    {issue && <span role="alert" className="drama-entry-error" title={issue}>{issue}</span>}
  </span>
}

function DramaCanvasTab({ sessionId, useTabInfo, useWorkspaces, t }) {
  const { tab } = useTabInfo()
  return <SessionPanel key={sessionId} sessionId={sessionId} visible={tab.visible} tabSignal={tab.signal}
    useWorkspaces={useWorkspaces} title={t('name')} />
}

function textDraftsFor(signal, canvasId, sessionId) {
  const existing = canvasDrafts.get(signal)
  if (existing?.canvasId === canvasId && existing.sessionId === sessionId) return existing.drafts
  const drafts = new Map()
  canvasDrafts.set(signal, { canvasId, sessionId, drafts })
  return drafts
}

function DramaArtifactsTab({ sessionId, useTabInfo, useWorkspaces, useSessions, useSessionStatus, sidebar }) {
  const { tab } = useTabInfo()
  const { session, error } = useStudioSession(sessionId, tab.visible)
  const nativeRunning = useSessionStatus(snapshot => snapshot.get(sessionId)?.running === true)
  const workspaceTitle = useWorkspaces(snapshot => snapshot.items.find(
    item => item.workspaceId === session?.status.workspaceId,
  )?.title)
  const refreshSession = useCallback(() => notify(sessionId), [sessionId])
  if (!tab.visible) return null
  if (!session) return <p className="drama-artifacts-empty" role={error ? 'alert' : 'status'}>
    {error || '正在读取阶段产物…'}
  </p>
  return <WorkflowArtifacts key={session.ticket} session={session} workspaceTitle={workspaceTitle} nativeRunning={nativeRunning}
    useSessions={useSessions} refreshSession={refreshSession}
    openCanvas={() => openStudioTab(sidebar, sessionId, canvasKind)} />
}

function SessionWorkflowDock({ sessionId, useSessionStatus, sidebar }) {
  const active = useSyncExternalStore(listener => sidebar.mounted.subscribe(listener),
    () => sidebar.mounted.getSnapshot() === sessionId)
  const { session } = useStudioSession(sessionId, active)
  const nativeRunning = useSessionStatus(snapshot => snapshot.get(sessionId)?.running === true)
  const workspaceId = session?.status.workspaceId
  const refreshSession = useCallback(() => notify(sessionId), [sessionId])
  const ticket = session?.ticket
  useEffect(() => {
    if (!active || !ticket) return
    for (const tab of sidebar.tabsIn(sessionId)) {
      if (tab.kind === 'drama-workflow') sidebar.close(tab.id)
    }
  }, [active, sessionId, sidebar, ticket])
  if (!active || !workspaceId) return null
  return <WorkflowProgress key={ticket} session={session} refreshSession={refreshSession} nativeRunning={nativeRunning}
    openCanvas={() => openStudioTab(sidebar, sessionId, canvasKind)}
    openArtifacts={() => openStudioTab(sidebar, sessionId, artifactsKind)} />
}

function SessionPanel({ sessionId, visible, tabSignal, title, useWorkspaces }) {
  const { session, error: sessionError } = useStudioSession(sessionId, visible)
  const [view, setView] = useState(null)
  const [activity, setActivity] = useState(null)
  const [filters, setFilters] = useState({})
  const [providerData, setProviderData] = useState(null)
  const [providerError, setProviderError] = useState('')
  const [providerVersion, setProviderVersion] = useState()
  const [providerReload, setProviderReload] = useState(0)
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
        setActivity({ ticket, running: batch.aiRunning })
        if (typeof batch.providerVersion === 'string') setProviderVersion(batch.providerVersion)
        return
      }
      if (batch.events.length && batch.events.every(event => event.type === 'workflow')) return
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
  }, [visible, connected, providerVersion, providerReload])

  const generationProfiles = useMemo(() => {
    const channels = new Map((providerData?.channels ?? []).map(channel => [channel.id, channel]))
    return (providerData?.profiles ?? []).map(profile => {
      const channel = channels.get(profile.channelId)
      return channel ? { ...profile, channelLabel: `渠道 ${channel.name} · ${protocols[channel.protocol] ?? channel.protocol}` } : profile
    })
  }, [providerData])
  const providerSettingsReady = Boolean(providerData && !providerError &&
    (providerVersion === undefined || providerData.providerVersion === providerVersion))

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

  async function submitGeneration(node, profileId, providerVersion) {
    const request = {
      operationId: crypto.randomUUID(), nodeId: node.id, profileId, confirmed: true, providerVersion,
    }
    try {
      const result = node.type === 'video'
        ? await videoGeneration[videoMode(node)](ticket, request)
        : await operation(ticket, 'submit_manual', request)
      setRevision(value => value + 1)
      return result
    } catch (failure) {
      if (failure.status === 409) setProviderReload(value => value + 1)
      throw failure
    }
  }

  async function changeTask(action, taskId) {
    await operation(ticket, action, { operationId: crypto.randomUUID(), taskId })
    setRevision(value => value + 1)
  }

  const snapshot = view?.ticket === ticket && view?.result.status.canvasId === session?.status.canvasId
    ? view?.result : null
  const status = snapshot?.status ?? session?.status
  const aiRunning = activity?.ticket === ticket ? activity?.running : status?.aiRunning
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
        role="status" title="可以查看和新增节点或连线。AI 结束后可以修改或删除已有内容。">AI 工作中</span>}
    </header>
    <div className="drama-shell-body">
      {connected && snapshot ? <CanvasViewport key={status.canvasId + ':' + sessionId} snapshot={snapshot} filters={filters}
        setFilters={setFilters} append={append} mutate={mutate} aiRunning={aiRunning}
        textDrafts={textDraftsFor(tabSignal, status.canvasId, sessionId)}
        uploadFile={(type, file) => uploadMedia(ticket, type, file)}
        mediaURL={node => mediaURL(ticket, node)}
        generationProfiles={generationProfiles} generationDefaults={providerData?.generation}
        providerVersion={providerData?.providerVersion} providerSettingsReady={providerSettingsReady}
        queryCanvas={queryCanvas} submitGeneration={submitGeneration} changeTask={changeTask} />
        : !issue && <p className="drama-shell-empty">{session && !connected ? '从输入栏连接项目画布' : '正在读取画布…'}</p>}
      {issue && <p role="alert" className="drama-shell-error">{issue}</p>}
      {providerError && <p role="alert" className="drama-shell-error">{providerError}</p>}
    </div>
  </section>
}
