import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const name = 'drama-workflow-lifecycle-fixture'
export const inject = ['agentPresets', 'agents', 'connection', 'commands', 'llm', 'sessionController', 'systemPrompt', 'webServer', 'workspaceRegistry']

const alpha = 'storyboard'
const beta = 'asset-binding'
const provider = 'drama-wire-fixture'
const inHistory = 'fixture-in-history'
const replace = 'fixture-replace'
const transitionError = /阶段切换尚未完成/u
const managedSkillError = /该 Skill 属于 Workflow 管理的阶段能力/u
const stageText = (stage, version, kind) => ['STUDIO_WIRE', stage, version, kind].join('_')
const filler = 'Separate parts of a storyboard discussion create context pressure. '.repeat(1100)

export function apply(ctx) {
  const cancellation = new AbortController()
  const done = verify(ctx, cancellation.signal).catch(error => {
    if (!cancellation.signal.aborted) console.error('[' + name + '] FAIL', error.stack)
  })
  ctx.effect(() => async () => {
    cancellation.abort()
    await done
  }, name)
}

async function until(check, signal, label, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    signal.throwIfAborted()
    const result = await check()
    if (result) return result
    await delay(30, undefined, { signal })
  }
  throw new Error('Timed out: ' + label)
}

async function installStage(home, stage, version) {
  const skill = join(home, 'skills', 'drama-' + stage)
  const harness = join(home, 'drama-studio', 'workflows', 'drama-production', 'stages', stage)
  await mkdir(skill, { recursive: true })
  await mkdir(harness, { recursive: true })
  await writeFile(join(skill, 'SKILL.md'), [
    '---', 'name: drama-' + stage, 'description: Isolated Workflow lifecycle test skill.', '---',
    stageText(stage, version, 'SKILL'), '',
  ].join('\n'))
  await writeFile(join(harness, 'harness.md'), stageText(stage, version, 'HARNESS') + '\n')
}

function wireText(contents) {
  if (typeof contents === 'string') return contents
  return (contents ?? []).flatMap(block => {
    if (typeof block.text === 'string') return [block.text]
    if (block.type === 'tool_result') return [wireText(block.content)]
    return []
  }).join('\n')
}

function wireParts(body) {
  return {
    system: [wireText(body.system), ...body.messages.filter(message => message.role === 'system').map(message => wireText(message.content))].join('\n'),
    user: body.messages.filter(message => message.role === 'user').map(message => wireText(message.content)).join('\n'),
    assistant: body.messages.filter(message => message.role === 'assistant').map(message => wireText(message.content)).join('\n'),
  }
}

function assertStage(record, stage, version) {
  assert.ok(record, 'Expected a physical HTTP request')
  const parts = wireParts(record)
  const expected = stage ? [stageText(stage, version, 'HARNESS'), stageText(stage, version, 'SKILL')].sort() : []
  assert.deepEqual([...parts.system.matchAll(/STUDIO_WIRE_[a-z-]+_V\d+_(?:HARNESS|SKILL)/gu)].map(match => match[0]).sort(), expected)
  assert.doesNotMatch(parts.user, /STUDIO_WIRE_[a-z-]+_V\d+_(?:HARNESS|SKILL)/u)
  assert.doesNotMatch(parts.assistant, /STUDIO_WIRE_[a-z-]+_V\d+_(?:HARNESS|SKILL)/u)
}

function describeWire(record) {
  const markers = text => [...text.matchAll(/STUDIO_WIRE_[a-z-]+_V\d+_(?:HARNESS|SKILL)/gu)].map(match => match[0])
  return {
    purpose: record.auditPurpose,
    model: record.model,
    leadingSystem: markers(wireText(record.system)),
    systemMessages: record.messages.filter(message => message.role === 'system').flatMap(message => markers(wireText(message.content))),
  }
}

function evidence(label, details) {
  console.info('[' + name + '] WIRE ' + label + ' ' + JSON.stringify(details))
}

