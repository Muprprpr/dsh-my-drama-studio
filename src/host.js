import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { startKernel, StudioError } from './kernel.js'
import { importedMediaURL, importMedia, streamImportedMedia, streamMedia } from './media.js'
import { registerTools } from './tools.js'
import { openProfileSettings } from './profile-settings.js'

export const name = 'my-drama-studio'
export const inject = ['agents', 'connection', 'webServer', 'workspaceRegistry', 'tools', 'settings', 'credentials', 'profileContext']
export { Config } from './profile-settings.js'

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

function route(ctx, path, run, method = 'POST', rawBody = false) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path,
    async handler(req, res) {
      try {
        const admission = ctx.connection.admit(req)
        if ('rejection' in admission) throw new StudioError(admission.rejection, 'DSH authentication required')
        if (admission.peer.id !== ctx.connection.browserPeer.id) throw new StudioError(403, 'DSH browser owner required')
        if (req.method !== method) throw new StudioError(405, 'Method not allowed')
        const input = method === 'POST' && !rawBody ? await readJSON(req)
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

const humanEdits = new Set(['update_node', 'delete_node', 'update_edge', 'delete_edge', 'canvas_delete', 'canvas_restore'])
const browserActions = new Set(['context', 'bind', 'disconnect', 'query', 'append', 'permission', 'submit_manual', 'tasks',
  'generateT2V', 'generateI2V', 'generateR2V', 'generateV2V', 'cancel_task', 'resume_task', ...humanEdits])

export async function apply(ctx, config) {
  const activity = new EventEmitter().setMaxListeners(0)
  function workspaceActivity(sessionIds, connected) {
    const members = new Set(sessionIds)
    return { aiRunning: connected.some(id => members.has(id) && ctx.agents.get(id)?.status === 'running') }
  }

  function checkHumanWrite(workspaceId, sessionId, connected) {
    const members = ctx.workspaceRegistry.get(workspaceId)?.sessionIds
    return Boolean(members?.includes(sessionId)) && !workspaceActivity(members, connected).aiRunning
  }

  const kernel = await startKernel(ctx, checkHumanWrite)
  const providerRequest = await openProfileSettings(ctx, config, kernel)
  const signingKey = randomBytes(32)
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort())
  ctx.on('agent/status', ({ agent }) => activity.emit('change', agent.id))
  ctx.on('agent/disposed', ({ agent }) => activity.emit('change', agent.id))

  async function connectedSessions(sessionId, workspace, signal) {
    return (await kernel(sessionId, workspace, 'connected_sessions', {}, signal)).sessionIds
  }

  async function addActivity(status, sessionId, workspace) {
    const connected = status.connected ? await connectedSessions(sessionId, workspace) : []
    Object.assign(status, workspaceActivity(workspace.sessionIds, connected))
    return status
  }

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
    const status = await addActivity(await kernel(sessionId, workspace, 'context'), sessionId, workspace)
    const payload = Buffer.from(sessionId).toString('base64url')
    const ticket = `${payload}.${signature(payload, peer, workspace).toString('base64url')}`
    return { ticket, status }
  })

  route(ctx, '/api/drama/providers', async body => {
    const { action, data } = keys(body, 'action', 'data')
    return providerRequest(action, keysData(data))
  })

  route(ctx, '/api/drama/operation', async (body, peer) => {
    const { ticket, action, data } = keys(body, 'ticket', 'action', 'data')
    if (!browserActions.has(action)) throw new StudioError(400, 'Unknown Studio action')
    const { sessionId, workspace } = await verify(ticket, peer)
    const input = action === 'context' ? keys(data ?? {}) : keysData(data)
    if (humanEdits.has(action) || action === 'append') return kernel(sessionId, workspace, action, input, undefined, 'human')
    const result = await kernel(sessionId, workspace, action, input)
    if (action === 'query') await addActivity(result.status, sessionId, workspace)
    else if (action === 'context' || action === 'bind' || action === 'disconnect') {
      await addActivity(result, sessionId, workspace)
    }
    return result
  })

  route(ctx, '/api/drama/upload', async (body, peer, req) => {
    const { ticket, type, name } = keys(body, 'ticket', 'type', 'name')
    const { sessionId, workspace } = await verify(ticket, peer)
    if (!(await kernel(sessionId, workspace, 'context')).connected) throw new StudioError(403, '请先连接当前会话与画布')
    const asset = await importMedia(req, workspace.path, type, name)
    return { ...asset, url: importedMediaURL(ticket, asset.type, asset.assetId) }
  }, 'POST', true)

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
    let trackedSessions = new Set()
    let refreshActivity = true
    let currentWait
    let published
    function onActivity(sessionId) {
      if (!trackedSessions.has(sessionId)) return
      refreshActivity = true
      // Wake the pending DB read without adding a durable Canvas event.
      currentWait?.abort()
    }
    async function write(frame) {
      if (!res.write(frame)) await once(res, 'drain', { signal })
    }
    activity.on('change', onActivity)
    try {
      while (!signal.aborted) {
        const { sessionId, workspace } = await verify(ticket, peer)
        if (refreshActivity) {
          refreshActivity = false
          const connected = await connectedSessions(sessionId, workspace, signal)
          trackedSessions = new Set(connected)
          const frame = JSON.stringify(workspaceActivity(workspace.sessionIds, connected))
          if (published !== frame && !signal.aborted) {
            await write(`data: ${frame}\n\n`)
            published = frame
          }
        }
        if (signal.aborted || refreshActivity) continue
        const wake = new AbortController()
        currentWait = wake
        let batch
        try {
          batch = await kernel(sessionId, workspace, 'events', { after }, AbortSignal.any([signal, wake.signal]))
        } catch (error) {
          if (wake.signal.aborted) continue
          throw error
        } finally {
          currentWait = undefined
        }
        if (signal.aborted) break
        await verify(ticket, peer)
        const reset = batch.status.eventSeq < after
        if (reset) after = batch.status.eventSeq
        else if (batch.events.length) after = batch.events.at(-1).eventSeq
        if (reset || !batch.events.length || batch.events.some(event => event.type === 'binding')) refreshActivity = true
        await write(reset || batch.events.length ? `data: ${JSON.stringify(batch)}\n\n` : ': heartbeat\n\n')
      }
    } catch (error) {
      if (!signal.aborted) res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`)
    } finally {
      activity.off('change', onActivity)
      res.end()
    }
  })

  route(ctx, '/api/drama/media', async (body, peer, req, res) => {
    const { ticket, id, type, assetId } = keys(body, 'ticket', 'id', 'type', 'assetId')
    const { sessionId, workspace } = await verify(ticket, peer)
    if (assetId !== undefined) {
      if (id !== undefined || !type) throw new StudioError(400, 'Media type and asset id are required')
      if (!(await kernel(sessionId, workspace, 'context')).connected) throw new StudioError(403, '请先连接当前会话与画布')
      return streamImportedMedia(req, res, workspace.path, type, assetId)
    }
    if (!id || type !== undefined) throw new StudioError(400, 'Node id is required')
    const { nodes } = await kernel(sessionId, workspace, 'query', { id, limit: 1 })
    const node = nodes[0]
    return streamMedia(req, res, workspace.path, node?.type, node?.content.path)
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
