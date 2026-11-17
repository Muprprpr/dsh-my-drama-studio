import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { StudioError } from './kernel.js'
import { fileError, localFile, verifyUnchanged } from './workflow-capability-files.js'
import { assetStatus, sha256, skillResourceStatuses, skillTarget, stageIds, workflowTarget } from './capability-assets.js'
import { newWorkflowProfiles } from './stage-bindings.js'

const requestPrefix = 'drama-workflow:'
const artifactTools = new Set(['drama_save_artifact', 'drama_workflow_artifact'])
const documentNodes = new Set(['script', 'shot', 'note'])
const stageSection = 'drama-studio:workflow-stage'
const stageMarker = '[Drama Studio Workflow Stage]'
const probeKey = Symbol('verify workflow system prompt support')
const generationStage = 'video-generation'
const managedSkills = new Set(stageIds.map(id => 'drama-' + id))
const stageSkillError = '该 Skill 属于 Workflow 管理的阶段能力，请先切换到对应阶段。'
const busyError = '当前阶段正在执行，请等待本轮完成后再切换。'
const compactError = '阶段切换尚未完成，请先发送一条新阶段消息，再执行压缩。'

function fileTargets(workflowId, stage, skill) {
  return {
    skill: skillTarget(skill),
    harness: workflowTarget(workflowId, stage.harness),
  }
}

function requestId(message) {
  const { source } = message
  return source?.kind === 'user' && typeof source.rpcId === 'string' ? source.rpcId : undefined
}

function isKickoffMessage(message) {
  return requestId(message)?.startsWith(requestPrefix) === true
}

function sameWorkspace(left, right) {
  return left.id === right.id && left.path === right.path
}

function endError(reason) {
  if (reason.kind === 'completed') return undefined
  if (reason.kind === 'aborted') return 'DSH Agent 已取消本轮工作'
  if (reason.kind === 'max-tokens') return 'DSH Agent 达到输出上限'
  if (reason.kind === 'blocked') return 'DSH Agent 拒绝执行本轮工作'
  const code = reason.error?.code
  return /^[A-Z_]{1,40}$/.test(code ?? '') ? `DSH Agent 执行失败（${code}）` : 'DSH Agent 执行失败'
}

function summarizeArtifact({ artifactId, version, stageId, title, nodeId, kind }) {
  return { artifactId, version, stageId, title, nodeId, kind }
}

function summarizeHandoff({ handoffId, sourceStageId, summary, confirmedDecisions, constraints, artifacts }) {
  return {
    handoffId, sourceStageId, summary, confirmedDecisions, constraints,
    artifacts: artifacts?.map(summarizeArtifact),
  }
}

function stageInstructions(run, admitted) {
  const { stage, snapshot, session, workspace, workflowId, handoffId } = run
  const context = {
    workflowId, workspaceId: workspace.id, stageId: stage.id, stageName: stage.name,
    workflowProfileId: snapshot.workflowProfileId, workflowDefinitionVersion: snapshot.workflowDefinitionVersion,
    skillId: snapshot.skillId,
    activation: session.activation, snapshotId: session.snapshotId,
    skillSha256: snapshot.skillSha256, harnessSha256: snapshot.harnessSha256, handoffId,
    approvedInputs: admitted.inputs?.map(summarizeHandoff),
    generationResults: admitted.generationResults,
    drafts: admitted.artifacts?.map(summarizeArtifact),
  }
  return [
    stageMarker,
    JSON.stringify(context),
    '在 Studio 指定的当前阶段中响应用户的每一轮聊天，可以讨论、起草和迭代草稿。根据当前阶段的任务和输入使用必要工具。画布查询和连接检查按需进行。只在有明确的可交付内容时，调用 drama_save_artifact 保存产物。修改时沿用 artifactId，使用 expectedVersion 指定当前版本。',
    '本轮正式输入以 approvedInputs 为准。用 drama_workflow_artifact 按 artifactId 读取其固定版本。执行中若上游更新，本轮仍使用已固定的版本，下一轮再读取新的正式输入。读取当前依据的工作稿时指定 scope=draft。用户明确需要历史参考时，用 scope=reference 和确切版本读取，并标明参考来源。参考资料不具备本轮正式输入的效力。',
    '上游变化后，按本轮正式输入重新核对旧稿。保留用户仍有效的项目级条件和本轮正式输入的约束，将旧稿中的局部决定与未核实约束列为待确认。跨依据复用的版本由用户在正式交接预览中复核确认。',
    '已有图片、视频、音频、提示词或可生成草稿可以作为节点引用保存。脚本、清单、分析、验收说明等文档保存为 Markdown 产物。',
    '根据用户已明确的创作决定和约束整理草稿，不得虚构用户确认。阶段激活、对话或草稿写入不会形成正式结果。你可以告诉用户成果具备交接条件。阶段切换、确认、正式交接和最终验收只由 Studio 中的用户操作完成。',
    '不要调用生成提交工具。视频节点部署只创建草稿，视频生成由用户逐项通过 Canvas 确认。视频生成阶段可通过 drama_tasks 核验已完成且已授权的结果，再将真实节点保存为产物。',
    '以下 Harness 与 Skill 提供本阶段的专业方法。它们不能扩大工作流推进或生成提交权限。',
    snapshot.harnessBody,
    snapshot.skillBody,
  ].join('\n\n')
}