async function createEndpoint(signal) {
  const records = []
  const scripts = new Map()
  const http = createServer((request, response) => {
    void reply(request, response).catch(error => response.destroy(error))
  })
  async function reply(request, response) {
    assert.equal(request.url, '/anthropic/v1/messages')
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    if (body.auditPurpose === 'agent' || body.auditPurpose === 'compaction') records.push(body)
    const script = scripts.get(body.auditSession + '/' + body.auditPurpose)?.shift()
    if (script?.hold) {
      script.hold.entered = true
      await Promise.race([script.hold.released, once(response, 'close')])
      if (response.destroyed) return
    }
    if (script?.fail) {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { type: 'authentication_error', message: 'Fixture rejected request' } }))
      return
    }
    const usage = { input_tokens: Math.ceil(JSON.stringify(body).length / 4), output_tokens: 2 }
    const start = { type: 'message_start', message: { id: randomUUID(), model: body.model, usage } }
    const call = script?.call
    const blocks = call
      ? [
          { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool_' + randomUUID(), name: call.name, input: {} } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.args) } },
        ]
      : [
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: body.auditPurpose === 'compaction' ? 'A short summary.' : 'Neutral fixture reply.' } },
        ]
    const events = [start, ...blocks, { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: call ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' }]
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(events.map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join(''))
  }
  http.listen(0, '127.0.0.1')
  await once(http, 'listening', { signal })
  return {
    address: 'http://127.0.0.1:' + http.address().port + '/anthropic',
    records, scripts,
    async close() {
      const done = once(http, 'close')
      http.close()
      http.closeAllConnections()
      await done
    },
  }
}

async function installWireAdapter(ctx, endpoint) {
  const require = createRequire(process.env.DRAMA_DSH_CLI)
  const { DeepSeekAdapter, resolveAdapterOptions } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm-deepseek')).href)
  let capacity = 1_048_576
  const models = [
    { id: inHistory, provider, name: 'Fixture in-history', systemPromptUpdate: 'in-history', toolUpdate: 'addition-only' },
    { id: replace, provider, name: 'Fixture leading-only' },
  ]
  ctx.llm.registerAdapter([provider], new DeepSeekAdapter({
    options: () => resolveAdapterOptions({
      baseURL: endpoint.address, maxTokens: 1000,
      models: models.map(model => ({ ...model, contextWindow: capacity, maxTokens: 1000 })),
    }),
    discoverModels: async () => models,
    resolveAuth: async () => ({ headers: {} }),
    resolveUserId: () => 'studio-audit',
    prepareExtensions: async ({ purpose, sessionId }) => ({
      fields: { auditPurpose: purpose ?? 'agent', auditSession: sessionId }, accept: async () => {},
    }),
  }))
  return value => { capacity = value }
}

function holdRequest() {
  const { promise: released, resolve: release } = Promise.withResolvers()
  return { released, release, entered: false }
}

