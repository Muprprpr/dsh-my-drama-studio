import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import { startKernel, StudioError } from './kernel.js'
import { streamMedia } from './media.js'
import { registerTools } from './tools.js'

export const name = 'my-drama-studio'
export const inject = ['connection', 'webServer', 'workspaceRegistry', 'tools']

export function keys(value, ...allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new StudioError(400, 'Expected a JSON object')
  }
  if (Object.keys(value).some(key => !allowed.includes(key))) {
    throw new StudioError(400, 'Unexpected request field')
  }
  return value
}

export async function workspaceFor(ctx, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) throw new StudioError(400, 'Session is required')
  const workspace = ctx.workspaceRegistry.list().find(item => item.sessionIds.includes(sessionId))
  if (!workspace) throw new StudioError(404, '当前 Session 没有可用的 DSH Workspace')
  if (await workspace.status() !== 'ok') throw new StudioError(404, 'DSH Workspace 目录不可用')
  if (!workspace.sessionIds.includes(sessionId)) throw new StudioError(409, 'Session 的 Workspace 已切换')
  return workspace
}

async function readJSON(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw new StudioError(415, 'Expected application/json')
  }
  const chunks = []
  let size = 0
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > 1024 * 1024) throw new StudioError(413, 'Request is too large')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new StudioError(400, 'Invalid JSON')
  }
}

function sendJSON(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

function route(ctx, path, run, method = 'POST') {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path,
    async handler(req, res) {
      try {
        const admission = ctx.connection.admit(req)
        if ('rejection' in admission) throw new StudioError(admission.rejection, 'DSH authentication required')
        if (admission.peer.id !== ctx.connection.browserPeer.id) throw new StudioError(403, 'DSH browser owner required')
        if (req.method !== method) throw new StudioError(405, 'Method not allowed')
        const input = method === 'POST' ? await readJSON(req)
          : Object.fromEntries(new URL(req.url, 'http://127.0.0.1').searchParams)
        const result = await run(input, admission.peer, req, res)
        if (!res.headersSent) sendJSON(res, 200, result)
      } catch (error) {
        if (res.destroyed) return
        if (res.headersSent) return res.end()
        if (!(error instanceof StudioError)) console.error('[my-drama-studio]', error)
        sendJSON(res, error.status ?? 500, { error: error instanceof StudioError ? error.message : 'Studio request failed' })
      }
    },
  }))
}

const browserActions = new Set(['context', 'bind', 'disconnect', 'query', 'append', 'permission', 'submit_manual', 'tasks'])

export async function apply(ctx) {
  const kernel = await startKernel(ctx)
  const signingKey = randomBytes(32)
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort())

  function signature(payload, peer, workspace) {
    return createHmac('sha256', signingKey)
      .update(JSON.stringify([payload, peer.id, workspace.id, workspace.path]))
      .digest()
  }

  async function verify(ticket, peer) {
    if (typeof ticket !== 'string' || ticket.length > 1024 || !/^[\w-]+\.[\w-]+$/.test(ticket)) {
      throw new StudioError(403, 'Invalid Studio session ticket')
    }
    const [payload, hash] = ticket.split('.')
    const sessionId = Buffer.from(payload, 'base64url').toString('utf8')
    const workspace = await workspaceFor(ctx, sessionId)
    const sent = Buffer.from(hash, 'base64url')
    const expected = signature(payload, peer, workspace)
    if (sent.length !== expected.length || !timingSafeEqual(sent, expected)) {
      throw new StudioError(403, 'Invalid Studio session ticket')
    }
    return { sessionId, workspace }
  }

  route(ctx, '/api/drama/init', async (body, peer) => {
    const { sessionId } = keys(body, 'sessionId')
    const workspace = await workspaceFor(ctx, sessionId)
    const status = await kernel(sessionId, workspace, 'context')
    const payload = Buffer.from(sessionId).toString('base64url')
    const ticket = `${payload}.${signature(payload, peer, workspace).toString('base64url')}`
    return { ticket, status }
  })

  route(ctx, '/api/drama/providers', async body => {
    const { action, data } = keys(body, 'action', 'data')
    if (!['provider_settings', 'provider_save', 'provider_remove', 'provider_test'].includes(action)) {
      throw new StudioError(400, 'Unknown provider setting action')
    }
    return kernel('', { id: '', path: '' }, action, keysData(data))
  })

  route(ctx, '/api/drama/operation', async (body, peer) => {
    const { ticket, action, data } = keys(body, 'ticket', 'action', 'data')
    if (!browserActions.has(action)) throw new StudioError(400, 'Unknown Studio action')
    const { sessionId, workspace } = await verify(ticket, peer)
    return kernel(sessionId, workspace, action, action === 'context' ? keys(data ?? {}) : keysData(data))
  })

  route(ctx, '/api/drama/events', async (body, peer, _req, res) => {
    const { ticket, after: start } = keys(body, 'ticket', 'after')
    if (!Number.isSafeInteger(start) || start < 0) throw new StudioError(400, 'Invalid event cursor')
    const initial = await verify(ticket, peer)
    if (!(await kernel(initial.sessionId, initial.workspace, 'context')).connected) throw new StudioError(403, 'Session is not connected')
    const close = new AbortController()
    res.once('close', () => close.abort())
    const signal = AbortSignal.any([close.signal, lifetime.signal, peer.signal])
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
    })
    res.flushHeaders()
    let after = start
    try {
      while (!signal.aborted) {
        const identity = await verify(ticket, peer)
        const batch = await kernel(identity.sessionId, identity.workspace, 'events', { after }, signal)
        if (signal.aborted) break
        await verify(ticket, peer)
        const reset = batch.status.eventSeq < after
        if (reset) after = batch.status.eventSeq
        else if (batch.events.length) after = batch.events.at(-1).eventSeq
        const frame = reset || batch.events.length ? `data: ${JSON.stringify(batch)}\n\n` : ': heartbeat\n\n'
        if (!res.write(frame)) await once(res, 'drain', { signal })
      }
    } catch (error) {
      if (!signal.aborted) res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`)
    } finally {
      res.end()
    }
  })

  route(ctx, '/api/drama/media', async (body, peer, req, res) => {
    const { ticket, id } = keys(body, 'ticket', 'id')
    if (!id) throw new StudioError(400, 'Node id is required')
    const { sessionId, workspace } = await verify(ticket, peer)
    const { nodes } = await kernel(sessionId, workspace, 'query', { id, limit: 1 })
    return streamMedia(req, res, workspace.path, nodes[0])
  }, 'GET')

  registerTools(ctx, workspaceFor, kernel, keys)
  void recoverWorkspaces(ctx, kernel, lifetime.signal)
  console.info('[my-drama-studio] My Drama Studio Host loaded')
}

function keysData(value) {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new StudioError(400, 'Expected operation data object')
  }
  return value
}

async function recoverWorkspaces(ctx, kernel, signal) {
  for (const workspace of ctx.workspaceRegistry.list()) {
    if (signal.aborted) return
    try {
      if (await workspace.status() === 'ok') await kernel('', workspace, 'recover', {}, signal)
    } catch (error) {
      if (!signal.aborted) console.error('[my-drama-studio] Workspace recovery', workspace.id, error.message)
    }
  }
}