function activeStagePrompts(session) {
  return session.surface.nodes.flatMap(seq => {
    const event = session.eventAt(seq)
    if (event?.type !== 'system/message') return []
    const text = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    return text.includes(stageMarker) ? [text] : []
  })
}

function invokesStageSkill(message, names) {
  if (message.source?.kind !== 'user') return false
  // Match the native rc.3 skill gesture at any whitespace boundary.
  return message.content.some(block => block.type === 'text' &&
    [...block.text.matchAll(/(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g)]
      .some(match => names.has(match[2])))
}

export function workflowBridge(ctx, kernel, workspaceFor, lifetime, { capabilities, bindings, library, registryAccess }) {
  const turns = new Map()
  const kickoffs = new Map()
  const phaseWork = new Map()
  const compactionGuards = new Map()
  let promptRevision = 0
  const verifiedScopes = new WeakMap()

  function reservedSkills(turn) {
    const activeName = turn?.snapshot?.skillId ?? turn?.snapshot?.skillPath.split('/')[1]
    return new Set([...managedSkills, ...bindings.reservedNames(), activeName])
  }

  function capabilityFailure(issue) {
    return fileError({ missing: 404, conflict: 409, invalid: 409, blocked: 503 }[issue.status], issue.status, issue.error)
  }

  function stageFiles(workflow, stage, mapping) {
    const { skillId: skillName, failure } = bindings.effective(mapping, workflow.workflowProfileId, stage.id, stage.skill)
    const workflowId = workflow.id ?? workflow.workflowId
    const targets = fileTargets(workflowId, stage, skillName)
    const root = capabilities.root ?? ctx.profileContext.home
    return {
      skillName, failure,
      targets,
      skillPath: root && resolve(root, targets.skill),
      harnessPath: root && resolve(root, targets.harness),
    }
  }

  function checkBootstrap(target) {
    const issue = capabilities.failure ?? capabilities.errors.get(target)
    if (issue) throw capabilityFailure(issue)
  }

  function nativeController() {
    const controller = ctx.get('sessionController')
    if (!controller?.prompt || !controller.resolveAgent || !ctx.get('systemPrompt')?.assemble) {
      throw new StudioError(503, '当前 DSH Host 未提供所需的原生会话及指令装填接口')
    }
    return controller
  }

  async function checkPromptScope(agent) {
    const revision = promptRevision
    if (verifiedScopes.get(agent) === revision) return
    const assembly = await ctx.get('systemPrompt').assemble({ scope: agent, agent, [probeKey]: true })
    if (!assembly.sections.some(section => section.name === stageSection)) {
      throw new StudioError(409, '当前 DSH 会话预设锁定了完整系统指令，无法可靠装填阶段 Harness')
    }
    verifiedScopes.set(agent, revision)
  }

  async function checkStageSupport(agent) {
    nativeController()
    if (!ctx.tools.get('drama_save_artifact', agent) || !ctx.tools.get('drama_workflow_artifact', agent)) {
      throw new StudioError(409, '当前 DSH Session 未启用阶段产物工具')
    }
    installCompactionGuard(agent)
    await checkPromptScope(agent)
  }

  async function loadCapabilities(agent, workflow, stage) {
    const { workflowProfileId, workflowDefinitionVersion } = workflow
    const { skillName, skillPath, harnessPath, targets, failure } = stageFiles(workflow, stage, bindings.read())
    try {
      if (failure) throw capabilityFailure(failure)
      checkBootstrap(targets.skill)
      checkBootstrap(targets.harness)
      const resourceIssue = skillResourceStatuses(capabilities, skillName).find(resource => resource.error)
      if (resourceIssue) throw capabilityFailure(resourceIssue)
      await checkStageSupport(agent)
      const [{ skill, source }, harness, { renderSkillContent }] = await Promise.all([
        library.requireInstalled(skillName, agent.id, agent),
        localFile(harnessPath, 'Harness'),
        registryAccess.nativeSkillAPI(),
      ])
      const skillBody = renderSkillContent(skill)
      await Promise.all([
        verifyUnchanged(skillPath, 'Skill', source.info),
        verifyUnchanged(harnessPath, 'Harness', harness.info),
      ])
      return {
        workflowProfileId, workflowDefinitionVersion, stageId: stage.id, skillId: skillName,
        skillPath: targets.skill,
        harnessPath: targets.harness,
        skillSourceSha256: source.sha256,
        skillSha256: sha256(skillBody),
        harnessSha256: harness.sha256,
        skillBody,
        harnessBody: harness.body,
      }
    } catch (error) {
      if (!(error instanceof StudioError)) throw error
      throw new StudioError(error.status, `${workflowProfileId} / ${stage.id} / ${skillName}：${error.message}`)
    }
  }

  async function readSession(sessionId, workspace, signal = lifetime, stateOnly = false) {
    return kernel(sessionId, workspace, 'workflow_session', stateOnly ? { stateOnly } : {}, signal, 'workflow')
  }

  async function changeStage(sessionId, run) {
    if (phaseWork.has(sessionId)) throw new StudioError(409, busyError)
    phaseWork.set(sessionId, 'transition')
    try {
      return await run()
    } finally {
      phaseWork.delete(sessionId)
    }
  }

  async function guardCompaction(agent, signal, manual, run) {
    const sessionId = agent.session.id
    function pending() {
      if (manual) throw new StudioError(409, compactError)
      return null
    }
    const phase = phaseWork.get(sessionId)
    if (phase === 'transition') return pending()
    if (phase === 'compaction') {
      if (manual) throw new StudioError(409, '当前 Session 正在压缩，请等待压缩完成。')
      return null
    }
    phaseWork.set(sessionId, 'compaction')
    try {
      const workspace = await workspaceFor(ctx, sessionId).catch(error => {
        if (error.status !== 404) throw error
      })
      const state = workspace && await readSession(sessionId, workspace, signal, true)
      if (state?.session.transitionPending ||
          (!state?.session.activeStageId && activeStagePrompts(agent.session).length)) return pending()
      signal?.throwIfAborted()
      return await run()
    } finally {
      phaseWork.delete(sessionId)
    }
  }

  function installCompactionGuard(agent) {
    const service = ctx.get('agentPresets')?.serviceFor(agent, 'compaction') ?? ctx.get('compaction')
    const engine = service?.[Symbol.for('cordis.original')] ?? service
    if (!engine || compactionGuards.has(engine)) return
    const { compactIfNeeded, compactNow } = engine
    if (typeof compactIfNeeded !== 'function' || typeof compactNow !== 'function') {
      throw new StudioError(409, '当前 DSH 会话预设的压缩服务不支持阶段切换保护')
    }
    // rc.3 dispatches pressure and overflow through compactIfNeeded, and /compact
    // through compactNow. Guard the actual scoped backend before it reads history.
    engine.compactIfNeeded = function (owner, trigger, signal) {
      return guardCompaction(owner, signal, false, () => compactIfNeeded.call(this, owner, trigger, signal))
    }
    engine.compactNow = function (owner, signal, commandId) {
      return guardCompaction(owner, signal, true, () => compactNow.call(this, owner, signal, commandId))
    }
    compactionGuards.set(engine, () => {
      engine.compactIfNeeded = compactIfNeeded
      engine.compactNow = compactNow
    })
  }

  async function get(sessionId, workspace, input) {
    const view = await kernel(sessionId, workspace, 'workflow_get', input, lifetime, 'human')
    if (view.profileSelectionRequired) return { ...view, availableProfiles: newWorkflowProfiles }
    const mapping = bindings.read()
    const stagePaths = view.stages.map(stage => stageFiles(view, stage, mapping))
    const globalFailure = capabilities.failure ?? mapping.failure
    let skills
    if (!globalFailure) {
      const names = [...new Set(stagePaths.filter(files => !files.failure).map(files => files.skillName))]
      skills = await library.withRegistry(sessionId, inspect => Promise.allSettled(names.map(name => inspect(name)))).then(
        results => new Map(names.map((name, index) => [name, results[index]])),
        () => new Map(),
      )
    }
    async function inspect(target, path, name, bindingFailure) {
      const issue = capabilities.failure ?? capabilities.errors.get(target) ?? bindingFailure
      if (issue) return { ...issue, path: path ?? issue.path }
      try {
        if (!name) {
          const { sha256: hash } = await localFile(path, 'Harness')
          return assetStatus(capabilities, target, hash)
        }
        const found = skills?.get(name)
        if (!found) throw fileError(503, 'blocked', `DSH 原生全局 Skill 目录无法读取：${path}`)
        if (found.status === 'rejected') throw found.reason
        const { skill, source } = found.value
        return { ...assetStatus(capabilities, target, source.sha256), source: skill.source }
      } catch (error) {
        return { status: error.assetStatus ?? 'blocked', path, error: error.message }
      }
    }
    const stages = await Promise.all(view.stages.map(async (stage, index) => {
      const { skillName, skillPath, harnessPath, targets, failure } = stagePaths[index]
      const [skillAsset, harnessAsset] = await Promise.all([
        inspect(targets.skill, skillPath, skillName, failure),
        inspect(targets.harness, harnessPath),
      ])
      const resourceAssets = globalFailure ? [] : skillResourceStatuses(capabilities, skillName)
      const resourceError = resourceAssets.find(resource => resource.error)
      return { ...stage, files: {
        skillName, skillPath, harnessPath, skillSource: skillAsset.source,
        skillReady: !skillAsset.error && !resourceError, harnessReady: !harnessAsset.error,
        skillAsset, harnessAsset, resourceAssets,
        issues: [skillAsset, harnessAsset, ...resourceAssets].flatMap(asset => asset.error ? [asset.error] : []),
      } }
    }))
    const failure = globalFailure ?? stages.flatMap(({ files }) =>
      [files.skillAsset, files.harnessAsset, ...files.resourceAssets]).find(asset => asset.error)
    return { ...view, stages, capabilities: {
      ready: !failure, status: failure?.status ?? 'ready', packageVersion: capabilities.packageVersion,
      error: globalFailure?.error,
    } }
  }

  async function resolveAgent(sessionId) {
    const { agent } = await nativeController().resolveAgent(sessionId)
    if (!agent) throw new StudioError(409, '无法打开指定的 DSH Session')
    installCompactionGuard(agent)
    return agent
  }

  function publicFailure(error) {
    return error instanceof StudioError ? error.message : 'DSH 无法执行当前阶段，请检查会话和模型设置'
  }

  function kickoffFailure(error) {
    if (error instanceof StudioError) return error.message
    switch (error?.code) {
      case 'session/model-unavailable': return '当前 Session 的模型不可用，请重新选择模型后启动交接任务。'
      case 'session/not-found': return 'DSH 无法打开当前 Session，请重新打开会话后启动交接任务。'
      case 'session/agent-busy': return 'DSH 拒绝接收交接任务，请等待当前会话处理完成后重试。'
      default: return 'DSH 无法启动交接任务，请检查会话和模型设置后重试。'
    }
  }

  async function recordKickoffFailure(kickoff, error) {
    try {
      return await kernel(kickoff.sessionId, kickoff.workspace, 'workflow_kickoff_failed', {
        operationId: randomUUID(), handoffId: kickoff.handoffId, error,
      }, undefined, 'workflow')
    } catch (failure) {
      if (failure.status !== 409 && !lifetime.aborted) {
        console.error('[my-drama-studio] Workflow kickoff', kickoff.handoffId, failure.message)
      }
    } finally {
      if (kickoffs.get(kickoff.sessionId) === kickoff) kickoffs.delete(kickoff.sessionId)
    }
  }

  function finishTurn(turn, error) {
    if (turn.settlement) return turn.settlement
    turn.settlement = (async () => {
      try {
        await turn.prepared
        if (turn.started) {
          await settle('workflow_turn_finish', { runId: turn.runId, ...(error && { error }) })
        } else {
          if (turn.kickoff && error) await recordKickoffFailure(turn.kickoff, error)
          else if (turn.stage && error && !lifetime.aborted) {
            await settle('workflow_turn_failed', { stageId: turn.stage.id, activation: turn.session.activation, error })
          }
        }
        if (!error && turn.transitionSeries && turn.hasAssistantReply) {
          const prompts = activeStagePrompts(turn.agent.session)
          const committed = turn.stage
            ? prompts.length === 1 && prompts[0].includes(turn.instructions)
            : prompts.length === 0
          if (committed) {
            // The native journal and SQLite commit independently. Persist the
            // normalized native surface before dropping the SQLite barrier.
            if (await ctx.get('sessions')?.flush(turn.agent.session)) {
              await settle('workflow_transition_complete', { activation: turn.session.activation })
            } else {
              console.warn('[my-drama-studio] Workflow transition awaits native Session persistence', turn.agent.id)
            }
          }
        }
      } catch (failure) {
        if (!lifetime.aborted) console.error('[my-drama-studio] Workflow settlement', turn.runId, failure.message)
      } finally {
        if (turns.get(turn.agent.id) === turn) turns.delete(turn.agent.id)
      }
    })()
    return turn.settlement

    async function settle(action, data) {
      const input = { operationId: randomUUID(), ...data }
      for (let attempt = 0; ; attempt++) {
        try {
          return await kernel(turn.agent.id, turn.workspace, action, input, undefined, 'workflow')
        } catch (failure) {
          if (attempt >= 2 || failure.status < 500 || lifetime.aborted) throw failure
          await delay(150 * (attempt + 1))
        }
      }
    }
  }

  async function prepareTurn(turn, signal) {
    await turn.previous
    if (turn.staleKickoff && !turn.hasChat) return
    const { agent } = turn
    try {
      installCompactionGuard(agent)
      const workspace = await workspaceFor(ctx, agent.id)
      turn.workspace = workspace
      const { session, stage, workflowId, snapshot } = await readSession(agent.id, workspace, signal)
      turn.session = session
      if (turn.kickoff && (turn.kickoff.handoffId !== session.pendingHandoffId || !sameWorkspace(workspace, turn.kickoff.workspace))) {
        await recordKickoffFailure(turn.kickoff, '交接启动请求已失效')
        turn.kickoff = undefined
        turn.staleKickoff = true
        if (!turn.hasChat) return
      }
      if (!session.activeStageId) return
      if (stage?.id !== session.activeStageId || !workflowId) throw new StudioError(503, '无法读取当前阶段定义')
      turn.stage = stage
      turn.workflowId = workflowId
      turn.handoffId = turn.kickoff?.handoffId
      if (!snapshot || !session.snapshotId) {
        throw new StudioError(409, '当前阶段没有可恢复的能力快照，请退出阶段后重新激活。')
      }
      turn.snapshot = snapshot
      await checkStageSupport(agent)
      const current = await workspaceFor(ctx, agent.id)
      if (!sameWorkspace(current, workspace)) throw new StudioError(409, 'Session 的 Workspace 已切换')
      signal.throwIfAborted()
      turn.runId = randomUUID()
      // Complete the write even if the Agent is cancelled during admission. Settlement
      // then closes the same run instead of leaving SQLite in Running.
      const input = {
        operationId: turn.runId, runId: turn.runId, stageId: stage.id,
        activation: session.activation, snapshotId: session.snapshotId,
        ...(turn.handoffId && { handoffId: turn.handoffId }),
      }
      const admit = () => kernel(agent.id, workspace, 'workflow_turn_start', input, lifetime, 'workflow')
      const admitted = await admit().catch(error => {
        if (error.status >= 500 && !lifetime.aborted) return admit()
        throw error
      })
      turn.started = true
      if (turn.kickoff && kickoffs.get(agent.id) === turn.kickoff) kickoffs.delete(agent.id)
      turn.instructions = stageInstructions(turn, admitted)
    } catch (error) {
      if (!turn.workspace && !turn.kickoff && error.status === 404) return
      if (!signal.aborted) turn.failure = publicFailure(error)
    }
  }

  ctx.on('agent/inbox/claimed', ({ agent, message, turn: number }) => {
    let turn = turns.get(agent.id)
    if (turn?.agent !== agent || turn.number !== number) {
      turn = { agent, number, previous: turn?.settlement, nodeIds: new Set() }
      turns.set(agent.id, turn)
    }
    if (!isKickoffMessage(message)) {
      turn.hasChat = true
      return
    }
    const kickoff = kickoffs.get(agent.id)
    if (kickoff?.agent === agent && kickoff.requestId === requestId(message) &&
        message.content.length === 1 && message.content[0].type === 'text' && message.content[0].text === kickoff.prompt) {
      turn.kickoff = kickoff
    } else {
      turn.staleKickoff = true
    }
  })

  ctx.on('agent/inbox/discarded', ({ agent, message }) => {
    const kickoff = kickoffs.get(agent.id)
    if (kickoff?.agent === agent && kickoff.requestId === requestId(message)) {
      void recordKickoffFailure(kickoff, 'DSH 已移除等待执行的交接任务')
    }
  })

  ctx.on('agent/created', ({ agent }) => {
    try {
      installCompactionGuard(agent)
    } catch (error) {
      console.error('[my-drama-studio] Workflow compaction', error.message)
    }
    // A restarted Host never replays a deferred transition. Pending kickoff is
    // visible in Studio until the browser explicitly retries it.
    for (const message of [...agent.inbox.nextTurn, ...agent.inbox.nextStep]) {
      if (isKickoffMessage(message)) agent.inbox.remove(message.id)
    }
  })

  ctx.on('system-prompt/change', () => { promptRevision++ })
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const revision = promptRevision
    const assembly = await next()
    if (context[probeKey]) {
      return { ...assembly, sections: [...assembly.sections, { name: stageSection, text: '', interpolate: false }] }
    }
    const { agent, signal } = context
    const turn = agent && turns.get(agent.id)
    if (signal && turn && turn.agent === agent && !turn.settlement) {
      await (turn.prepared ??= prepareTurn(turn, signal))
    }
    if (signal && turn?.instructions && !turn.settlement) {
      try {
        await checkPromptScope(agent)
        if (revision !== promptRevision) throw new StudioError(409, 'DSH 原生指令设置已更改，请重新发送本轮消息')
        turn.promptRevision = revision
        return {
          ...assembly,
          sections: [...assembly.sections, { name: stageSection, text: turn.instructions, interpolate: false }],
          tools: assembly.tools.filter(tool => tool.name !== 'drama_submit' &&
            (turn.stage.id !== generationStage || tool.name !== 'drama_append')),
        }
      } catch (error) {
        turn.failure = publicFailure(error)
      }
    }
    return { ...assembly, tools: assembly.tools.filter(tool => !artifactTools.has(tool.name)) }
  }, { prepend: true })

  ctx.on('agent/pre-step', async ({ agent, turn: number, step, messages: claimed }, next) => {
    const turn = turns.get(agent.id)
    const ownTurn = turn?.agent === agent && turn.number === number
    if (ownTurn && (turn.failure || turn.staleKickoff && !turn.hasChat)) return { kind: 'reject' }
    const forbiddenSkills = ownTurn && turn.workspace && reservedSkills(turn)
    if (forbiddenSkills && claimed.some(message => invokesStageSkill(message, forbiddenSkills))) {
      turn.failure = stageSkillError
      throw new StudioError(409, stageSkillError)
    }
    const decision = await next()
    if (ownTurn && turn.instructions && turn.promptRevision !== promptRevision) {
      turn.failure = 'DSH 原生指令设置已更改，请重新发送本轮消息'
      return { kind: 'reject' }
    }
    if (decision.kind === 'reject') return decision
    const messages = ownTurn ? decision.messages.filter(message => {
      if (isKickoffMessage(message)) return requestId(message) === turn.kickoff?.requestId
      return !forbiddenSkills || message.source?.kind !== 'skill-invocation' || !forbiddenSkills.has(message.source.name)
    }) : decision.messages
    // DeepSeek can retain old system messages in its request series. A new
    // series makes the native loop replace them when switching, exiting or
    // beginning a stage turn with updated confirmed inputs.
    if (step === 1 && ((ownTurn && (turn.instructions || turn.session?.transitionPending)) ||
        activeStagePrompts(agent.session).length)) {
      if (ownTurn && turn.session?.transitionPending) turn.transitionSeries = true
      return { ...decision, messages, startsRequestSeries: true }
    }
    return { ...decision, messages }
  }, { prepend: true })

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end' && event.type !== 'assistant/message') return
    const turn = turns.get(session.id)
    if (turn?.agent.session !== session || event.data.turn !== turn.number) return
    if (event.type === 'assistant/message' && !event.data.interrupted) turn.hasAssistantReply = true
    if (event.type === 'turn/end') {
      void finishTurn(turn, turn.failure ?? endError(event.data.reason))
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const turn = turns.get(agent.id)
    if (turn?.agent === agent) void finishTurn(turn, 'DSH Agent 会话已释放')
    const kickoff = kickoffs.get(agent.id)
    if (kickoff?.agent === agent) void recordKickoffFailure(kickoff, 'DSH Agent 会话已释放')
  })

  ctx.effect(() => async () => {
    await Promise.allSettled([...turns.values()].map(turn => finishTurn(turn, 'Studio Host 已退出，当前执行中断')))
    for (const restore of compactionGuards.values()) restore()
    compactionGuards.clear()
  })

  ctx.effect(() => ctx.tools.guard(exec => {
    if (exec.name === 'skill' && exec.agent &&
        ctx.workspaceRegistry.list().some(workspace => workspace.sessionIds.includes(exec.agent.id)) &&
        reservedSkills(turns.get(exec.agent.id)).has(exec.arguments?.name)) {
      return stageSkillError
    }
  }))

  function authorizeTool(agent, workspace, action, data) {
    const turn = turns.get(agent.id)
    const running = turn?.agent === agent && turn.started && !turn.settlement
    if (!running) {
      if (action === 'workflow_save_artifact' || action === 'workflow_artifact_get') {
        throw new StudioError(403, '请先激活阶段，并在当前 Session 的对话中操作阶段产物')
      }
      return
    }
    if (!sameWorkspace(workspace, turn.workspace)) throw new StudioError(409, 'Session 的 Workspace 已切换')
    if (action === 'workflow_save_artifact' || action === 'workflow_artifact_get') {
      return { ...data, runId: turn.runId }
    }
    if (action === 'submit') throw new StudioError(403, '工作流阶段不授权模型生成，请在 Canvas 中独立确认提交')
    if (action !== 'append') return
    if (turn.stage.id === generationStage) throw new StudioError(403, '视频生成阶段只读取经 Canvas 授权生成的结果')
    if (data.nodes?.some(node => documentNodes.has(node.type))) {
      throw new StudioError(403, '请使用 drama_save_artifact 保存文档成果')
    }
    const additions = new Set((data.nodes ?? []).map(node => node.id))
    if (data.edges?.some(edge => !additions.has(edge.target) && !turn.nodeIds.has(edge.target))) {
      throw new StudioError(403, '当前工作流阶段的连线只允许指向本轮新建节点')
    }
  }

  function trackToolResult(agent, action, result) {
    const turn = turns.get(agent.id)
    if (action === 'append' && turn?.agent === agent && turn.started && !turn.settlement) {
      for (const id of result.ids ?? []) turn.nodeIds.add(id)
    }
  }

  async function activate(sessionId, workspace, input) {
    const { operationId, stageId } = input
    return changeStage(sessionId, async () => {
      const view = await kernel(sessionId, workspace, 'workflow_get', {}, lifetime, 'human')
      if (view.profileSelectionRequired) throw new StudioError(409, '请先为当前 Workspace 选择生产模式')
      const { session } = view
      if (session.status === 'running' && (session.activeStageId ?? '') !== stageId) {
        throw new StudioError(409, busyError)
      }
      let snapshot
      if (stageId && stageId !== session.activeStageId) {
        const stage = view.stages.find(item => item.id === stageId)
        if (!stage) throw new StudioError(400, '未知的工作流阶段')
        snapshot = await loadCapabilities(await resolveAgent(sessionId), view, stage)
      } else if (!stageId && session.activeStageId) {
        await resolveAgent(sessionId)
      }
      const current = await workspaceFor(ctx, sessionId)
      if (!sameWorkspace(current, workspace)) throw new StudioError(409, 'Session 的 Workspace 已切换')
      return kernel(sessionId, workspace, 'workflow_activate', {
        operationId, stageId, expectedActivation: session.activation, snapshot,
      }, lifetime, 'human')
    })
  }

  async function submitKickoff(kickoff) {
    const { sessionId, workspace, handoffId } = kickoff
    try {
      const { session, stage } = await readSession(sessionId, workspace, lifetime, true)
      if (session.pendingHandoffId !== handoffId || !stage) {
        if (kickoffs.get(sessionId) === kickoff) kickoffs.delete(sessionId)
        return { session }
      }
      kickoff.agent = await resolveAgent(sessionId)
      if (!session.snapshotId) throw new StudioError(409, '当前阶段没有可恢复的能力快照，请退出阶段后重新激活。')
      await checkStageSupport(kickoff.agent)
      const current = await workspaceFor(ctx, sessionId)
      if (!sameWorkspace(current, workspace)) throw new StudioError(409, 'Session 的 Workspace 已切换')
      kickoff.prompt = `已确认交接。请开始「${stage.name}」，从已确认的交接包和固定产物版本读取所需信息，按当前阶段规则开展第一轮工作。`
      const admission = await nativeController().prompt({
        sessionId, requestId: kickoff.requestId, mode: 'queue', content: [{ type: 'text', text: kickoff.prompt }],
      }, lifetime)
      if (!admission?.accepted) throw new StudioError(409, 'DSH 未接受交接任务')
    } catch (error) {
      const failed = await recordKickoffFailure(kickoff, kickoffFailure(error))
      if (failed) return failed
    }
    return readSession(sessionId, workspace, lifetime, true)
  }

  function kickoff(sessionId, workspace, handoffId) {
    const current = kickoffs.get(sessionId)
    if (current?.handoffId === handoffId && sameWorkspace(workspace, current.workspace)) return current.accepted
    const delivery = { sessionId, workspace, handoffId, requestId: requestPrefix + handoffId + ':' + randomUUID() }
    kickoffs.set(sessionId, delivery)
    delivery.accepted = submitKickoff(delivery)
    return delivery.accepted
  }

  async function confirm(sessionId, workspace, input) {
    const { handoff, committed } = await changeStage(sessionId, async () => {
      const { targetStage } = await kernel(sessionId, workspace, 'workflow_handoff_target',
        { handoffId: input.handoffId }, lifetime, 'workflow')
      let snapshot
      if (targetStage) {
        const currentSession = await readSession(sessionId, workspace, lifetime, true)
        if (currentSession.session.status === 'running') throw new StudioError(409, busyError)
        snapshot = await loadCapabilities(await resolveAgent(sessionId), currentSession, targetStage)
      }
      const current = await workspaceFor(ctx, sessionId)
      if (!sameWorkspace(current, workspace)) throw new StudioError(409, 'Session 的 Workspace 已切换')
      return kernel(sessionId, workspace, 'workflow_handoff_confirm', { ...input, snapshot }, lifetime, 'human')
    })
    const { session } = await readSession(sessionId, workspace, lifetime, true)
    // A replay is a receipt read. Only a new commit can enqueue the first attempt.
    if (!committed || session.pendingHandoffId !== handoff.handoffId) return { handoff, session }
    const next = await kickoff(sessionId, workspace, handoff.handoffId)
    return { handoff, session: next.session }
  }

  async function retry(sessionId, workspace, handoffId) {
    const { session } = await readSession(sessionId, workspace, lifetime, true)
    if (!handoffId || session.pendingHandoffId !== handoffId) {
      const reason = session.pendingHandoffId ? '' : session.error
      throw new StudioError(409, reason || '当前 Session 没有待启动的该次交接')
    }
    return kickoff(sessionId, workspace, handoffId)
  }

  return { get, activate, confirm, retry, authorizeTool, trackToolResult }
}