async function verify(ctx, signal) {
  const home = process.env.DSH_HOME
  assert.ok(home && basename(dirname(home)).startsWith('drama-workflow-lifecycle-'))
  const stateFile = join(home, 'restart-lifecycle.json')
  const state = await readFile(stateFile, 'utf8').then(JSON.parse, error => {
    if (error.code !== 'ENOENT') throw error
  })
  const origin = ctx.webServer.getOrigin()
  const login = ctx.connection.authenticatedUrl(origin)
  const cookie = await until(async () => {
    const response = await fetch(login, { redirect: 'manual', signal })
    return response.status === 303 ? response.headers.get('set-cookie')?.split(';', 1)[0] : undefined
  }, signal, 'owner login')

  const request = (path, data) => fetch(new URL('/api/drama/' + path, origin), {
    method: 'POST', headers: { 'content-type': 'application/json', origin, cookie },
    body: JSON.stringify(data), signal,
  })
  async function ok(response, label) {
    const data = await response.json()
    assert.ok(response.ok, label + ' HTTP ' + response.status + ' ' + JSON.stringify(data))
    return data
  }
  const op = (ticket, action, data = {}) => request('operation', { ticket, action, data: { operationId: randomUUID(), ...data } })
  const read = async ticket => (await ok(await request('operation', { ticket, action: 'workflow_get' }), 'workflow_get')).session
  async function activate(ticket, stageId) {
    return ok(await op(ticket, 'workflow_activate', { stageId }), 'workflow_activate ' + stageId)
  }
  const init = sessionId => until(async () => {
    const response = await request('init', { sessionId })
    if (response.status === 404 && !response.headers.get('content-type')?.includes('application/json')) {
      await response.body?.cancel()
      return
    }
    return ok(response, 'init')
  }, signal, 'Studio routes')
  const select = (sessionId, model) => ctx.sessionController.selectModel({ sessionId, provider, model })
  const endpoint = await createEndpoint(signal)
  try {
    const setCapacity = await installWireAdapter(ctx, endpoint)
    const { records, scripts } = endpoint
    const chat = async (sessionId, text, script = []) => {
      const found = await ctx.sessionController.resolveAgent(sessionId)
      assert.ok(found.agent)
      const agent = found.agent
      const previous = agent.session.snapshotEvents().at(-1)?.seq ?? -1
      scripts.set(sessionId + '/agent', script)
      const content = [{ type: 'text', text }]
      const admission = await ctx.sessionController.prompt({ sessionId, requestId: randomUUID(), mode: 'queue', content }, signal)
      assert.equal(admission.accepted, true)
      return { agent, previous }
    }
    async function ended({ agent, previous }) {
      return until(() => agent.session.snapshotEvents().find(event => event.seq > previous && event.type === 'turn/end'), signal, 'native turn end')
    }
    const settled = (ticket, check, label) => until(async () => {
      const session = await read(ticket)
      return session.status !== 'running' && check(session) ? session : undefined
    }, signal, label)
    const ready = ticket => settled(ticket, session => !session.transitionPending, 'transition barrier cleared')
    async function send(sessionId, ticket, text, stage, version, { allowCompaction = false, script = [] } = {}) {
      const before = records.length
      const turn = await chat(sessionId, text, script)
      const end = await ended(turn)
      assert.equal(end.data.reason.kind, 'completed', JSON.stringify(end))
      const requests = records.slice(before).filter(record => record.auditSession === sessionId)
      const main = requests.filter(record => record.auditPurpose === 'agent')
      assert.ok(main.length > 0)
      assert.ok(wireParts(main[0]).user.includes(text))
      for (const record of main) assertStage(record, stage, version)
      if (!allowCompaction) assert.equal(requests.length, main.length, text.slice(0, 100))
      await ready(ticket)
      return { ...turn, requests }
    }
    async function deniedCompact(agent) {
      const previous = agent.session.snapshotEvents().at(-1)?.seq ?? -1
      const before = records.length
      const outcome = await ctx.commands.execute(agent, '/compact', [], signal).catch(error => error)
      const events = agent.session.snapshotEvents().filter(event => event.seq > previous)
      const error = outcome?.result?.text ?? outcome?.message
      assert.match(error ?? '', transitionError)
      assert.ok(events.some(event => event.type === 'command/done' && transitionError.test(event.data.text)))
      assert.equal(events.some(event => event.type === 'compaction/start'), false)
      assert.equal(records.length, before, 'Pending manual compact reached a provider')
    }
    async function manualCompact(agent, stage, version) {
      const before = records.length
      const result = await ctx.commands.execute(agent, '/compact', [], signal)
      assert.equal(result?.result.kind, 'success', JSON.stringify(result))
      assert.match(result.result.text, /Compacted \d+ history items/u)
      const requests = records.slice(before)
      assert.ok(requests.length && requests.every(record => record.auditPurpose === 'compaction'))
      for (const record of requests) assertStage(record, stage, version)
    }

    if (state) {
      const [{ ticket: a1 }, { ticket: a2 }, { ticket: b1 }] = await Promise.all(state.ids.map(init))
      const recovering = await settled(a1, session => session.status === 'failed', 'orphaned running turn recovered')
      assert.equal(recovering.activeStageId, beta)
      assert.equal(recovering.snapshotId, state.betaSnapshot)
      assert.equal((await read(a2)).transitionPending, true)
      assert.equal((await read(b1)).transitionPending, true)
      assert.equal((await read(b1)).snapshotId, state.alphaSnapshot)
      const agents = await Promise.all(state.ids.map(id => ctx.sessionController.resolveAgent(id)))
      await deniedCompact(agents[1].agent)
      await deniedCompact(agents[2].agent)
      const recovered = [
        await send(state.ids[0], a1, 'Retry the interrupted Beta discussion.', beta, 'V1'),
        await send(state.ids[1], a2, 'Continue in ordinary chat after restart.'),
        await send(state.ids[2], b1, 'Resume the frozen Alpha activation after restart.', alpha, 'V2'),
      ]
      evidence('restarted main requests', recovered.map(turn => describeWire(turn.requests[0])))
      console.info('[' + name + '] PASS restart (interrupted turn, frozen version, pending exited and activated sessions)')
      return
    }

    await installStage(home, alpha, 'V1')
    await installStage(home, beta, 'V1')
    const ordinarySkill = join(home, 'skills', 'fixture-ordinary')
    await mkdir(ordinarySkill, { recursive: true })
    await writeFile(join(ordinarySkill, 'SKILL.md'), '---\nname: fixture-ordinary\ndescription: Ordinary independent skill.\n---\nWIRE_ORDINARY_SKILL_BODY\n')
    async function workspace(label) {
      const path = join(home, label)
      await mkdir(join(path, '.git'), { recursive: true })
      return ctx.workspaceRegistry.create(path)
    }
    const [projectA, projectB] = await Promise.all([workspace('workspace-a'), workspace('workspace-b')])
    const ids = []
    for (const project of [projectA, projectA, projectB]) {
      ids.push((await ctx.sessionController.create({ workspaceId: project.id })).sessionId)
    }
    const [id1, id2, id3] = ids
    for (const [index, id] of ids.entries()) await select(id, index === 1 ? replace : inHistory)
    const [{ ticket: a1 }, { ticket: a2 }, { ticket: b1 }] = await Promise.all(ids.map(init))
    for (const ticket of [a1, a2, b1]) await ok(await op(ticket, 'bind'), 'bind')
    const beforeActivation = await ctx.sessionController.resolveAgent(id2)
    const unmountComplete = beforeActivation.agent.ctx.systemPrompt.section({
      name: 'fixture-complete-prompt', order: 0, complete: true, text: 'Standalone preset rules',
    })
    const lockedPrompt = await op(a2, 'workflow_activate', { stageId: beta })
    assert.equal(lockedPrompt.status, 409)
    assert.match((await lockedPrompt.json()).error, /完整系统指令/u)
    unmountComplete()

    const invalidStage = 'shooting-script'
    const testSkill = join(home, 'skills', 'drama-' + invalidStage, 'SKILL.md')
    const testHarness = join(home, 'drama-studio', 'workflows', 'drama-production', 'stages', invalidStage, 'harness.md')
    async function rejectsInvalidStage(expected, status) {
      const before = await read(a2)
      const rejected = await op(a2, 'workflow_activate', { stageId: invalidStage })
      assert.equal(rejected.ok, false)
      if (status) assert.equal(rejected.status, status)
      assert.match((await rejected.json()).error, expected)
      assert.deepEqual(await read(a2), before)
    }

    for (let i = 0; i < 3; i++) await send(id1, a1, 'Plain discussion ' + i)
    await activate(a1, alpha)
    const frozen = await read(a1)
    assert.equal(frozen.transitionPending, true)
    assert.ok(frozen.snapshotId)
    for (let i = 0; i < 3; i++) await send(id1, a1, 'Original Alpha ' + i + '. ' + filler, alpha, 'V1')
    await installStage(home, alpha, 'V2')
    await activate(a1, alpha)
    const same = await read(a1)
    assert.equal(same.activation, frozen.activation)
    assert.equal(same.snapshotId, frozen.snapshotId)
    for (let i = 0; i < 3; i++) await send(id1, a1, 'Pinned Alpha ' + i + '. ' + filler, alpha, 'V1')

    const held = holdRequest()
    const running = await chat(id1, 'Hold this exact Alpha turn.', [{ hold: held }])
    await until(() => held.entered, signal, 'active Alpha request')
    for (const stageId of [beta, '']) {
      const denied = await op(a1, 'workflow_activate', { stageId })
      assert.equal(denied.status, 409)
      assert.match((await denied.json()).error, /当前阶段正在执行/u)
    }
    await Promise.all([activate(a2, alpha), activate(b1, alpha)])
    await Promise.all([
      send(id2, a2, 'Leading-only Alpha under new activation.', alpha, 'V2'),
      send(id3, b1, 'Different workspace new Alpha.', alpha, 'V2'),
    ])
    held.release()
    assert.equal((await ended(running)).data.reason.kind, 'completed')
    await ready(a1)
    await installStage(home, invalidStage, 'V1')
    await rm(testHarness)
    await rejectsInvalidStage(/Harness/u, 404)
    await installStage(home, invalidStage, 'V1')
    await rm(testSkill)
    await rejectsInvalidStage(/Skill/u, 404)
    await writeFile(testSkill, '---\nname: invalid/name\ndescription: Fixture invalid Skill\n---\nBroken metadata.\n')
    await rejectsInvalidStage(/Skill/u, 409)
    await installStage(home, invalidStage, 'V1')
    const target = beforeActivation.agent
    const registry = ctx.agentPresets.serviceFor(target, 'skills') ?? ctx.get('skills')
    const original = registry?.[Symbol.for('cordis.original')] ?? registry
    const get = original.get
    let replaced = false
    original.get = async function (skillName, options) {
      const definition = await get.call(this, skillName, options)
      if (!replaced && options?.scope === target && skillName === 'drama-' + invalidStage) {
        assert.equal(definition?.name, skillName)
        replaced = true
        const replacement = testSkill + '.replacement'
        await writeFile(replacement, '---\nname: ' + skillName + '\ndescription: Fixture edited during activation.\n---\nNew rules.\n')
        await rename(replacement, testSkill)
      }
      return definition
    }
    try {
      await rejectsInvalidStage(/Skill 文件在激活时发生变化/u, 409)
      assert.equal(replaced, true)
    } finally {
      original.get = get
    }
    const holdCompaction = holdRequest()
    scripts.set(id1 + '/compaction', [{ hold: holdCompaction }])
    const compacting = manualCompact(running.agent, alpha, 'V1')
    try {
      await until(() => holdCompaction.entered, signal, 'in-flight manual compaction')
      const denied = await op(a1, 'workflow_activate', { stageId: beta })
      assert.equal(denied.status, 409)
      assert.equal((await read(a1)).activeStageId, alpha)
    } finally {
      holdCompaction.release()
      await compacting
    }
    for (let i = 0; i < 6; i++) await send(id1, a1, 'Alpha pressure ' + i + '. ' + filler, alpha, 'V1')

    await Promise.all([activate(a1, beta), activate(a2, beta)])
    await deniedCompact(running.agent)
    assert.equal((await read(a1)).transitionPending, true)
    assert.equal((await read(a2)).transitionPending, true)
    assert.equal((await read(b1)).activeStageId, alpha)
    setCapacity(100_000)
    let before = records.length
    const failed = await chat(id1, 'First Beta HTTP failure.', [{ fail: true }])
    assert.equal((await ended(failed)).data.reason.kind, 'error')
    await settled(a1, session => session.transitionPending, 'pending after first HTTP failure')
    assert.equal(records.length, before + 1, 'Automatic compaction reached an HTTP provider before the barrier cleared')
    assertStage(records.at(-1), beta, 'V1')
    assert.equal(failed.agent.session.snapshotEvents().some(event => event.seq > failed.previous && event.type === 'compaction/start'), false)
    await deniedCompact(running.agent)

    before = records.length
    const holdCancel = holdRequest()
    const cancelled = await chat(id1, 'Cancelled first Beta.', [{ hold: holdCancel }])
    await until(() => holdCancel.entered, signal, 'cancel target request')
    cancelled.agent.cancel({ kind: 'user' })
    holdCancel.release()
    assert.match((await ended(cancelled)).data.reason.kind, /abort|cancel/u)
    await settled(a1, session => session.transitionPending, 'pending after cancellation')
    assert.equal(records.length, before + 1)
    assertStage(records.at(-1), beta, 'V1')

    const first = await send(id1, a1, 'First completed Beta after transition.', beta, 'V1')
    assert.ok(first.agent.session.snapshotEvents().some(event => event.seq > first.previous && event.type === 'request/header'
      && (event.data.startsSeries || event.data.reason === 'series')))
    assert.equal(first.agent.session.snapshotEvents().some(event => event.seq > first.previous && event.type === 'compaction/start'), false)
    const auto = await send(id1, a1, 'Automatic pressure control after Beta barrier clears.', beta, 'V1', { allowCompaction: true })
    const summaries = auto.requests.filter(record => record.auditPurpose === 'compaction')
    assert.ok(summaries.length > 0, 'The pressure positive control did not trigger native automatic compaction')
    for (const request of summaries) assertStage(request, beta, 'V1')
    assert.ok(auto.agent.session.snapshotEvents().some(event => event.seq > auto.previous && event.type === 'compaction/summary'))
    setCapacity(1_048_576)

    const lead = await send(id2, a2, 'Leading-only Beta after Alpha.', beta, 'V1')
    assert.equal(lead.requests[0].model, replace)
    assert.equal(first.requests[0].model, inHistory)
    evidence('transition and compaction', {
      inHistory: describeWire(first.requests[0]), leadingOnly: describeWire(lead.requests[0]),
      pendingManualRequests: 0, pendingAutomaticRequests: 0,
      automaticAfterRelease: summaries.map(describeWire),
    })
    const skillCall = skillName => ({ call: { name: 'skill', args: { name: skillName } } })
    for (const stage of [alpha, beta]) {
      const blocked = await send(id1, a1, 'Request managed Skill tool ' + stage + '.', beta, 'V1', { script: [skillCall('drama-' + stage)] })
      assert.match(wireParts(blocked.requests.at(-1)).user, managedSkillError)
    }
    const allowed = await send(id1, a1, 'Request ordinary Skill tool.', beta, 'V1', { script: [skillCall('fixture-ordinary')] })
    assert.match(wireParts(allowed.requests.at(-1)).user, /WIRE_ORDINARY_SKILL_BODY/u)

    for (const stage of [alpha, beta]) {
      before = records.length
      const slash = await chat(id1, 'Try using /drama-' + stage + ' in this message.')
      const stopped = await ended(slash)
      const appended = slash.agent.session.snapshotEvents().filter(event => event.seq > slash.previous)
      assert.match(JSON.stringify(appended), managedSkillError)
      assert.equal(appended.some(event => event.type === 'user/message' && event.data.source.kind === 'skill-invocation'), false)
      assert.notEqual(stopped.data.reason.kind, 'completed')
      assert.equal(records.length, before)
    }
    const ordinary = await send(id1, a1, 'Try using /fixture-ordinary here.', beta, 'V1')
    assert.match(wireParts(ordinary.requests[0]).user, /WIRE_ORDINARY_SKILL_BODY/u)
    await send(id1, a1, 'Beta final draft discussion. ' + filler, beta, 'V1')
    await manualCompact(running.agent, beta, 'V1')
    await activate(a1, '')
    await deniedCompact(running.agent)
    await send(id1, a1, 'Return to plain chat without either stage.')
    await activate(a1, alpha)
    await send(id1, a1, 'Reactivate Alpha and take the latest files.', alpha, 'V2')

    const disposableId = 'session-' + randomUUID()
    const disposable = await ctx.agents.create({
      sessionId: disposableId, meta: { cwd: projectB.path, agentPreset: ctx.agentPresets.defaultId },
      agentOptions: { provider, model: inHistory },
      setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx) },
    })
    const holdDispose = holdRequest()
    let disposedTicket
    try {
      await projectB.attachSession(disposableId)
      await select(disposableId, inHistory)
      disposedTicket = (await init(disposableId)).ticket
      await ok(await op(disposedTicket, 'bind'), 'bind disposable agent')
      await activate(disposedTicket, alpha)
      await chat(disposableId, 'Hold first Alpha to dispose the Agent.', [{ hold: holdDispose }])
      await until(() => holdDispose.entered, signal, 'running first turn at Agent dispose')
      const executing = await read(disposedTicket)
      assert.equal(executing.status, 'running')
      assert.equal(executing.transitionPending, true)
    } finally {
      await disposable.dispose().finally(holdDispose.release)
    }
    assert.equal(ctx.agents.get(disposableId), undefined)
    const disposedState = await settled(disposedTicket, session => session.status === 'failed', 'disposed turn settled')
    assert.equal(disposedState.transitionPending, true)
    await activate(disposedTicket, beta)
    await send(disposableId, disposedTicket, 'Switch to Beta after Agent disposal.', beta, 'V1')

    await activate(a2, '')
    await activate(b1, '')
    await activate(b1, alpha)
    const pendingB = await read(b1)
    assert.equal(pendingB.transitionPending, true)
    await installStage(home, alpha, 'V3')
    await activate(a1, beta)
    await send(id1, a1, 'Complete the Beta transition before the interrupted turn.', beta, 'V1')
    const holdRestart = holdRequest()
    await chat(id1, 'Hold Beta until Host restart.', [{ hold: holdRestart }])
    await until(() => holdRestart.entered, signal, 'in-flight turn at restart')
    const runningState = await read(a1)
    assert.equal(runningState.status, 'running')
    await writeFile(stateFile, JSON.stringify({ ids, betaSnapshot: runningState.snapshotId, alphaSnapshot: pendingB.snapshotId }))
    console.info('[' + name + '] PASS wire (replace, in-history, compaction, phase guards, frozen versions, file replacement, isolated sessions, Agent dispose)')
    await until(() => false, signal, 'host stops the held fixture', 180_000)
  } finally {
    await endpoint.close()
  }
}

