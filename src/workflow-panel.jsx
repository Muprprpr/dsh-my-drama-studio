import React, { useEffect, useRef, useState } from 'react'
import { Button, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { nodeLabels, nodeTitle } from './canvas-node.jsx'
import { mediaURL, operation, subscribe } from './studio-api.js'
import style from './workflow-panel.css'

const generationStage = 'video-generation'
const finalStage = 'final-review'
const statuses = {
  not_started: ['未开始', 'idle'],
  running: ['运行中', 'ongoing'],
  review: ['待验收', 'warning'],
  approved: ['已确认', 'done'],
  failed: ['失败', 'error'],
  stale: ['产物已过期', 'warning'],
}

const isActive = stage => stage.pending || stage.status === 'running'
const filesReady = stage => stage?.files?.harnessReady && stage.files.skillReady
const canAdvance = stage => stage && stage.id !== generationStage && stage.status === 'not_started'
  && !stage.pending && filesReady(stage)

function statusFor(stage, current) {
  if (stage.pending) return ['正在启动', 'ongoing']
  if (stage.needsReview) return ['产物已更新，待复审', 'warning']
  if (!['not_started', 'failed', 'stale'].includes(stage.status)) return statuses[stage.status]
  if (current) {
    if (stage.generation?.state === 'processing') return ['视频生成中', 'ongoing']
    if (stage.generation?.state === 'failed') return ['视频任务失败', 'error']
    if (stage.generation?.state === 'waiting') return ['待独立授权', 'warning']
    if (stage.status === 'not_started' && stage.files && !filesReady(stage)) return ['全局配置缺失', 'warning']
  }
  return statuses[stage.status]
}

async function readCanvasNodes(ticket, ids, signal) {
  return Object.fromEntries(await Promise.all(ids.map(async id => {
    const { nodes } = await operation(ticket, 'query', { id, limit: 1 }, signal)
    return [id, nodes.find(node => node.id === id) ?? null]
  })))
}

function useCanvasNodes(ticket, refs, changes, connected) {
  const [loaded, setLoaded] = useState(null)
  const ids = JSON.stringify([...new Set(refs.map(ref => ref.id))])

  useEffect(() => {
    const requested = JSON.parse(ids)
    if (!connected || !requested.length) return
    const controller = new AbortController()
    readCanvasNodes(ticket, requested, controller.signal).then(nodes => {
      if (!controller.signal.aborted) setLoaded({ ids, changes, nodes })
    }).catch(error => {
      if (!controller.signal.aborted) setLoaded({ ids, changes, error: error.message })
    })
    return () => controller.abort()
  }, [ticket, ids, changes, connected])

  return connected && loaded?.ids === ids && loaded.changes === changes ? loaded : null
}

export function WorkflowProgress({ session, workspaceTitle, useSessions, refreshSession, openCanvas }) {
  const { ticket, status } = session
  const { sessionId, workspaceId, connected, eventSeq } = status
  const [view, setView] = useState(null)
  const [detailId, showDetails] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [reload, setReload] = useState(0)
  const [changes, setChanges] = useState(0)
  const action = useRef(false)
  const epoch = useRef(0)
  const steps = useRef(null)

  useEffect(() => {
    const controller = new AbortController()
    const generation = epoch.current
    operation(ticket, 'workflow_get', {}, controller.signal).then(result => {
      if (!controller.signal.aborted && generation === epoch.current) {
        setView(result)
        setLoadError('')
      }
    }).catch(failure => {
      if (!controller.signal.aborted && generation === epoch.current) setLoadError(failure.message)
    })
    return () => controller.abort()
  }, [ticket, reload])

  useEffect(() => {
    if (!connected) return
    const controller = new AbortController()
    subscribe(ticket, eventSeq, controller.signal, batch => {
      if (!batch.events) return
      const types = new Set(batch.events.map(event => event.type))
      if (!types.size || types.has('append') || types.has('update')) {
        setChanges(value => value + 1)
        setReload(value => value + 1)
      } else if (types.has('workflow') || types.has('task')) {
        setReload(value => value + 1)
      }
      if (types.has('binding')) refreshSession()
    }, failure => {
      setLoadError(failure.message)
      refreshSession()
    })
    return () => controller.abort()
  }, [ticket, connected, eventSeq, refreshSession])

  const stages = view?.stages ?? []
  const current = stages.find(isActive) ?? stages.find(stage => stage.status !== 'approved' || stage.needsReview)
  const currentIndex = current ? stages.indexOf(current) : -1
  const next = current ? stages[currentIndex + 1] : null
  const detail = stages.find(stage => stage.id === detailId)
  const active = Boolean(current && isActive(current))
  const activeSessionId = active ? current.sessionId : undefined
  const activeSessionTitle = useSessions(state => activeSessionId ? state.byId[activeSessionId]?.displayTitle : undefined)
  const detailSessionTitle = useSessions(state => detail?.sessionId ? state.byId[detail.sessionId]?.displayTitle : undefined)
  const needsFileCheck = [current, next, detail].some(stage => stage?.files && !filesReady(stage))
  const awaitingProgress = !connected || needsFileCheck || Boolean(current?.pending) || current?.generation?.state === 'processing'
  const reviewRefs = current?.status === 'review' ? current.outputs ?? [] : []
  const review = useCanvasNodes(ticket, reviewRefs, changes, connected)
  const invalidReview = current?.needsRerun || review?.nodes && reviewRefs.some(ref => {
    const node = review.nodes[ref.id]
    return !node || node.deleted || current?.id === generationStage && node.revision !== ref.revision
  })
  const generationNeedsCanvas = current?.id === generationStage && current.generation?.state !== 'ready'
  const working = busy || active

  useEffect(() => {
    function refresh() {
      if (document.visibilityState === 'visible') setReload(value => value + 1)
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    const timer = awaitingProgress ? setInterval(refresh, 5000) : null
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
      if (timer !== null) clearInterval(timer)
    }
  }, [awaitingProgress])

  useEffect(() => {
    const list = steps.current
    const chip = list?.querySelector('[aria-current="step"]')
    if (!chip) return
    const bar = list.getBoundingClientRect()
    const item = chip.getBoundingClientRect()
    if (item.left < bar.left) list.scrollLeft += item.left - bar.left
    if (item.right > bar.right) list.scrollLeft += item.right - bar.right
  }, [current?.id])

  const mutate = (name, data) => operation(ticket, name, { ...data, operationId: crypto.randomUUID() })

  async function connect() {
    if (connected) return
    await mutate('bind', {})
    refreshSession()
  }

  async function run(work) {
    if (action.current) return
    action.current = true
    epoch.current += 1
    setBusy(true)
    setError('')
    try {
      await work()
    } catch (failure) {
      setError(failure.message)
    } finally {
      epoch.current += 1
      action.current = false
      setBusy(false)
      setReload(value => value + 1)
    }
  }

  function select(id) {
    showDetails(id)
    setReload(value => value + 1)
  }

  function accept(result) {
    epoch.current += 1
    setView(previous => ({
      ...result,
      stages: result.stages.map(stage => ({
        ...stage,
        files: stage.files ?? previous?.stages.find(item => item.id === stage.id)?.files,
      })),
    }))
  }

  async function start(snapshot, stage, predecessor) {
    await mutate('workflow_start', {
      stageId: stage.id, revision: snapshot.revision, expectedRunId: stage.runId,
      previousApproval: predecessor?.approvalId,
    })
  }

  const startCurrent = () => run(async () => {
    await connect()
    await start(view, current, stages[currentIndex - 1])
  })

  const approveCurrent = () => run(async () => {
    await connect()
    const nodes = review?.nodes ?? await readCanvasNodes(ticket, reviewRefs.map(ref => ref.id))
    const outputs = reviewRefs.map(({ id, revision }) => {
      const node = nodes[id]
      if (!node || node.deleted) throw new Error('阶段产物已不可用，请在画布中检查。')
      if (current.id === generationStage && node.revision !== revision) throw new Error('视频成片已变化，请重新核对生成结果。')
      return { id, revision: node.revision }
    })
    const result = await mutate('workflow_approve', { stageId: current.id, runId: current.runId, outputs })
    accept(result)
    if (!canAdvance(next)) return

    try {
      const latest = await operation(ticket, 'workflow_get')
      accept(latest)
      const index = latest.stages.findIndex(stage => stage.id === current.id)
      const upcoming = latest.stages[index + 1]
      if (upcoming?.id !== next.id || !canAdvance(upcoming)) return
      await start(latest, upcoming, latest.stages[index])
    } catch (failure) {
      throw new Error('当前阶段已确认。下一阶段启动失败。' + failure.message)
    }
  })

  const reopen = stage => run(async () => {
    await connect()
    accept(await mutate('workflow_return', { stageId: stage.id, runId: stage.runId }))
    showDetails('')
  })

  const showCanvas = () => run(async () => {
    await connect()
    showDetails('')
    openCanvas()
  })

  let primary
  if (current) {
    const generationCanvasLabel = current.generation?.state === 'waiting' ? '打开画布生成视频' : '打开画布检查任务'
    if (active || current.generation?.state === 'processing' && !['review', 'approved'].includes(current.status)) {
      primary = { label: current.pending ? '正在启动' + current.name + '…' : '正在执行' + current.name + '…', disabled: true }
    } else if (current.needsReview) {
      primary = { label: '重新验收', invoke: () => reopen(current) }
    } else if (invalidReview) {
      primary = generationNeedsCanvas
        ? { label: generationCanvasLabel, invoke: showCanvas }
        : { label: '重试当前阶段', invoke: startCurrent, disabled: !filesReady(current) }
    } else if (current.status === 'review') {
      const reviewable = reviewRefs.length > 0
        && (!connected || reviewRefs.every(({ id }) => review?.nodes?.[id] && !review.nodes[id].deleted))
      primary = {
        label: current.id === finalStage ? '验收影片' : canAdvance(next)
          ? '确认' + current.name + '，开始' + next.name : '确认' + current.name,
        invoke: approveCurrent,
        disabled: !reviewable,
      }
    } else if (generationNeedsCanvas) {
      primary = { label: generationCanvasLabel, invoke: showCanvas }
    } else {
      primary = {
        label: current.status === 'failed' ? '重试当前阶段'
          : current.status === 'stale' ? '重新执行' + current.name
          : current.id === generationStage ? '核对生成结果' : '开始' + current.name,
        invoke: startCurrent,
        disabled: !filesReady(current),
      }
    }
  }
  const reviewError = invalidReview && (generationNeedsCanvas ? '成片已不可用，请打开画布检查。'
    : '当前产物已删除或版本已变化，请重新执行此阶段。')
  const alert = error || loadError || current?.error || review?.error || reviewError
  const feedback = alert || current?.generation?.message
  const projectLabel = workspaceTitle || workspaceId

  return <section className="drama-workflow-progress" aria-label="短剧生产进度"
    data-testid="drama-workflow" data-session-id={sessionId} data-workspace-id={workspaceId}>
    <style>{style}</style>
    {!view && !loadError && <p role="status">正在读取生产进度…</p>}
    {view && <>
      <ol ref={steps} className="drama-workflow-steps" aria-label="工作流阶段">
        {stages.map(stage => {
          const [label, state] = statusFor(stage, stage.id === current?.id)
          return <li key={stage.id}>
            <button type="button" data-stage-id={stage.id} aria-current={stage.id === current?.id ? 'step' : undefined}
              aria-label={stage.name + '，' + label} title={stage.name + ' · ' + label}
              onClick={() => select(stage.id)}>
              <StateDot state={state} size={8} />
              <span>{stage.name}</span>
            </button>
          </li>
        })}
      </ol>
      <div className="drama-workflow-command">
        <div className="drama-workflow-current" role="status" data-testid="drama-workflow-current"
          data-stage-id={current?.id} data-status={current?.status ?? 'approved'}>
          <span className="drama-workflow-identity" title={projectLabel}>项目 {projectLabel}</span>
          <strong>{current ? current.name : view.name}</strong>
          <span className="drama-workflow-state">{current ? statusFor(current, true)[0] : '全部阶段已验收'}</span>
          {activeSessionId && <span className="drama-workflow-identity" title={activeSessionId}
            data-testid="drama-workflow-executor" data-session-id={activeSessionId}>
            {activeSessionId === sessionId ? '本会话执行' : '执行会话 ' + (activeSessionTitle || activeSessionId)}
          </span>}
        </div>
        {current?.files && !filesReady(current) && <Button type="button" size="sm" onClick={() => select(current.id)}>查看缺失路径</Button>}
        {current?.id === finalStage && current.status === 'review'
          && <Button type="button" size="sm" onClick={() => select(current.id)}>查看成片</Button>}
        {primary && <Button type="button" size="sm" variant="primary" data-testid="drama-workflow-action"
          disabled={busy || primary.disabled} onClick={primary.invoke}>{primary.label}</Button>}
      </div>
    </>}
    {feedback && <div className="drama-workflow-feedback">
      <p role={alert ? 'alert' : 'status'}>{feedback}</p>
      {(loadError || review?.error) && <Button type="button" size="sm" onClick={() => {
        setReload(value => value + 1)
        setChanges(value => value + 1)
      }}>重新读取</Button>}
    </div>}
    {detail && <StageDetails stage={detail} current={detail.id === current?.id} ticket={ticket} changes={changes} connected={connected}
      definitionVersion={view.revision} executionTitle={detailSessionTitle}
      busy={working} awaitingBind={busy} connect={() => run(connect)}
      close={() => showDetails('')} openCanvas={showCanvas} reopen={() => reopen(detail)} />}
  </section>
}

function StageDetails({ stage, current, ticket, changes, connected, definitionVersion, executionTitle,
  busy, awaitingBind, connect, close, openCanvas, reopen }) {
  const inputs = stage.inputs ?? []
  const outputs = stage.outputs ?? []
  const refs = useCanvasNodes(ticket, [...inputs, ...outputs], changes, connected)
  const [label, state] = statusFor(stage, current)
  const showInputs = stage.id === finalStage || stage.id === generationStage

  return <Modal open title={stage.name} closeLabel="关闭阶段详情" onClose={close} backdropBlur={false}
    footer={<>
      {stage.status === 'approved' && stage.runId && <Button type="button" size="sm" disabled={busy} onClick={reopen}>重新验收</Button>}
      <Button type="button" size="sm" onClick={openCanvas}>打开画布</Button>
    </>}>
    <section className="drama-workflow-details" aria-label={stage.name + '详情'}>
      <p className="drama-workflow-detail-status"><StateDot state={state} size={8} />{label}</p>
      {stage.error && <p role="alert">{stage.error}</p>}
      {stage.generation?.message && <p>{stage.generation.message}</p>}
      {stage.files && <details open={!filesReady(stage)}>
        <summary>全局能力文件</summary>
        <dl className="drama-workflow-metadata">
          <dt>当前定义版本</dt><dd>{definitionVersion}</dd>
          <dt>Skill {stage.files.skillReady ? '已就绪' : '未就绪'}</dt><dd><code>{stage.files.skillPath}</code></dd>
          <dt>Harness {stage.files.harnessReady ? '已就绪' : '未就绪'}</dt><dd><code>{stage.files.harnessPath}</code></dd>
        </dl>
        {stage.files.issues?.map(issue => <p key={issue}>{issue}</p>)}
      </details>}
      {stage.runId && <details>
        <summary>最近一次执行</summary>
        <dl className="drama-workflow-metadata">
          <dt>运行</dt><dd><code>{stage.runId}</code></dd>
          <dt>执行会话</dt><dd>{executionTitle && executionTitle !== stage.sessionId ? executionTitle + ' · ' : ''}
            <code>{stage.sessionId}</code></dd>
          {stage.workspaceId && <><dt>Workspace ID</dt><dd><code>{stage.workspaceId}</code></dd></>}
          {stage.canvasId && <><dt>Canvas ID</dt><dd><code>{stage.canvasId}</code></dd></>}
          <dt>运行定义版本</dt><dd>{stage.definitionVersion ?? '未记录'}</dd>
          {stage.skillId && <><dt>运行 Skill</dt><dd><code>{stage.skillId}</code></dd></>}
          {stage.harnessSha256 && stage.harness && <><dt>运行 Harness</dt><dd><code>{stage.harness}</code></dd></>}
          <dt>Skill SHA-256</dt><dd>{stage.skillSha256 ? <code>{stage.skillSha256}</code> : '未记录'}</dd>
          <dt>Harness SHA-256</dt><dd>{stage.harnessSha256 ? <code>{stage.harnessSha256}</code> : '未记录'}</dd>
          {stage.startedAt && <><dt>开始</dt><dd>{new Date(stage.startedAt).toLocaleString()}</dd></>}
          {stage.finishedAt && <><dt>结束</dt><dd>{new Date(stage.finishedAt).toLocaleString()}</dd></>}
        </dl>
        {stage.approvals?.length > 0 && <ul>
          {stage.approvals.map(approval => <li key={approval.id}>
            {new Date(approval.at).toLocaleString()} · {approval.sessionId || '自动确认'} · {approval.outputs.map(ref => ref.revision).join('、')}
          </li>)}
        </ul>}
      </details>}
      {!connected && inputs.length + outputs.length > 0 && <div>
        <Button type="button" size="sm" disabled={awaitingBind} onClick={connect}>连接查看产物</Button>
      </div>}
      {inputs.length > 0 && <details open={showInputs}>
        <summary>输入产物（{inputs.length}）</summary>
        {inputs.map(ref => <Output key={ref.id} reference={ref} node={refs?.nodes?.[ref.id]} ticket={ticket} />)}
      </details>}
      {outputs.length > 0 && <details open>
        <summary>阶段产物（{outputs.length}）</summary>
        {refs?.error && <p role="alert">{refs.error}</p>}
        {outputs.map(ref => <Output key={ref.id} reference={ref} node={refs?.nodes?.[ref.id]} ticket={ticket} />)}
      </details>}
    </section>
  </Modal>
}

function Output({ reference, node, ticket }) {
  const available = node && !node.deleted
  const { id, revision } = reference
  const title = available ? nodeTitle(node) || nodeLabels[node.type] : id
  const source = available && mediaURL(ticket, node)
  const content = available && [node.content.text, node.content.description, node.content.prompt]
    .find(value => typeof value === 'string' && value.trim())
  return <div className="drama-workflow-output">
    <strong>{title}</strong> <span>记录版本 {revision}</span>
    {available && node.revision !== revision && <p>画布当前为版本 {node.revision}。</p>}
    {(node === null || node?.deleted) && <p>该节点当前不可用。</p>}
    {source && node.type === 'image' && <img src={source} alt={title} />}
    {source && node.type === 'video' && <video src={source} controls playsInline preload="metadata" aria-label={title} />}
    {source && node.type === 'audio' && <audio src={source} controls preload="metadata" aria-label={title} />}
    {content && <pre>{content}</pre>}
  </div>
}
