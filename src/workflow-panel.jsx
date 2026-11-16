import React, { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { Button, MarkdownText, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { artifactMediaURL, operation, subscribe } from './studio-api.js'
import style from './workflow-panel.css'

const finalStage = 'final-review'
const generationStage = 'video-generation'
const runningMessage = '当前阶段正在执行，请等待本轮完成后再切换。'
const stageStatuses = {
  not_started: ['未开始', 'idle'],
  draft_available: ['有草稿', 'warning'],
  handed_off: ['已交接', 'done'],
  stale: ['产物已过期', 'warning'],
}
const sessionStatuses = {
  normal: '普通聊天',
  active: '本会话已加载 Harness',
  running: '本会话 Agent 执行中',
  failed: '本会话执行失败',
}
const capabilityLabels = {
  ready: 'Ready', missing: 'Missing', 'user-modified': 'User Modified',
  'update-available': 'Update Available', 'user-owned': 'User Owned',
  conflict: 'Conflict', invalid: 'Invalid', blocked: 'Blocked', custom: 'Custom',
}
const markdownLabels = {
  code: {
    copyLabel: '复制', copiedLabel: '已复制',
    toolbarLabels: { codeLabel: '代码块', wrapLabel: '换行', unwrapLabel: '取消换行' },
  },
  footnotes: '脚注',
}

const workflowChange = new EventTarget()
const interactions = new Map()
const initialInteraction = Object.freeze({ choices: Object.freeze({}) })

function setInteraction(ticket, patch) {
  interactions.set(ticket, { ...(interactions.get(ticket) ?? initialInteraction), ...patch })
  workflowChange.dispatchEvent(new CustomEvent('interaction', { detail: ticket }))
}

function useInteraction(ticket) {
  return useSyncExternalStore(listener => {
    const changed = event => { if (event.detail === ticket) listener() }
    workflowChange.addEventListener('interaction', changed)
    return () => workflowChange.removeEventListener('interaction', changed)
  }, () => interactions.get(ticket) ?? initialInteraction)
}

function refreshWorkflow(ticket) {
  workflowChange.dispatchEvent(new CustomEvent('refresh', { detail: ticket }))
}

function useWorkflowView(session, refreshSession) {
  const { ticket, status: { connected, eventSeq } } = session
  const [view, setView] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    let requestId = 0
    async function refresh() {
      const id = ++requestId
      try {
        const result = await operation(ticket, 'workflow_get', {}, controller.signal)
        if (controller.signal.aborted || id !== requestId) return
        setView(result)
        setError('')
      } catch (failure) {
        if (!controller.signal.aborted && id === requestId) setError(failure.message)
      }
    }
    const changed = event => { if (event.detail === ticket) void refresh() }
    const visible = () => { if (document.visibilityState === 'visible') void refresh() }
    workflowChange.addEventListener('refresh', changed)
    window.addEventListener('focus', visible)
    document.addEventListener('visibilitychange', visible)
    const poll = !connected ? setInterval(visible, 4000) : null
    if (connected) {
      subscribe(ticket, eventSeq, controller.signal, batch => {
        if (!batch.events || batch.events.some(event => ['workflow', 'task', 'append', 'update', 'binding'].includes(event.type))) {
          void refresh()
        }
        if (batch.events?.some(event => event.type === 'binding')) refreshSession()
      }, failure => {
        setError(failure.message)
        refreshSession()
      })
    }
    void refresh()
    return () => {
      controller.abort()
      if (poll !== null) clearInterval(poll)
      workflowChange.removeEventListener('refresh', changed)
      window.removeEventListener('focus', visible)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [ticket, connected, eventSeq, refreshSession])
  return { view, error }
}

function mutate(ticket, action, data) {
  return operation(ticket, action, { ...data, operationId: crypto.randomUUID() })
}

async function runAction(ticket, action, work) {
  if (interactions.get(ticket)?.busy) return
  setInteraction(ticket, { busy: action, error: '' })
  try {
    await work()
  } catch (failure) {
    setInteraction(ticket, { error: failure.message })
  } finally {
    setInteraction(ticket, { busy: '' })
    refreshWorkflow(ticket)
  }
}

const artifactKey = artifact => JSON.stringify([artifact.artifactId, artifact.version])
const belongsTo = (artifact, stageId, sessionId) => artifact.stageId === stageId && artifact.sessionId === sessionId

function groupVersions(artifacts) {
  const grouped = new Map()
  for (const artifact of artifacts) {
    const group = grouped.get(artifact.artifactId) ?? []
    group.push(artifact)
    grouped.set(artifact.artifactId, group)
  }
  return [...grouped.values()].map(group => group.sort((a, b) => b.version - a.version))
}

function chosenVersion(choices, group) {
  return Object.hasOwn(choices, group[0].artifactId) ? choices[group[0].artifactId] : group[0].version
}

function selectedRefs(groups, choices) {
  return groups.flatMap(group => {
    const version = chosenVersion(choices, group)
    return version ? [{ artifactId: group[0].artifactId, version }] : []
  })
}

function CapabilityStatus({ capabilities, stages }) {
  if (!capabilities) return null
  const { ready, status, packageVersion, error } = capabilities
  const heading = 'Workflow Capabilities ' + capabilityLabels[status]
  const details = !ready || stages.some(({ files }) =>
    [files.skillAsset, files.harnessAsset, ...files.resourceAssets].some(asset => asset.status !== 'ready'))
  if (!details) return <p className="drama-workflow-capabilities" data-testid="drama-workflow-capabilities">{heading}</p>
  return <details className="drama-workflow-capabilities" data-testid="drama-workflow-capabilities">
    <summary>{heading}</summary>
    {error && <p role="alert">{error}</p>}
    {packageVersion && <p>内置资源 v{packageVersion}</p>}
    <ul>
      {stages.map(({ id, name, files }) => <li key={id}>
        <strong>{name}</strong>
        <p>Skill {files.skillName}{files.skillSource && ' · ' + files.skillSource} · {capabilityLabels[files.skillAsset.status]}</p>
        <CapabilityFile file={files.skillAsset} />
        {files.resourceAssets.map(resource => <React.Fragment key={resource.path}>
          <p>Skill 附属文件 · {capabilityLabels[resource.status]}</p>
          <CapabilityFile file={resource} />
        </React.Fragment>)}
        <p>Harness · {capabilityLabels[files.harnessAsset.status]}</p>
        <CapabilityFile file={files.harnessAsset} />
      </li>)}
    </ul>
  </details>
}

function CapabilityFile({ file }) {
  return <p>{file.path}{file.hash && <> · <code title={file.hash}>{file.hash}</code></>}
    {(file.error || file.note) && <><br />{file.error || file.note}</>}
  </p>
}

function ProfileSelection({ profiles, busy, onSelect }) {
  const group = useId()
  const [choice, setChoice] = useState('short-drama')
  const selected = profiles.find(profile => profile.id === choice) ?? profiles[0]
  if (!selected) return <p role="alert">当前没有可选的生产模式。</p>
  return <form className="drama-workflow-command" data-testid="drama-workflow-profile-picker" onSubmit={event => {
    event.preventDefault()
    onSelect(selected.id)
  }}>
    <fieldset className="drama-workflow-profile-options" disabled={busy}>
      <legend>选择此 Workspace 的生产模式</legend>
      {profiles.map(profile => <label key={profile.id}>
        <input type="radio" name={group} value={profile.id} checked={selected.id === profile.id}
          onChange={() => setChoice(profile.id)} />
        {profile.name}{profile.id === 'short-drama' && <span>推荐</span>}
      </label>)}
    </fieldset>
    <Button type="submit" size="sm" variant="primary" disabled={busy}>确认生产模式</Button>
  </form>
}

export function WorkflowProgress({ session, refreshSession, openArtifacts, openCanvas, nativeRunning }) {
  const { ticket, status: { sessionId, workspaceId } } = session
  const { view, error: loadError } = useWorkflowView(session, refreshSession)
  const interaction = useInteraction(ticket)
  const steps = useRef(null)
  const state = view?.session
  const stages = view?.stages ?? []
  const stage = stages.find(candidate => candidate.id === state?.activeStageId)
  const ownGroups = groupVersions((view?.artifacts ?? []).filter(artifact => belongsTo(artifact, stage?.id, sessionId)))
  const choices = interaction.choices[stage?.id] ?? {}
  const refs = selectedRefs(ownGroups, choices)
  const sessionStatus = stage && nativeRunning ? 'running' : state?.status
  const running = sessionStatus === 'running'
  const previewAllowed = !running && (stage?.id === generationStage
    ? stage.generation?.state === 'ready' : refs.length > 0)
  const review = interaction.review?.sourceStageId === stage?.id ? interaction.review : null

  useEffect(() => refreshWorkflow(ticket), [ticket, nativeRunning])

  useEffect(() => {
    const list = steps.current
    const chip = list?.querySelector('[aria-current="step"]')
    if (!chip) return
    const bar = list.getBoundingClientRect()
    const item = chip.getBoundingClientRect()
    if (item.left < bar.left) list.scrollLeft += item.left - bar.left
    if (item.right > bar.right) list.scrollLeft += item.right - bar.right
  }, [stage?.id])

  const activate = stageId => runAction(ticket, 'activate', async () => {
    await mutate(ticket, 'workflow_activate', { stageId })
    setInteraction(ticket, { stageId: stageId || stage?.id, review: null, selected: undefined, section: 'artifacts' })
    refreshSession()
  })

  const selectProfile = workflowProfileId => runAction(ticket, 'profile', async () => {
    await mutate(ticket, 'workflow_profile_select', { workflowProfileId })
    refreshSession()
  })

  const preview = () => runAction(ticket, 'preview', async () => {
    const result = await mutate(ticket, 'workflow_handoff_preview', {
      stageId: stage.id,
      ...(Object.keys(choices).length ? { artifacts: refs } : {}),
    })
    setInteraction(ticket, { review: result, stageId: stage.id })
    openArtifacts()
  })

  function browse() {
    if (stage?.id && !review) setInteraction(ticket, { stageId: stage.id })
    openArtifacts()
  }

  function showPreview() {
    setInteraction(ticket, { stageId: stage.id, dismissedReview: undefined })
    openArtifacts()
  }

  const retry = () => runAction(ticket, 'retry', async () => {
    await operation(ticket, 'workflow_handoff_retry', { handoffId: state.pendingHandoffId })
    refreshSession()
  })

  const feedback = interaction.error || state?.error || loadError
  return <section className="drama-workflow-progress" data-testid="drama-workflow"
    data-session-id={sessionId} data-workspace-id={workspaceId}
    data-workflow-profile-id={view?.workflowProfileId} aria-label="制作工作流">
    {view?.profileSelectionRequired ? <ProfileSelection profiles={view.availableProfiles ?? []}
      busy={Boolean(interaction.busy)} onSelect={workflowProfileId => void selectProfile(workflowProfileId)} />
      : stages.length > 0 ? <>
      <ol className="drama-workflow-steps" ref={steps}>
        {stages.map(candidate => {
          const [label, dot] = stageStatuses[candidate.status] ?? stageStatuses.not_started
          return <li key={candidate.id}>
            <button type="button" aria-current={stage?.id === candidate.id ? 'step' : undefined}
              data-status={candidate.status} title={candidate.name + ' · ' + label}
              disabled={Boolean(interaction.busy) || (running && stage?.id !== candidate.id)} onClick={() => {
                if (stage?.id !== candidate.id) void activate(candidate.id)
                else browse()
              }}>
              <StateDot state={dot} size={6} />{candidate.name}
            </button>
          </li>
        })}
      </ol>
      <div className="drama-workflow-command">
        <div className="drama-workflow-current" data-status={sessionStatus} data-active-stage-id={stage?.id}>
          <strong>{stage?.name ?? sessionStatuses.normal}</strong>
          {view.workflowProfileName && <span>{view.workflowProfileName}</span>}
          {stage && <span>{sessionStatuses[sessionStatus]}</span>}
          {stage && view.activeSkillId && <span className="drama-workflow-skill" data-testid="drama-active-skill">
            Skill · {view.activeSkillId}
          </span>}
        </div>
        <Button type="button" size="sm" onClick={browse}>阶段产物</Button>
        {stage && <Button type="button" size="sm" disabled={Boolean(interaction.busy) || running}
          onClick={() => void activate('')}>退出阶段</Button>}
        {state?.pendingHandoffId ? <Button type="button" size="sm" variant="primary"
          disabled={Boolean(interaction.busy) || running} onClick={retry}>启动交接后的任务</Button>
          : review ? <Button type="button" size="sm" variant="primary" onClick={showPreview}>查看交接预览</Button>
          : previewAllowed && <Button type="button" size="sm" variant="primary" data-testid="drama-workflow-action"
            disabled={Boolean(interaction.busy)} onClick={preview}>
            {stage.id === finalStage ? '生成成片验收包' : '生成交接预览'}
          </Button>}
      </div>
      <CapabilityStatus capabilities={view.capabilities} stages={stages} />
      {running && feedback !== runningMessage && <div className="drama-workflow-feedback">
        <p role="status">{runningMessage}</p>
      </div>}
      {stage?.generation?.message && <div className="drama-workflow-feedback">
        <p role="status">{stage.generation.message}</p>
        <Button type="button" size="sm" onClick={openCanvas}>打开画布</Button>
      </div>}
    </> : !feedback && <p role="status">正在读取工作流…</p>}
    {feedback && <div className="drama-workflow-feedback">
      <p role="alert">{feedback}</p>
      {loadError && <Button type="button" size="sm" onClick={() => refreshWorkflow(ticket)}>重新读取</Button>}
    </div>}
  </section>
}

export function WorkflowArtifacts({ session, workspaceTitle, useSessions, refreshSession, openCanvas, nativeRunning }) {
  const { ticket, status: { sessionId } } = session
  const { view, error: loadError } = useWorkflowView(session, refreshSession)
  const interaction = useInteraction(ticket)
  const [compare, setCompare] = useState(false)
  const stages = view?.stages ?? []
  const draftOrHandoffStage = view?.artifacts?.[0]?.stageId ?? view?.handoffs?.[0]?.sourceStageId
  const stageId = interaction.stageId ?? view?.session?.activeStageId ?? draftOrHandoffStage ?? stages[0]?.id
  const stage = stages.find(candidate => candidate.id === stageId)
  const groups = groupVersions((view?.artifacts ?? []).filter(artifact => artifact.stageId === stageId))
  const latest = groups.map(group => group[0])
  const handoffs = (view?.handoffs ?? []).filter(handoff => handoff.sourceStageId === stageId)
  const review = interaction.review?.sourceStageId === stageId ? interaction.review : null
  const versionGroup = groups.find(group => group[0].artifactId === interaction.selected?.artifactId) ?? groups[0]
  const current = versionGroup?.[0]
  const selected = versionGroup?.find(artifact => artifact.version === interaction.selected?.version) ?? current
  const selectedHandoff = handoffs.find(handoff => handoff.handoffId === interaction.handoffId) ?? handoffs[0]
  const choices = interaction.choices[stageId] ?? {}
  const isActiveStage = view?.session?.activeStageId === stageId
  const sessionTitles = useSessions(state => state.byId)
  const sessionLabel = id => id === sessionId ? '当前会话' : sessionTitles[id]?.displayTitle || id
  const stageLabel = id => stages.find(candidate => candidate.id === id)?.name ?? id
  const showReview = Boolean(review) && interaction.dismissedReview !== review?.handoffId
  const panel = showReview ? 'review' : interaction.section ?? 'artifacts'

  function chooseStage(id) {
    setInteraction(ticket, { stageId: id, selected: undefined, handoffId: undefined, section: 'artifacts' })
    setCompare(false)
  }

  function chooseArtifact(artifact, pinVersion = false) {
    setInteraction(ticket, { selected: { artifactId: artifact.artifactId, version: pinVersion ? artifact.version : undefined } })
    setCompare(false)
  }

  function chooseVersion(artifact, version) {
    setInteraction(ticket, {
      choices: { ...interaction.choices, [stageId]: { ...choices, [artifact.artifactId]: version } },
      review: null,
    })
  }

  async function confirm() {
    await runAction(ticket, 'confirm', async () => {
      const result = await mutate(ticket, 'workflow_handoff_confirm', { handoffId: review.handoffId })
      setInteraction(ticket, { review: null, section: 'handoffs', handoffId: result.handoff?.handoffId ?? review.handoffId })
      refreshSession()
    })
  }

  function showSection(next) {
    setInteraction(ticket, { section: next, dismissedReview: review?.handoffId })
  }

  return <section className="drama-artifacts" data-testid="drama-workflow-artifacts" data-session-id={sessionId}
    aria-label="阶段产物">
    <header className="drama-artifacts-heading">
      <div>
        <h2>阶段产物</h2>
        {workspaceTitle && <span className="drama-artifacts-workspace" title={workspaceTitle}>{workspaceTitle}</span>}
      </div>
      {stage && <label className="drama-artifacts-select">
        <span className="drama-visually-hidden">浏览阶段</span>
        <select value={stage.id} onChange={event => chooseStage(event.target.value)}>
          {stages.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
        </select>
      </label>}
    </header>
    {stage && <nav className="drama-artifact-tabs" aria-label="产物视图">
      <button type="button" aria-pressed={panel === 'artifacts'} onClick={() => showSection('artifacts')}>当前与历史版本</button>
      <button type="button" aria-pressed={panel === 'handoffs'} onClick={() => showSection('handoffs')}>交接记录</button>
      {review && <button type="button" aria-pressed={panel === 'review'}
        onClick={() => setInteraction(ticket, { dismissedReview: undefined })}>交接预览</button>}
    </nav>}
    <div className="drama-artifacts-body">
      {(interaction.error || loadError) && <p className="drama-artifacts-error" role="alert">{interaction.error || loadError}</p>}
      {!stage && !loadError && <p className="drama-artifacts-empty" role="status">正在读取阶段产物…</p>}
      {panel === 'review' && <section className="drama-handoff" data-testid="drama-workflow-preview">
        <Package packageData={review} stageLabel={stageLabel} sessionLabel={sessionLabel} ticket={ticket} openCanvas={openCanvas} />
        <div className="drama-artifacts-actions">
          <Button type="button" size="sm" onClick={() => {
            setInteraction(ticket, { review: null, error: '', section: 'artifacts' })
          }} disabled={Boolean(interaction.busy)}>返回修改</Button>
          <Button type="button" size="sm" variant="primary" data-testid="drama-workflow-confirm" onClick={confirm}
            disabled={Boolean(interaction.busy) || !isActiveStage || nativeRunning || view?.session?.status === 'running'}>
            {review.targetStageId ? '确认交接并启动下一阶段' : '确认最终验收'}
          </Button>
        </div>
      </section>}
      {stage && panel === 'handoffs' && (selectedHandoff ? <>
        <ul className="drama-asset-list" aria-label="已确认的交接包">
          {handoffs.map(handoff => <li key={handoff.handoffId}>
            <button type="button" aria-pressed={handoff.handoffId === selectedHandoff.handoffId}
              onClick={() => setInteraction(ticket, { handoffId: handoff.handoffId })}>
              <strong>{handoff.targetStageId ? '交接到 ' + stageLabel(handoff.targetStageId) : '成片验收包'}</strong>
              <small>{formatDate(handoff.confirmedAt)} · {sessionLabel(handoff.sourceSessionId)}
                {handoff.stale && ' · 已过期'}</small>
            </button>
          </li>)}
        </ul>
        <section className="drama-handoff">
          <Package packageData={selectedHandoff} stageLabel={stageLabel} sessionLabel={sessionLabel} ticket={ticket} openCanvas={openCanvas} />
        </section>
      </> : <p className="drama-artifacts-empty">此阶段尚无正式交接记录。</p>)}
      {stage && panel === 'artifacts' && <>
        {selected ? <>
          <ul className="drama-asset-list" aria-label="当前版本" data-testid="drama-artifact-current">
            {latest.map(artifact => <li key={artifact.artifactId}>
              <ArtifactRow artifact={artifact} active={selected.artifactId === artifact.artifactId}
                sessionLabel={sessionLabel} select={() => chooseArtifact(artifact)} />
            </li>)}
          </ul>
          {groups.some(group => group.length > 1) && <details className="drama-artifact-versions" data-testid="drama-artifact-history">
            <summary>历史版本</summary>
            <ul className="drama-asset-list">
              {groups.filter(group => group.length > 1).flatMap(group => group.map(artifact =>
                <li key={artifactKey(artifact)}>
                  <ArtifactRow artifact={artifact} active={artifactKey(selected) === artifactKey(artifact)}
                    sessionLabel={sessionLabel} select={() => chooseArtifact(artifact, true)} />
                </li>))}
            </ul>
          </details>}
          <div className="drama-artifact-preview" data-testid="drama-artifact-version"
            data-artifact-id={selected.artifactId} data-version={selected.version}>
            <div className="drama-artifact-preview-heading">
              <div>
                <h3>{selected.title} <span>V{selected.version}</span></h3>
                <small title={selected.sessionId}>{sessionLabel(selected.sessionId)} · {selected.handedOff ? '已正式交接' : '草稿'}</small>
              </div>
              {current.version !== selected.version && <Button type="button" size="sm" aria-pressed={compare}
                onClick={() => setCompare(value => !value)}>{compare ? '关闭比较' : '与最新版比较'}</Button>}
            </div>
            <ArtifactContent artifact={selected} ticket={ticket} openCanvas={openCanvas} />
            {compare && current.version !== selected.version && <div className="drama-artifact-comparison">
              <h4>{current.title} <span>V{current.version}</span></h4>
              <ArtifactContent artifact={current} ticket={ticket} openCanvas={openCanvas} />
            </div>}
            {isActiveStage && selected.sessionId === sessionId && <div className="drama-artifacts-actions">
              {chosenVersion(choices, [current]) === selected.version
                ? <Button type="button" size="sm" onClick={() => chooseVersion(selected, 0)}>从交接选择移除</Button>
                : <Button type="button" size="sm" onClick={() => chooseVersion(selected, selected.version)}>选此版本交接</Button>}
            </div>}
          </div>
        </> : <p className="drama-artifacts-empty">此阶段还没有可预览的产物。</p>}
      </>}
    </div>
  </section>
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString() : ''
}

function ArtifactRow({ artifact, active, select, sessionLabel }) {
  return <button type="button" aria-pressed={active} onClick={select}
    data-artifact-id={artifact.artifactId} data-version={artifact.version}>
    <strong>{artifact.title} <span>V{artifact.version}</span></strong>
    <small title={artifact.sessionId}>{sessionLabel(artifact.sessionId)} · {artifact.handedOff ? '已交接' : '草稿'}</small>
  </button>
}

function ArtifactContent({ artifact, ticket, openCanvas }) {
  const node = artifact.node
  const media = artifactMediaURL(ticket, artifact)
  const content = artifact.content || node?.content?.text || node?.content?.description || node?.content?.prompt
  return <>
    {content && <div className="drama-artifact-markdown"><MarkdownText text={content} labels={markdownLabels} /></div>}
    {media && artifact.kind === 'image' && <img className="drama-artifact-media" src={media} alt={artifact.title} />}
    {media && artifact.kind === 'video' && <video className="drama-artifact-media" src={media} controls
      playsInline preload="metadata" aria-label={artifact.title} />}
    {media && artifact.kind === 'audio' && <audio className="drama-artifact-media" src={media} controls
      preload="metadata" aria-label={artifact.title} />}
    {node && <div className="drama-artifacts-actions"><Button type="button" size="sm" onClick={openCanvas}>在画布中查看</Button></div>}
  </>
}

function Package({ packageData, stageLabel, sessionLabel, ticket, openCanvas }) {
  const { sourceSessionId, sourceStageId, targetStageId, handoffId, sourceRevision, confirmedAt,
    artifacts, summary, confirmedDecisions, constraints } = packageData
  return <>
    <header className="drama-handoff-heading">
      <h3>{confirmedAt ? targetStageId ? '正式交接包' : '成片验收包' : targetStageId ? '交接预览' : '成片验收预览'}</h3>
      <p>{stageLabel(sourceStageId)}{targetStageId && <> → {stageLabel(targetStageId)}</>}</p>
    </header>
    <dl className="drama-handoff-metadata">
      <dt>来源会话</dt><dd title={sourceSessionId}>{sessionLabel(sourceSessionId)}</dd>
      {sourceRevision !== undefined && <><dt>来源版本</dt><dd>{sourceRevision}</dd></>}
      {confirmedAt && <><dt>确认时间</dt><dd>{formatDate(confirmedAt)}</dd></>}
      {packageData.stale && <><dt>状态</dt><dd>上游已更新，此交接已过期</dd></>}
    </dl>
    {summary && <div className="drama-handoff-block">
      <h4>摘要</h4><MarkdownText text={summary} labels={markdownLabels} />
    </div>}
    <div className="drama-handoff-block">
      <h4>固定产物版本</h4>
      <ul className="drama-handoff-artifact-list">
        {(artifacts ?? []).map(artifact => {
          const title = <>{artifact.title || artifact.artifactId} <span>V{artifact.version}</span></>
          return <li key={artifactKey(artifact)}>
            {artifact.content || artifact.node ? <details className="drama-handoff-file">
              <summary>{title}</summary>
              <ArtifactContent artifact={artifact} ticket={ticket} openCanvas={openCanvas} />
            </details> : <strong>{title}</strong>}
            {artifact.sessionId && <small title={artifact.sessionId}>{sessionLabel(artifact.sessionId)}</small>}
          </li>
        })}
      </ul>
    </div>
    <PackageList title="确认的创作决策" items={confirmedDecisions} />
    <PackageList title="约束" items={constraints} />
    <details className="drama-artifact-versions">
      <summary>交接信息</summary>
      <dl className="drama-handoff-metadata">
        <dt>交接 ID</dt><dd>{handoffId}</dd>
        {packageData.skillSha256 && <><dt>Skill SHA-256</dt><dd>{packageData.skillSha256}</dd></>}
        {packageData.harnessSha256 && <><dt>Harness SHA-256</dt><dd>{packageData.harnessSha256}</dd></>}
      </dl>
    </details>
  </>
}

function PackageList({ title, items }) {
  if (!items?.length) return null
  return <div className="drama-handoff-block">
    <h4>{title}</h4>
    <ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul>
  </div>
}

export function installWorkflowStyle() {
  const tag = document.createElement('style')
  tag.dataset.dramaWorkflowStyle = ''
  tag.textContent = style
  document.head.append(tag)
  return () => tag.remove()
}
