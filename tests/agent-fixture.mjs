import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Load only as an explicit --patch row in an isolated DSH Web test profile.
export const name = 'drama-agent-fixture'
export const inject = ['agents', 'connection', 'llm', 'sessionController', 'tools', 'webServer', 'workspaceRegistry']

const provider = 'drama-fixture'
const model = 'scripted'

export function apply(ctx) {
  const life = new AbortController()
  const run = verify(ctx, life.signal).catch(error => {
    if (!life.signal.aborted) console.error('[drama-agent-fixture] FAIL', error.stack)
  })
  ctx.effect(() => async () => {
    life.abort()
    await run
  }, name)
}

async function verify(ctx, signal) {
  assert.ok(process.env.DSH_HOME, 'The fixture requires an isolated DSH_HOME')
  const root = join(process.env.DSH_HOME, 'drama-agent-fixture')
  const statePath = join(root, 'restart.json')
  const workspacePath = join(root, 'project')
  const state = await readFile(statePath, 'utf8').then(JSON.parse, error => {
    if (error.code !== 'ENOENT') throw error
    return undefined
  })
  const origin = ctx.webServer.getOrigin()
  const loginURL = ctx.connection.authenticatedUrl(origin)
  async function login(url, redirect) {
    const response = await fetch(url, { redirect: 'manual', signal })
    const value = response.headers.get('set-cookie')
    return response.status === redirect && value ? value.split(';', 1)[0] : undefined
  }
  const cookie = await until(() => login(loginURL, 303), signal, 'DSH owner login')

  async function request(path, body, credential = cookie) {
    const headers = { 'content-type': 'application/json', origin }
    if (credential) headers.cookie = credential
    return fetch(new URL(`/api/drama/${path}`, origin), {
      method: 'POST', headers, body: JSON.stringify(body), signal,
    })
  }

  async function ok(response, label) {
    assert.ok(response.ok, `${label}: HTTP ${response.status}`)
    return response.json()
  }

  const init = async sessionId => until(async () => {
    const response = await request('init', { sessionId })
    // Native Web can admit its owner while the plugin is still starting the kernel.
    if (response.status === 404 && !response.headers.get('content-type')?.includes('application/json')) {
      await response.body?.cancel()
      return undefined
    }
    return ok(response, 'init')
  }, signal, 'Studio Host routes')
  const op = async (ticket, action, data = {}) => ok(
    await request('operation', { ticket, action, data: { operationId: randomUUID(), ...data } }), action,
  )

  const lib = join(dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'index.js')
  const { createUserMessage, LlmAdapter, LlmError } = await import(pathToFileURL(lib).href)
  const script = []
  let offered = []
  ctx.llm.registerAdapter([provider], new class extends LlmAdapter {
    async listModels() {
      return [{ provider, id: model, name: model }]
    }

    async * stream(options) {
      const step = script.shift()
      assert.ok(step, 'Unexpected fixture model request')
      if (step.hold) {
        step.hold.entered = true
        await once(step.hold.release, 'release', { signal: options.signal })
        if (step.fail) throw new LlmError('Deliberate native fixture request error', 'AUTH')
      }
      if (step.call) {
        const { id, name, args } = step.call
        offered = options.tools?.map(tool => tool.name) ?? []
        assert.ok(offered.includes(name), `Tool not offered to native Agent: ${name}`)
        const block = { type: 'tool-call', id, name, arguments: JSON.stringify(args) }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block }
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      const block = { type: 'text', text: 'Fixture done' }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  })

  const sessions = ctx.sessionController
  async function holdTurn(sessionId, { fail = false, owner, nodeId } = {}) {
    const agent = owner ?? (await sessions.resolveAgent(sessionId)).agent
    assert.equal(agent?.status, 'idle')
    const startSeq = agent.session.snapshotEvents().at(-1)?.seq ?? -1
    const hold = { release: new EventTarget(), entered: false }
    if (nodeId) script.push({ call: { id: randomUUID(), name: 'drama_query', args: { id: nodeId } } })
    script.push({ hold, fail })
    const content = [{ type: 'text', text: 'Hold this native turn for the Workspace edit check.' }]
    if (owner) {
      agent.followup(createUserMessage({ content, source: { kind: 'user' } }))
    } else {
      const admission = await sessions.prompt({ sessionId, requestId: randomUUID(), mode: 'queue', content }, signal)
      assert.equal(admission.accepted, true)
    }
    await until(() => hold.entered && agent.status === 'running', signal, 'held native turn')
    return {
      agent,
      finish: () => hold.release.dispatchEvent(new Event('release')),
      ending: () => until(() => {
        if (agent.status !== 'idle') return undefined
        return agent.session.snapshotEvents().find(event => event.seq > startSeq && event.type === 'turn/end')?.data.reason
      }, signal, 'native turn settlement'),
    }
  }
  let nativeCalls = 0
  async function call(sessionId, toolName, args) {
    const resolved = await sessions.resolveAgent(sessionId)
    assert.ok(resolved.agent, 'Native Agent did not resolve')
    const id = randomUUID()
    const startSeq = resolved.agent.session.snapshotEvents().at(-1)?.seq ?? -1
    offered = []
    script.push({ call: { id, name: toolName, args } }, {})
    const admission = await sessions.prompt({
      sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'Run the test step.' }],
    }, signal)
    assert.equal(admission.accepted, true)
    const events = await until(() => {
      const current = resolved.agent.session.snapshotEvents().filter(event => event.seq > startSeq)
      return resolved.agent.status === 'idle' && current.some(event => event.type === 'turn/end') ? current : undefined
    }, signal, `Agent turn ${toolName}`)
    const loggedCall = events.find(event => event.type === 'tool/call' && event.data.callId === id)
    const diagnostics = events.filter(event => event.type.includes('error') || event.type === 'turn/end')
      .map(({ type, data }) => ({ type, data }))
    assert.equal(loggedCall?.data.name, toolName,
      `No native tool/call for ${toolName}. Offered: ${offered.join(', ')}. Turn: ${JSON.stringify(diagnostics)}`)
    const result = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === id)
    assert.ok(result, `No native tool/result for ${toolName}`)
    assert.equal(script.length, 0, 'Native Agent did not finish the scripted turn')
    nativeCalls++
    const { message } = result.data
    return { isError: message.isError === true, text: message.content.map(block => block.text ?? '').join('\n') }
  }

  async function succeed(sessionId, toolName, args) {
    const result = await call(sessionId, toolName, args)
    assert.equal(result.isError, false, result.text)
    return JSON.parse(result.text)
  }

  async function reject(sessionId, toolName, args, reason) {
    const result = await call(sessionId, toolName, args)
    assert.equal(result.isError, true, `Expected ${toolName} to reject`)
    if (reason) assert.match(result.text, reason)
  }

  if (state) {
    const restored = await init(state.sessionId)
    assert.equal(restored.status.canvasId, state.canvasId)
    assert.equal(restored.status.connected, true)
    assert.equal(restored.status.autoGenerate, false)
    assert.equal(restored.status.aiRunning, false, 'An interrupted native turn was treated as a persistent lock')
    const [note] = (await ok(await request('operation', {
      ticket: restored.ticket, action: 'query', data: { id: state.noteId },
    }), 'read note after restart')).nodes
    await op(restored.ticket, 'update_node', { id: note.id, revision: note.revision, content: { description: 'Editable after Harness restart' } })
    const staleTicket = await request('operation', {
      ticket: state.ticket, action: 'permission', data: { operationId: randomUUID(), enabled: true },
    })
    assert.equal(staleTicket.status, 403, 'Restart accepted an old authorization ticket')
    await sessions.selectModel({ sessionId: state.sessionId, provider, model })
    await reject(state.sessionId, 'drama_submit', { operationId: randomUUID(), nodeId: state.videoId }, /automatic generation is disabled/i)
    assert.equal((await succeed(state.sessionId, 'drama_query', { type: 'shot' })).nodes.length, 2)
    console.info(`[drama-agent-fixture] PASS restart: live turn interrupted, Canvas persisted, human edit restored, stale ticket and Agent submit rejected (${nativeCalls} native tool calls)`)
    return
  }

  await mkdir(workspacePath, { recursive: true })
  const workspace = await ctx.workspaceRegistry.create(workspacePath)
  const a = (await sessions.create({ workspaceId: workspace.id })).sessionId
  const b = (await sessions.create({ workspaceId: workspace.id })).sessionId
  const otherPath = join(root, 'other-project')
  await mkdir(otherPath, { recursive: true })
  const otherWorkspace = await ctx.workspaceRegistry.create(otherPath)
  const c = (await sessions.create({ workspaceId: otherWorkspace.id })).sessionId
  assert.notEqual(a, b)
  for (const sessionId of [a, b, c]) await sessions.selectModel({ sessionId, provider, model })

  const unauthenticated = await request('init', { sessionId: a }, null)
  assert.ok([401, 403].includes(unauthenticated.status), 'Anonymous Browser reached init')
  const operatorURL = new URL(loginURL)
  operatorURL.pathname = '/connect'
  const operatorCookie = await login(operatorURL, 302)
  assert.ok(operatorCookie, 'DSH did not issue the API operator cookie')
  const operator = ctx.connection.admit({ headers: { host: operatorURL.host, cookie: operatorCookie } })
  assert.equal(operator.peer?.principal.kind, 'owner')
  assert.notEqual(operator.peer.id, ctx.connection.browserPeer.id)
  const operatorInit = await request('init', { sessionId: a }, operatorCookie)
  assert.equal(operatorInit.status, 403, 'A DSH API owner reached the Studio browser route')
  const first = await init(a)
  const second = await init(b)
  assert.equal(first.status.connected, false)
  assert.equal(second.status.autoGenerate, false)
  assert.equal((await succeed(a, 'drama_context', {})).connected, false)
  await reject(a, 'drama_query', {})
  await op(first.ticket, 'bind')
  await op(second.ticket, 'bind')
  await op((await init(c)).ticket, 'bind')
  const aBound = await init(a)
  const bBound = await init(b)
  const cBound = await init(c)
  assert.ok(aBound.status.canvasId)
  assert.equal(aBound.status.canvasId, bBound.status.canvasId)
  assert.notEqual(aBound.status.canvasId, cBound.status.canvasId)

  const forgedSession = await request('operation', {
    ticket: aBound.ticket, action: 'permission', sessionId: b,
    data: { operationId: randomUUID(), enabled: true },
  })
  assert.ok(forgedSession.status >= 400, 'Browser accepted a forged Session')
  const forgedPath = await request('operation', {
    ticket: aBound.ticket, action: 'permission', data: { operationId: randomUUID(), enabled: true, workspacePath: otherPath },
  })
  assert.ok(forgedPath.status >= 400, 'Browser accepted a forged Workspace path')
  const [scope, signature] = aBound.ticket.split('.')
  const changedSignature = (signature[0] === 'a' ? 'b' : 'a') + signature.slice(1)
  const forgedTicket = await request('operation', {
    ticket: `${scope}.${changedSignature}`, action: 'permission', data: { operationId: randomUUID(), enabled: true },
  })
  assert.equal(forgedTicket.status, 403, 'Browser accepted a forged authorization ticket')
  assert.equal((await init(b)).status.autoGenerate, false)
  assert.equal((await init(c)).status.autoGenerate, false)
  await op(bBound.ticket, 'permission', { enabled: true })
  assert.equal((await init(a)).status.autoGenerate, false)
  assert.equal((await init(b)).status.autoGenerate, true)

  const shot = description => ({ operationId: randomUUID(), nodes: [{ type: 'shot', content: { description } }] })
  await succeed(a, 'drama_append', shot('Native fixture A'))
  await succeed(b, 'drama_append', shot('Native fixture B'))
  const query = await succeed(a, 'drama_query', { type: 'shot' })
  assert.deepEqual(new Set(query.nodes.map(node => node.createdBySession)), new Set([a, b]))
  assert.ok(!offered.some(name => /^drama_(?:update|delete)/.test(name)), 'A native Agent was offered human mutation tools')
  for (const name of ['drama_update_node', 'drama_delete_node', 'drama_update_edge', 'drama_delete_edge']) {
    const result = await ctx.tools.execute({
      agent: (await sessions.resolveAgent(a)).agent, callId: randomUUID(), name,
      arguments: { id: query.nodes[0].id, revision: query.nodes[0].revision }, signal,
    })
    assert.equal(result.isError, true, `Unregistered human operation resolved through tools: ${name}`)
  }
  await reject(a, 'drama_append', {
    operationId: randomUUID(), nodes: [{ id: query.nodes[0].id, type: 'shot', content: { description: 'Attempted overwrite' } }],
  }, /节点 ID 已存在/u)
  await reject(a, 'drama_append', { ...shot('forged Session'), sessionId: b })
  await reject(a, 'drama_append', { ...shot('forged Canvas'), canvasId: cBound.status.canvasId })
  await reject(a, 'drama_append', { ...shot('forged Workspace'), workspacePath: otherPath })
  assert.equal((await succeed(b, 'drama_query', { type: 'shot' })).nodes.length, 2)
  assert.equal((await succeed(c, 'drama_query', { type: 'shot' })).nodes.length, 0)
  assert.equal((await succeed(b, 'drama_tasks', {})).tasks.length, 0)

  await succeed(b, 'drama_append', {
    operationId: randomUUID(), nodes: [{ type: 'video', content: { prompt: 'Locked wide shot of a quiet room. The actor enters from camera left and stops beside the window. Soft room tone, no music. Hold before the entrance and after the stop.' } }],
  })
  const video = (await succeed(a, 'drama_query', { type: 'video' })).nodes[0]
  assert.ok(video?.id)
  const submit = () => ({ operationId: randomUUID(), nodeId: video.id })
  await reject(a, 'drama_submit', submit(), /automatic generation is disabled/i)
  await reject(b, 'drama_submit', submit(), /no verified generation provider is configured/i)
  await op(bBound.ticket, 'permission', { enabled: false })
  await reject(b, 'drama_submit', submit(), /automatic generation is disabled/i)
  await op(bBound.ticket, 'disconnect')
  assert.equal((await init(b)).status.connected, false)
  await reject(b, 'drama_query', {})
  assert.equal((await succeed(a, 'drama_query', { type: 'shot' })).nodes.length, 2)

  const reconnect = await init(b)
  await op(reconnect.ticket, 'bind')
  const rebound = await init(b)
  assert.equal(rebound.status.autoGenerate, false)
  await op(rebound.ticket, 'permission', { enabled: true })
  assert.equal((await init(b)).status.aiRunning, false, 'Generation permission was mistaken for live AI activity')

  const noteId = randomUUID()
  const otherId = randomUUID()
  const note = (id, description) => ({ id, type: 'note', content: { description } })
  await op(rebound.ticket, 'append', { nodes: [note(noteId, 'Original manual note')] })
  await op(cBound.ticket, 'append', { nodes: [note(otherId, 'Isolated Workspace note')] })
  const edit = (id, revision, description) => ({ id, revision, content: { description } })
  const change = (ticket, action, data) => request('operation', { ticket, action, data: { operationId: randomUUID(), ...data } })
  async function locked(ticket, action, data) {
    const response = await change(ticket, action, data)
    assert.equal(response.status, 423, JSON.stringify(await response.json()))
  }
  await op(rebound.ticket, 'update_node', edit(noteId, 1, 'Manual edit while idle'))
  const turnA = await holdTurn(a, { nodeId: noteId })
  assert.equal((await init(b)).status.aiRunning, true)
  assert.equal((await init(c)).status.aiRunning, false)
  await locked(rebound.ticket, 'update_node', edit(noteId, 2, 'Blocked from Session B'))
  const duringId = randomUUID()
  await op(rebound.ticket, 'append', { nodes: [note(duringId, 'Manual append while AI is active')] })
  await op(cBound.ticket, 'update_node', edit(otherId, 1, 'Other Workspace still editable'))
  await op(rebound.ticket, 'update_node', edit(duringId, 1, 'Independent edit while A uses another node'))
  const turnB = await holdTurn(b, { nodeId: duringId })
  turnA.finish()
  assert.equal((await turnA.ending()).kind, 'completed')
  assert.equal(turnB.agent.status, 'running')
  await locked(aBound.ticket, 'delete_node', { id: duringId, revision: 2 })
  assert.equal(sessions.cancel({ sessionId: b }).accepted, true)
  assert.deepEqual(await turnB.ending(), { kind: 'aborted', reason: { kind: 'user' } })
  assert.equal((await init(a)).status.aiRunning, false)
  await op(aBound.ticket, 'delete_node', { id: duringId, revision: 2 })

  const binding = await holdTurn(a)
  await op(aBound.ticket, 'disconnect')
  assert.equal((await init(b)).status.aiRunning, false, 'An unbound Agent held the Workspace lock')
  await op(aBound.ticket, 'bind')
  assert.equal((await init(b)).status.aiRunning, true, 'A newly connected active Agent was ignored')
  binding.finish()
  assert.equal((await binding.ending()).kind, 'completed')

  const failed = await holdTurn(a, { fail: true, nodeId: noteId })
  await locked(rebound.ticket, 'update_node', edit(noteId, 2, 'Still blocked before failure'))
  failed.finish()
  assert.equal((await failed.ending()).kind, 'error')
  assert.equal((await init(b)).status.aiRunning, false)
  await op(rebound.ticket, 'update_node', edit(noteId, 2, 'Editable after failed turn'))

  const disposableId = randomUUID()
  const handle = await ctx.agents.create({
    sessionId: disposableId, meta: { cwd: workspace.path }, agentOptions: { provider, model },
  })
  try {
    await workspace.attachSession(disposableId)
    await op((await init(disposableId)).ticket, 'bind')
    await holdTurn(disposableId, { owner: handle.agent })
    const read = await ctx.tools.execute({
      agent: handle.agent, callId: randomUUID(), name: 'drama_query', arguments: { id: noteId }, signal,
    })
    assert.equal(read.isError, false, JSON.stringify(read.content))
    assert.ok((await init(b)).status.agentLockedNodeIds.includes(noteId))
    await locked(rebound.ticket, 'delete_node', { id: noteId, revision: 3 })
  } finally {
    await handle.dispose()
  }
  assert.equal(ctx.agents.get(disposableId), undefined)
  assert.equal((await init(b)).status.aiRunning, false)
  await op(rebound.ticket, 'update_node', edit(noteId, 3, 'Editable after Agent disposal'))

  await writeFile(statePath, JSON.stringify({
    sessionId: b, canvasId: rebound.status.canvasId, ticket: rebound.ticket, videoId: video.id, noteId,
  }))
  await holdTurn(a, { nodeId: noteId })
  await locked(rebound.ticket, 'delete_node', { id: noteId, revision: 4 })
  console.info(`[drama-agent-fixture] PASS native Agent: overlapping turns, other Workspace isolation, cancel/error/dispose unlock, Agent update/delete rejected, held turn at restart (${nativeCalls} native tool calls)`)
}