async function runFixture() {
  assert.equal(process.platform, 'win32', 'Run with the Windows x64 DSH runtime')
  assert.equal(process.arch, 'x64')
  const entry = fileURLToPath(import.meta.url)
  const repo = resolve(dirname(entry), '..')
  const cli = resolve(process.env.DRAMA_DSH_CLI ?? join(repo, '.runtime', 'dsh-rc3', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  const root = await mkdtemp(join(tmpdir(), 'drama-workflow-lifecycle-'))
  try {
    const { resolve: resolvePackage } = createRequire(cli)
    const schema = resolvePackage('@deepseek-ai/schemastery/package.json')
    await symlink(dirname(dirname(dirname(schema))), join(root, 'node_modules'), 'junction')
    const host = join(root, 'host.js')
    const fixture = join(root, 'workflow-lifecycle.mjs')
    await copyFile(join(repo, 'dist', 'host.js'), host)
    await copyFile(process.env.DRAMA_UIUX_STUDIO_EXE ?? join(repo, 'dist', 'studio.exe'), join(root, 'studio.exe'))
    await copyFile(entry, fixture)
    await writeFile(join(root, 'package.json'), '{"type":"module"}\n')
    const overlay = join(root, 'fixture.yml')
    const pathYAML = path => JSON.stringify(path.replaceAll('\\', '/'))
    await writeFile(overlay, [
      '- insert:',
      '    - id: my-drama-studio',
      '      name: ' + pathYAML(host),
      '    - id: ' + name,
      '      name: ' + pathYAML(fixture),
    ].join('\n') + '\n')
    for (const milestone of ['wire', 'restart']) {
      const child = spawn(process.execPath, [cli, 'web', '--patch', overlay, '--host', '127.0.0.1', '--port', '0', '--no-open'], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env, DRAMA_DSH_CLI: cli, DSH_HOME: join(root, 'home'), DSH_AGENTS_HOME: join(root, 'agents'),
          DSH_TELEMETRY_DISABLED: '1', DSH_TOOLS_MODE: 'native', DEEPSEEK_API_KEY: '', DRAMA_REAL_WORKFLOW: '',
        },
      })
      const exited = once(child, 'exit')
      const poll = new AbortController()
      let logs = ''
      for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { logs += data.toString() })
      const pass = '[' + name + '] PASS ' + milestone
      try {
        await Promise.race([exited, until(() => logs.includes(pass) || logs.includes('[' + name + '] FAIL'), poll.signal, pass, 90_000)])
        assert.ok(logs.includes(pass), 'Missing ' + pass)
        for (const line of logs.split(/\r?\n/u)) {
          if (line.includes(pass) || line.startsWith('[' + name + '] WIRE ')) console.info(line)
        }
      } catch (error) {
        console.error(logs.replace(/(https?:\/\/[^\s?'"<>]+)\?[^\s'"<>]+/gu, '$1?[redacted]'))
        throw error
      } finally {
        poll.abort()
        if (child.exitCode === null) child.kill()
        await exited
      }
    }
  } finally {
    assert.equal(dirname(root), tmpdir())
    assert.ok(basename(root).startsWith('drama-workflow-lifecycle-'))
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await runFixture()
