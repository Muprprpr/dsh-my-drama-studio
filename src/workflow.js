import { createHash } from 'node:crypto'
import { open, realpath, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { StudioError } from './kernel.js'

const requestPrefix = 'drama-workflow:'
const toolNames = ['drama_context', 'drama_query', 'drama_append', 'drama_tasks']
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

function isWorkflowMessage(message) {
  return requestId(message)?.startsWith(requestPrefix) === true
}

function keepPinnedSkill(messages, run) {
  return messages.filter(message => message.source?.kind !== 'skill-invocation' ||
    message.source.name !== run.stage.skill || message.id === run.skillMessage.id)
}

function endError(reason) {
  if (reason.kind === 'aborted') return 'DSH Agent 已取消当前阶段'
  if (reason.kind === 'max-tokens') return 'DSH Agent 达到输出上限'
  if (reason.kind === 'blocked') return 'DSH Agent 拒绝执行当前阶段'
  const code = reason.error?.code
  return /^[A-Z_]{1,40}$/.test(code ?? '') ? `DSH Agent 执行失败（${code}）` : 'DSH Agent 执行失败'
}

function outputIds(message) {
  try {
    const value = JSON.parse(message.content.filter(block => block.type === 'text').map(block => block.text).join(''))
    return Array.isArray(value.ids) ? value.ids.filter(id => typeof id === 'string') : []
  } catch {
    return []
  }
}

export function workflowBridge(ctx, kernel, workspaceFor, lifetime) {
  const active = new Map()
  const runtimeRequire = createRequire(ctx.profileContext.installAnchor)
  let nativeAPI

  async function nativeSkillAPI() {
    if (!nativeAPI) {
      const load = name => import(pathToFileURL(runtimeRequire.resolve(name)).href)
      nativeAPI = Promise.all([load('@deepseek-ai/dsh-skill'), load('@deepseek-ai/dsh-llm')])
        .then(([{ renderSkillContent }, { createUserMessage }]) => ({ renderSkillContent, createUserMessage }))
    }
    return nativeAPI
  }

  function nativeController() {
    const controller = ctx.get('sessionController')
    if (!controller?.prompt || !controller.resolveAgent) throw new StudioError(503, 'DSH 原生会话执行服务不可用')
    return controller
  }

  async function globalSkills(sessionId, read, agent = ctx.agents.get(sessionId)) {
    const presets = ctx.get('agentPresets')
    const registry = (agent && presets?.serviceFor(agent, 'skills')) || ctx.get('skills')
    if (!registry?.get || !registry.list) throw new StudioError(503, 'DSH 原生全局 Skill 目录不可用')
    // Web presets mount their filesystem provider in the preset scope.
    // Omitting cwd excludes project roots from the native lookup.
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

  async function get(sessionId, workspace, input) {
    const view = await kernel(sessionId, workspace, 'workflow_get', input, lifetime, 'human')
    const home = ctx.profileContext.home
    const root = await realpath(home)
    let nativeCatalog
    return {
      ...view,
      stages: await Promise.all(view.stages.map(async stage => {
        const paths = filePaths(root, view.id, stage)
        const results = await Promise.allSettled([
          (async () => {
            await localFile(paths.skillPath, 'Skill')
            const skills = await (nativeCatalog ??= globalSkills(sessionId, (registry, options) => registry.list(options))).catch(() => {
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

  function forget(run) {
    if (run.finished && (run.ended || run.turn === undefined) && active.get(run.sessionId) === run) {
      active.delete(run.sessionId)
    }
  }

  function finish(run, error) {
    if (run.settlement) return run.settlement
    const values = { runId: run.runId, ...(error ? { error } : { nodeIds: [...run.nodeIds] }) }
    run.settlement = (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await kernel(run.sessionId, run.workspace, 'workflow_finish', values, undefined, 'workflow')
        } catch (failure) {
          if (attempt >= 2 || failure.status < 500 || lifetime.aborted) throw failure
          await delay(150 * (attempt + 1))
        }
      }
    })().finally(() => {
      run.finished = true
      forget(run)
    })
    return run.settlement
  }

  function finishFromNative(run, error) {
    void finish(run, error).catch(failure => {
      console.error('[my-drama-studio] Workflow settlement', run.runId, failure.message)
    })
  }

  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    const run = active.get(agent.id)
    if (run?.agent === agent && run.requestId === requestId(message)) run.turn = turn
  })

  ctx.on('agent/inbox/discarded', ({ agent, message }) => {
    const run = active.get(agent.id)
    if (run?.agent === agent && run.requestId === requestId(message)) finishFromNative(run, 'DSH 已移除等待执行的阶段任务')
  })

  ctx.on('agent/created', ({ agent }) => {
    // DSH keeps queued messages across restart. Discard abandoned Studio input on resume.
    for (const message of [...agent.inbox.nextTurn, ...agent.inbox.nextStep]) {
      if (isWorkflowMessage(message)) agent.inbox.remove(message.id)
    }
  })

  ctx.on('agent/pre-step', async ({ agent, messages, turn, signal }, next) => {
    const message = messages.find(isWorkflowMessage)
    const run = active.get(agent.id)
    const ownTurn = run?.agent === agent && run.turn === turn && !run.ended
    if (!message) {
      if (!ownTurn || !run.running) return next()
      const decision = await next()
      // A user follow-up may invoke the same Skill through native slash handling.
      return decision.kind === 'enter' ? { ...decision, messages: keepPinnedSkill(decision.messages, run) } : decision
    }
    if (!ownTurn || run.requestId !== requestId(message) || run.settlement || lifetime.aborted) {
      return { kind: 'reject' }
    }
    try {
      if (message.content.length !== 1 || message.content[0].type !== 'text' || message.content[0].text !== run.prompt) {
        throw new StudioError(409, '原生对话队列中的阶段指令已被修改，请重新启动')
      }
      const workspace = await workspaceFor(ctx, agent.id)
      if (workspace.id !== run.workspace.id || workspace.path !== run.workspace.path) {
        throw new StudioError(409, 'Session 的 Workspace 已切换')
      }
      const decision = await next()
      if (decision.kind === 'reject') return decision
      const admission = await kernel(run.sessionId, run.workspace, 'workflow_running', {
        runId: run.runId, skillSha256: run.skillSha256, harnessSha256: run.harnessSha256,
      }, signal, 'workflow')
      if (admission.status !== 'running') throw new StudioError(409, '阶段启动预留已失效，请重新启动')
      run.running = true
      return { ...decision, messages: [...keepPinnedSkill(decision.messages, run), run.skillMessage] }
    } catch (error) {
      if (!signal.aborted) run.failure = error instanceof StudioError ? error.message : '无法记录 DSH Agent 已启动'
      return { kind: 'reject' }
    }
  }, { prepend: true })

  ctx.on('session/event', (session, event) => {
    const run = active.get(session.id)
    if (!run || run.agent?.session !== session || run.turn === undefined || run.ended) return
    const { type, data } = event
    if (type === 'user/message' && data.id === run.skillMessage?.id) run.skillLoaded = true
    if (data?.turn !== run.turn) return
    if (type === 'tool/call' && data.name === 'drama_append') run.appendCalls.add(data.callId)
    if (type === 'tool/result' && run.appendCalls.delete(data.message.toolCallId) && !data.message.isError) {
      for (const id of outputIds(data.message)) run.nodeIds.add(id)
    }
    if (type !== 'turn/end') return
    run.ended = true
    forget(run)
    const error = run.failure ?? (data.reason.kind !== 'completed' ? endError(data.reason)
      : !run.skillLoaded ? `DSH 未载入阶段 Skill：${run.skillPath}`
        : run.stage.id !== generationStage && !run.nodeIds.size ? '阶段没有通过 drama_append 产出可验收的 Canvas 节点' : undefined)
    finishFromNative(run, error)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const run = active.get(agent.id)
    if (run?.agent !== agent) return
    run.ended = true
    forget(run)
    finishFromNative(run, 'DSH Agent 会话已释放')
  })

  ctx.effect(() => async () => {
    await Promise.allSettled([...active.values()].map(async run => {
      if (!run.settlement && run.agent) {
        const pending = [...run.agent.inbox.nextTurn, ...run.agent.inbox.nextStep]
          .find(message => requestId(message) === run.requestId)
        if (pending) run.agent.inbox.remove(pending.id)
        else if (run.turn !== undefined) nativeController().cancel({ sessionId: run.sessionId })
      }
      await finish(run, 'Studio Host 已退出，阶段执行中断')
    }))
  })

  ctx.effect(() => ctx.tools.guard(exec => {
    if (exec.name !== 'skill' || !exec.agent) return
    const run = active.get(exec.agent.id)
    if (run?.agent === exec.agent && run.running && !run.ended && exec.arguments?.name === run.stage.skill) {
      return '当前工作流固定使用启动时的 Skill 快照，请使用原生会话中已注入的阶段指令'
    }
  }))

  function authorizeTool(agent, workspace, action, data) {
    const run = active.get(agent.id)
    if (run?.agent !== agent || run.turn === undefined || run.ended) return
    if (action === 'submit') throw new StudioError(403, '工作流阶段不授权模型生成，请在 Canvas 中独立确认提交')
    if (workspace.id !== run.workspace.id || workspace.path !== run.workspace.path) {
      throw new StudioError(409, 'Session 的 Workspace 已切换')
    }
    if (action !== 'append') return
    if (run.stage.id === generationStage) throw new StudioError(403, '视频生成阶段只读取经 Canvas 授权生成的结果')
    if (!run.running || !run.skillLoaded || run.settlement) {
      throw new StudioError(403, 'DSH 必须载入阶段 Skill 后才可追加产物')
    }
    const additions = new Set((data.nodes ?? []).map(node => node.id))
    if (data.edges?.some(edge => !additions.has(edge.target) && !run.nodeIds.has(edge.target))) {
      throw new StudioError(403, '工作流连线只允许指向本轮新建节点')
    }
  }

  async function start(sessionId, workspace, input) {
    const reservation = await kernel(sessionId, workspace, 'workflow_reserve', input, lifetime, 'workflow')
    const { runId, duplicate, stage, inputs, generationResults, workflowId, workflowName,
      workspaceId, canvasId, definitionVersion } = reservation
    if (duplicate) return { runId }
    const run = { sessionId, workspace, runId, stage, requestId: requestPrefix + runId, appendCalls: new Set(), nodeIds: new Set() }
    try {
      if (active.has(sessionId)) throw new StudioError(409, '当前 Session 正在执行一个工作流阶段')
      active.set(sessionId, run)
      const controller = nativeController()
      const { agent } = await controller.resolveAgent(sessionId)
      if (!agent) throw new StudioError(409, '无法打开指定的 DSH Session')
      run.agent = agent
      const home = ctx.profileContext.home
      const { skillPath, harnessPath } = filePaths(await realpath(home), workflowId, stage)
      run.skillPath = skillPath
      const [skill, harness, { renderSkillContent, createUserMessage }] = await Promise.all([
        localFile(skillPath, 'Skill').then(() => globalSkills(sessionId, (registry, options) => registry.get(stage.skill, options), agent)),
        localFile(harnessPath, 'Harness', true),
        nativeSkillAPI(),
      ])
      const skillContent = renderSkillContent(await checkNativeSkill(skill, stage, skillPath))
      run.skillSha256 = sha256(skillContent)
      run.harnessSha256 = harness.sha256
      run.skillMessage = createUserMessage({
        content: [{ type: 'text', text: skillContent }],
        source: { kind: 'skill-invocation', name: stage.skill, form: 'instructions' },
      })
      const generation = stage.id === generationStage
      if (generation && !generationResults?.length) throw new StudioError(409, '请先在 Canvas 逐项确认并完成视频生成')
      const tools = toolNames.filter(name => (!generation || name !== 'drama_append') && ctx.tools.get(name, agent))
      if (!generation && !tools.includes('drama_append')) throw new StudioError(409, '当前 DSH Session 未启用 drama_append')
      const current = await workspaceFor(ctx, sessionId)
      if (current.id !== workspace.id || current.path !== workspace.path) {
        throw new StudioError(409, 'Session 的 Workspace 已切换')
      }
      if (agent.status !== 'idle' || agent.inbox.nextTurn.length || agent.inbox.nextStep.length) {
        throw new StudioError(409, '当前 DSH Session 仍有任务，请在会话空闲且队列清空后重试')
      }
      run.prompt = [
        '执行 Drama Studio 当前工作流阶段。沿用已注入的 Skill 快照。按已确认的节点 ID 读取所需输入并核对 revision。',
        JSON.stringify({ workspace: { id: workspaceId, path: workspace.path, canvasId },
          workflow: { id: workflowId, name: workflowName, definitionVersion }, stage: { id: stage.id, name: stage.name, runId },
          skill: stage.skill, harnessPath, harness: harness.body, approvedInputs: inputs, generationResults, studioTools: tools }).replaceAll('/', '\\/'),
        generation ? '核对 Canvas 已独立授权并完成的视频结果。只读取并报告，Studio 将自动关联实际生成的视频节点。'
          : '使用 drama_append 新增应交付的产物节点。新连线只指向本轮新建节点，可以复用已有媒体作为来源。只创建视频草稿和所需媒体引用。',
      ].join('\n')
      const admission = await controller.prompt({ sessionId, requestId: run.requestId, mode: 'queue',
        content: [{ type: 'text', text: run.prompt }] }, lifetime)
      if (!admission?.accepted) throw new StudioError(409, 'DSH 未接受阶段任务')
      return { runId }
    } catch (error) {
      const failure = error instanceof StudioError ? error : new StudioError(409, 'DSH 无法启动阶段，请检查会话及模型设置')
      await finish(run, failure.message)
      throw failure
    }
  }

  return { get, start, authorizeTool }
}