async function until(check, signal, label, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    signal.throwIfAborted()
    const value = await check()
    if (value) return value
    await delay(100, undefined, { signal })
  }
  throw new Error(`Timed out: ${label}`)
}

async function runFixture() {
  assert.equal(process.platform, 'win32', 'Requires the Windows Desktop DSH installation')
  const file = fileURLToPath(import.meta.url)
  const build = resolve(dirname(file), '..', 'dist')
  const sourceHost = join(build, 'host.js')
  const sourceKernel = process.env.DRAMA_UIUX_STUDIO_EXE ?? join(build, 'studio.exe')
  await access(sourceHost)
  await access(sourceKernel)
  const installation = join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness')
  const executable = join(installation, 'DeepSeek Harness.exe')
  const cli = join(installation, 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js')
  await access(executable)
  const scratch = resolve(dirname(file), '..', '.runtime')
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(join(scratch, 'drama-native-agent-'))
  const host = join(root, 'host.js')
  await copyFile(sourceHost, host)
  await copyFile(sourceKernel, join(root, 'studio.exe'))
  const overlay = join(root, 'fixture.yml')
  const fixture = join(root, 'agent-fixture.mjs')
  await copyFile(file, fixture)
  await writeFile(join(root, 'package.json'), JSON.stringify({ name, type: 'module' }))
  const yaml = path => JSON.stringify(path.replaceAll('\\', '/'))
  await writeFile(overlay, `- insert:\n    - id: my-drama-studio\n      name: ${yaml(host)}\n    - id: ${name}\n      name: ${yaml(fixture)}\n`)

  async function launch(expected) {
    const child = spawn(executable, ['--expose-internals', cli, 'web', '--patch', overlay,
      '--host', '127.0.0.1', '--port', '0', '--no-open'], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: join(root, 'home'),
        DSH_AGENTS_HOME: join(root, 'agents'), DSH_TELEMETRY_DISABLED: '1', DSH_TOOLS_MODE: 'native', DEEPSEEK_API_KEY: '',
      },
    })
    const exited = once(child, 'exit')
    const waiting = new AbortController()
    let logs = ''
    const capture = chunk => { logs += chunk.toString() }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    try {
      await Promise.race([
        exited,
        until(() => logs.includes(expected) || logs.includes(`[${name}] FAIL`),
          waiting.signal, expected, 45_000),
      ])
      assert.ok(logs.includes(expected), `The fixture did not reach ${expected}`)
      console.info(logs.split(/\r?\n/).find(line => line.includes(expected)))
    } catch (error) {
      console.error(logs.replace(/(https?:\/\/[^\s?'"<>]+)\?[^\s'"<>]+/g, '$1?[redacted]'))
      throw error
    } finally {
      waiting.abort()
      if (child.pid && child.exitCode === null) child.kill()
      await exited
    }
  }

  try {
    await launch(`[${name}] PASS native Agent`)
    await launch(`[${name}] PASS restart`)
  } finally {
    assert.equal(dirname(root), scratch)
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await runFixture()
}
