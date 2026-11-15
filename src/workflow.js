import { createHash, randomUUID } from 'node:crypto'
import { open, realpath, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { StudioError } from './kernel.js'

const requestPrefix = 'drama-workflow:'
const artifactTools = new Set(['drama_save_artifact', 'drama_workflow_artifact'])
const documentNodes = new Set(['script', 'shot', 'note'])
const stageSection = 'drama-studio:workflow-stage'
const stageMarker = '[Drama Studio Workflow Stage]'
const probeKey = Symbol('verify workflow system prompt support')
const maxHarnessBytes = 64 * 1024
const generationStage = 'video-generation'

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
    if (info.size > maxHarnessBytes) throw new StudioError(400, `Harness 文件不能超过 64 KiB：${path}`)
    const file = await open(path, 'r')
    try {
      const opened = await file.stat({ bigint: true })
      if (opened.dev !== info.dev || opened.ino !== info.ino || !samePath(await realpath(path), path)) {
        throw new StudioError(409, `Harness 路径已变更：${path}`)
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
      if (length !== size || finished.mtimeNs !== opened.mtimeNs || finished.ctimeNs !== opened.ctimeNs) {
        throw new StudioError(409, `Harness 文件在读取时发生变化，请重试：${path}`)
      }
      const bytes = buffer.subarray(0, length)
      const body = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim()
      if (!body) throw new StudioError(400, `Harness 文件没有指令：${path}`)
      return { body, sha256: sha256(bytes) }
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
  const { stage, skill, harness, workspace, workflowId, handoffId } = run
  const context = {
    workflowId, workspaceId: workspace.id, stageId: stage.id, stageName: stage.name,
    skillSha256: skill.sha256, harnessSha256: harness.sha256, handoffId,
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
    harness.body,
    skill.body,
  ].join('\n\n')
}

function needsPromptReplacement(session) {
  return session.surface.nodes.some(seq => {
    const event = session.eventAt(seq)
    return event?.type === 'system/message' && event.data.message.content.some(block =>
      block.type === 'text' && block.text.includes(stageMarker))
  })
}

export function workflowBridge(ctx, kernel, workspaceFor, lifetime) {
  const turns = new Map()
  const kickoffs = new Map()
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

  async function loadCapabilities(agent, workflowId, stage) {
    nativeController()
    if (!ctx.tools.get('drama_save_artifact', agent) || !ctx.tools.get('drama_workflow_artifact', agent)) {
      throw new StudioError(409, '当前 DSH Session 未启用阶段产物工具')
    }
    const paths = filePaths(await realpath(ctx.profileContext.home), workflowId, stage)
    const [skill, harness, { renderSkillContent }] = await Promise.all([
      localFile(paths.skillPath, 'Skill').then(() => globalSkills(agent.id,
        (registry, options) => registry.get(stage.skill, options), agent)),
      localFile(paths.harnessPath, 'Harness', true),
      nativeSkillAPI(),
      checkPromptScope(agent),
    ])
    const body = renderSkillContent(await checkNativeSkill(skill, stage, paths.skillPath))
    return { skill: { body, sha256: sha256(body) }, harness }
  }

  async function readSession(sessionId, workspace, signal = lifetime) {
    return kernel(sessionId, workspace, 'workflow_session', {}, signal, 'workflow')
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
        if (!turn.started) {
          if (turn.kickoff && error) await recordKickoffFailure(turn.kickoff, error)
          else if (turn.stage && error && !lifetime.aborted) {
            await kernel(turn.agent.id, turn.workspace, 'workflow_turn_failed', {
              operationId: randomUUID(), stageId: turn.stage.id, error,
            }, undefined, 'workflow')
          }
          return
        }
        const input = { operationId: randomUUID(), runId: turn.runId, ...(error && { error }) }
        for (let attempt = 0; ; attempt++) {
          try {
            return await kernel(turn.agent.id, turn.workspace, 'workflow_turn_finish', input, undefined, 'workflow')
          } catch (failure) {
            if (attempt >= 2 || failure.status < 500 || lifetime.aborted) throw failure
            await delay(150 * (attempt + 1))
          }
        }
      } catch (failure) {
        if (!lifetime.aborted) console.error('[my-drama-studio] Workflow settlement', turn.runId, failure.message)
      } finally {
        if (turns.get(turn.agent.id) === turn) turns.delete(turn.agent.id)
      }
    })()
    return turn.settlement
  }

  async function prepareTurn(turn, signal) {
    await turn.previous
    if (turn.staleKickoff && !turn.hasChat) return
    const { agent } = turn
    try {
      const workspace = await workspaceFor(ctx, agent.id)
      turn.workspace = workspace
      const { session, stage, workflowId } = await readSession(agent.id, workspace, signal)
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
      Object.assign(turn, await loadCapabilities(agent, workflowId, stage))
      const current = await workspaceFor(ctx, agent.id)
      if (!sameWorkspace(current, workspace)) throw new StudioError(409, 'Session 的 Workspace 已切换')
      signal.throwIfAborted()
      turn.runId = randomUUID()
      // Complete the write even if the Agent is cancelled during admission. Settlement
      // then closes the same run instead of leaving SQLite in Running.
      const input = {
        operationId: turn.runId, runId: turn.runId, stageId: stage.id,
        skillSha256: turn.skill.sha256, harnessSha256: turn.harness.sha256,
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

  ctx.on('agent/pre-step', async ({ agent, turn: number, step }, next) => {
    const turn = turns.get(agent.id)
    const ownTurn = turn?.agent === agent && turn.number === number
    if (ownTurn && (turn.failure || turn.staleKickoff && !turn.hasChat)) return { kind: 'reject' }
    const decision = await next()
    if (ownTurn && turn.instructions && turn.promptRevision !== promptRevision) {
      turn.failure = 'DSH 原生指令设置已更改，请重新发送本轮消息'
      return { kind: 'reject' }
    }
    if (decision.kind === 'reject') return decision
    const messages = ownTurn ? decision.messages.filter(message => {
      if (isKickoffMessage(message)) return requestId(message) === turn.kickoff?.requestId
      return !turn.instructions || message.source?.kind !== 'skill-invocation' || message.source.name !== turn.stage.skill
    }) : decision.messages
    // DeepSeek can retain old system messages in its request series. A new
    // series makes the native loop replace them when switching, exiting or
    // beginning a stage turn with updated confirmed inputs.
    if (step === 1 && ((ownTurn && turn.instructions) || needsPromptReplacement(agent.session))) {
      return { ...decision, messages, startsRequestSeries: true }
    }
    return { ...decision, messages }
  }, { prepend: true })

  ctx.on('session/event', (session, event) => {
    const turn = turns.get(session.id)
    if (event.type === 'turn/end' && turn?.agent.session === session && event.data.turn === turn.number) {
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
  })

  ctx.effect(() => ctx.tools.guard(exec => {
    if (exec.name !== 'skill' || !exec.agent) return
    const turn = turns.get(exec.agent.id)
    if (turn?.agent === exec.agent && turn.started && !turn.settlement && exec.arguments?.name === turn.stage.skill) {
      return '当前阶段已通过 DSH 加载全局 Skill，继续使用本轮系统指令中的版本'
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
    let versions
    if (stageId) {
      const view = await kernel(sessionId, workspace, 'workflow_get', {}, lifetime, 'human')
      const stage = view.stages.find(item => item.id === stageId)
      if (!stage) throw new StudioError(400, '未知的工作流阶段')
      const agent = await resolveAgent(sessionId)
      const { skill, harness } = await loadCapabilities(agent, view.id, stage)
      versions = { skillSha256: skill.sha256, harnessSha256: harness.sha256 }
    }
    const current = await workspaceFor(ctx, sessionId)
    if (!sameWorkspace(current, workspace)) throw new StudioError(409, 'Session 的 Workspace 已切换')
    return kernel(sessionId, workspace, 'workflow_activate', { operationId, stageId, ...versions }, lifetime, 'human')
  }

  async function submitKickoff(kickoff) {
    const { sessionId, workspace, handoffId } = kickoff
    try {
      const { session, stage, workflowId } = await readSession(sessionId, workspace)
      if (session.pendingHandoffId !== handoffId || !stage) {
        if (kickoffs.get(sessionId) === kickoff) kickoffs.delete(sessionId)
        return { session }
      }
      kickoff.agent = await resolveAgent(sessionId)
      await loadCapabilities(kickoff.agent, workflowId, stage)
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
    return readSession(sessionId, workspace)
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
    const handoff = await kernel(sessionId, workspace, 'workflow_handoff_confirm', input, lifetime, 'human')
    const { session } = await readSession(sessionId, workspace)
    if (session.pendingHandoffId !== handoff.handoffId) return { handoff, session }
    const next = await kickoff(sessionId, workspace, handoff.handoffId)
    return { handoff, session: next.session }
  }

  async function retry(sessionId, workspace, handoffId) {
    const { session } = await readSession(sessionId, workspace)
    if (!handoffId || session.pendingHandoffId !== handoffId) throw new StudioError(409, '当前 Session 没有待启动的该次交接')
    return kickoff(sessionId, workspace, handoffId)
  }

  return { get, activate, confirm, retry, authorizeTool, trackToolResult }
}
