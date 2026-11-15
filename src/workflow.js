import { createHash, randomUUID } from 'node:crypto'
import { open, realpath, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { relative, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { StudioError } from './kernel.js'

const requestPrefix = 'drama-workflow:'
const artifactTools = new Set(['drama_save_artifact', 'drama_workflow_artifact'])
const documentNodes = new Set(['script', 'shot', 'note'])
const stageSection = 'drama-studio:workflow-stage'
const stageMarker = '[Drama Studio Workflow Stage]'
const probeKey = Symbol('verify workflow system prompt support')
const maxFileBytes = { Skill: 512 * 1024, Harness: 64 * 1024 }
const generationStage = 'video-generation'
const managedSkills = new Set([
  'drama-content-analysis', 'drama-shooting-script', 'drama-storyboard', 'drama-asset-binding',
  'drama-video-deployment', 'drama-video-generation', 'drama-final-review',
])
const stageSkillError = '该 Skill 属于 Workflow 管理的阶段能力，请先切换到对应阶段。'
const busyError = '当前阶段正在执行，请等待本轮完成后再切换。'
const compactError = '阶段切换尚未完成，请先发送一条新阶段消息，再执行压缩。'

function samePath(left, right) {
  return typeof left === 'string' && resolve(left).toLowerCase() === resolve(right).toLowerCase()
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

function filePaths(root, workflowId, stage) {
  return {
    skillPath: resolve(root, 'skills', stage.skill, 'SKILL.md'),
    harnessPath: resolve(root, 'drama-studio', 'workflows', workflowId, stage.harness),
  }
}

async function localFile(path, kind, read) {
  try {
    if (!samePath(await realpath(path), path)) throw new StudioError(409, `全局 ${kind} 必须位于规定路径：${path}`)
    const info = await stat(path, { bigint: true })
    if (!info.isFile() || !info.size) throw new StudioError(400, `${kind} 必须是非空普通文件：${path}`)
    if (!read) return
    if (info.size > maxFileBytes[kind]) throw new StudioError(400, `${kind} 文件不能超过 ${maxFileBytes[kind] / 1024} KiB：${path}`)
    const file = await open(path, 'r')
    try {
      const opened = await file.stat({ bigint: true })
      if (!sameFile(info, opened) || !samePath(await realpath(path), path)) {
        throw new StudioError(409, `${kind} 路径已变更：${path}`)
      }
      const size = Number(info.size)
      const buffer = Buffer.alloc(size + 1)
      let length = 0
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length)
        if (!bytesRead) break
        length += bytesRead
      }
      const finished = await file.stat({ bigint: true })
      if (length !== size || !sameFile(finished, opened)) {
        throw new StudioError(409, `${kind} 文件在读取时发生变化，请重试：${path}`)
      }
      const bytes = buffer.subarray(0, length)
      const body = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim()
      if (!body) throw new StudioError(400, `${kind} 文件没有指令：${path}`)
      return { body, sha256: sha256(bytes), info: finished }
    } finally {
      await file.close()
    }
  } catch (error) {
    if (error instanceof StudioError) throw error
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new StudioError(404, `${kind} 文件缺失：${path}`)
    if (error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA') throw new StudioError(400, `${kind} 文件须为 UTF-8：${path}`)
    throw new StudioError(409, `无法读取${kind} 文件：${path}`)
  }
}

function sameFile(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

async function verifyUnchanged(path, kind, info) {
  const current = await stat(path, { bigint: true }).catch(() => undefined)
  if (!sameFile(info, current) || !samePath(await realpath(path).catch(() => undefined), path)) {
    throw new StudioError(409, `${kind} 文件在激活时发生变化，请重试：${path}`)
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

function summarizeHandoff(input) {
  return {
    ...input,
    artifacts: input.artifacts?.map(summarizeArtifact),
  }
}

function stageInstructions(run, admitted) {
  const { stage, snapshot, session, workspace, workflowId, handoffId } = run
  const context = {
    workflowId, workspaceId: workspace.id, stageId: stage.id, stageName: stage.name,
    activation: session.activation, snapshotId: session.snapshotId,
    skillSha256: snapshot.skillSha256, harnessSha256: snapshot.harnessSha256, handoffId,
    approvedInputs: admitted.inputs?.map(summarizeHandoff),
    generationResults: admitted.generationResults,
    drafts: admitted.artifacts?.map(summarizeArtifact),
  }
  return [
    stageMarker,
    JSON.stringify(context),
    '在 Studio 指定的当前阶段中响应用户的每一轮聊天，允许讨论、查询素材、生成和迭代草稿。只在有明确的可交付内容时，调用 drama_save_artifact 保存产物。修改时沿用 artifactId，使用 expectedVersion 指定当前版本。',
    '上游交接包提供已确认的决策、约束和固定产物版本。使用 drama_workflow_artifact 读取这些版本或当前 Session 的草稿，使用 drama_query 查询 Canvas。已有图片、视频、音频、提示词或可生成草稿可以作为节点引用保存。脚本、清单、分析、验收说明等文档保存为 Markdown 产物。',
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

function invokesStageSkill(message) {
  if (message.source?.kind !== 'user') return false
  // Match the native rc.3 skill gesture at any whitespace boundary.
  return message.content.some(block => block.type === 'text' &&
    [...block.text.matchAll(/(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g)]
      .some(match => managedSkills.has(match[2])))
}

export function workflowBridge(ctx, kernel, workspaceFor, lifetime) {
  const turns = new Map()
  const kickoffs = new Map()
  const phaseWork = new Map()
  const compactionGuards = new Map()
  let promptRevision = 0
  const verifiedScopes = new WeakMap()
  const runtimeRequire = createRequire(ctx.profileContext.installAnchor)
  let nativeSkill

  function nativeSkillAPI() {
    return nativeSkill ??= import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-skill')).href)
  }

  function nativeController() {
    const controller = ctx.get('sessionController')
    if (!controller?.prompt || !controller.resolveAgent || !ctx.get('systemPrompt')?.assemble) {
      throw new StudioError(503, '当前 DSH Host 未提供所需的原生会话及指令装填接口')
    }
    return controller
  }

  async function globalSkills(sessionId, read, agent = ctx.agents.get(sessionId)) {
    const presets = ctx.get('agentPresets')
    const registry = (agent && presets?.serviceFor(agent, 'skills')) || ctx.get('skills')
    if (!registry?.get || !registry.list) throw new StudioError(503, 'DSH 原生全局 Skill 目录不可用')
    // Omit cwd so same-named project files cannot replace the global binding.
    const query = ctx.get('sessionQuery')
    if (agent || !presets || !query) return read(registry, { scope: agent, signal: lifetime })
    const observation = await query.observeSession(sessionId)
    let preset
    try {
      preset = observation.projections?.values.agentPreset
    } finally {
      observation[Symbol.dispose]()
    }
    const lease = await presets.acquireScope(preset)
    try {
      return await read(registry, { scope: lease?.key, signal: lifetime })
    } finally {
      await lease?.[Symbol.asyncDispose]()
    }
  }

  async function checkNativeSkill(skill, stage, path) {
    if (skill?.name === stage.skill && skill.source === 'user-dsh' && skill.invocation?.userInvocable &&
        typeof skill.path === 'string' && samePath(await realpath(skill.path).catch(() => undefined), path)) return skill
    throw new StudioError(409, `DSH 原生全局目录未加载 ${stage.skill}。请核对 Skill 名称和用户调用权限：${path}`)
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

  async function loadCapabilities(agent, workflowId, stage) {
    await checkStageSupport(agent)
    const root = await realpath(ctx.profileContext.home)
    const paths = filePaths(root, workflowId, stage)
    const [source, harness] = await Promise.all([
      localFile(paths.skillPath, 'Skill', true),
      localFile(paths.harnessPath, 'Harness', true),
    ])
    const [skill, { renderSkillContent }] = await Promise.all([
      globalSkills(agent.id, (registry, options) => registry.get(stage.skill, options), agent),
      nativeSkillAPI(),
    ])
    const skillBody = renderSkillContent(await checkNativeSkill(skill, stage, paths.skillPath))
    await Promise.all([
      verifyUnchanged(paths.skillPath, 'Skill', source.info),
      verifyUnchanged(paths.harnessPath, 'Harness', harness.info),
    ])
    return {
      stageId: stage.id,
      skillPath: relative(root, paths.skillPath).replaceAll('\\', '/'),
      harnessPath: relative(root, paths.harnessPath).replaceAll('\\', '/'),
      skillSourceSha256: source.sha256,
      skillSha256: sha256(skillBody),
      harnessSha256: harness.sha256,
      skillBody,
      harnessBody: harness.body,
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
    const root = await realpath(ctx.profileContext.home)
    let nativeCatalog
    return {
      ...view,
      stages: await Promise.all(view.stages.map(async stage => {
        const paths = filePaths(root, view.id, stage)
        const results = await Promise.allSettled([
          (async () => {
            await localFile(paths.skillPath, 'Skill')
            const skills = await (nativeCatalog ??= globalSkills(sessionId,
              (registry, options) => registry.list(options))).catch(() => {
              throw new StudioError(503, `DSH 原生全局 Skill 目录无法读取：${paths.skillPath}`)
            })
            await checkNativeSkill(skills.find(skill => skill.name === stage.skill), stage, paths.skillPath)
          })(),
          localFile(paths.harnessPath, 'Harness', true),
        ])
        const [skill, harness] = results
        return { ...stage, files: {
          ...paths,
          skillReady: skill.status === 'fulfilled',
          harnessReady: harness.status === 'fulfilled',
          issues: results.flatMap(result => result.status === 'rejected' ? [result.reason.message] : []),
        } }
      })),
    }
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

  async function recordKickoffFailure(kickoff, error) {
    if (kickoffs.get(kickoff.sessionId) === kickoff) kickoffs.delete(kickoff.sessionId)
    try {
      await kernel(kickoff.sessionId, kickoff.workspace, 'workflow_kickoff_failed', {
        operationId: randomUUID(), handoffId: kickoff.handoffId, error,
      }, undefined, 'workflow')
    } catch (failure) {
      if (failure.status !== 409 && !lifetime.aborted) {
        console.error('[my-drama-studio] Workflow kickoff', kickoff.handoffId, failure.message)
      }
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
    if (ownTurn && turn.workspace && claimed.some(invokesStageSkill)) {
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
      return !turn.workspace || message.source?.kind !== 'skill-invocation' || !managedSkills.has(message.source.name)
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
    if (exec.name === 'skill' && exec.agent && managedSkills.has(exec.arguments?.name) &&
        ctx.workspaceRegistry.list().some(workspace => workspace.sessionIds.includes(exec.agent.id))) {
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
    if (action === 'workflow_save_artifact') return { ...data, runId: turn.runId }
    if (action === 'workflow_artifact_get') return data
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
      const { session } = view
      if (session.status === 'running' && (session.activeStageId ?? '') !== stageId) {
        throw new StudioError(409, busyError)
      }
      let snapshot
      if (stageId && stageId !== session.activeStageId) {
        const stage = view.stages.find(item => item.id === stageId)
        if (!stage) throw new StudioError(400, '未知的工作流阶段')
        snapshot = await loadCapabilities(await resolveAgent(sessionId), view.id, stage)
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
      await recordKickoffFailure(kickoff, publicFailure(error))
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
    const handoff = await changeStage(sessionId, async () => {
      const { session, workflowId } = await readSession(sessionId, workspace, lifetime, true)
      const { targetStage } = await kernel(sessionId, workspace, 'workflow_handoff_target',
        { handoffId: input.handoffId }, lifetime, 'workflow')
      if (targetStage && session.status === 'running') throw new StudioError(409, busyError)
      const snapshot = targetStage && await loadCapabilities(await resolveAgent(sessionId), workflowId, targetStage)
      const current = await workspaceFor(ctx, sessionId)
      if (!sameWorkspace(current, workspace)) throw new StudioError(409, 'Session 的 Workspace 已切换')
      return kernel(sessionId, workspace, 'workflow_handoff_confirm', { ...input, snapshot }, lifetime, 'human')
    })
    const { session } = await readSession(sessionId, workspace, lifetime, true)
    if (session.pendingHandoffId !== handoff.handoffId) return { handoff, session }
    const next = await kickoff(sessionId, workspace, handoff.handoffId)
    return { handoff, session: next.session }
  }

  async function retry(sessionId, workspace, handoffId) {
    const { session } = await readSession(sessionId, workspace, lifetime, true)
    if (!handoffId || session.pendingHandoffId !== handoffId) throw new StudioError(409, '当前 Session 没有待启动的该次交接')
    return kickoff(sessionId, workspace, handoffId)
  }

  return { get, activate, confirm, retry, authorizeTool, trackToolResult }
}
