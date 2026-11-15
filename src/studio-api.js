class StudioHTTPError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function post(path, body, signal) {
  return fetch(`/api/drama/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
}

async function json(response) {
  const type = response.headers.get('content-type')
  if (!type?.includes('application/json')) {
    throw new StudioHTTPError(response.status, 'My Drama Studio Host 未加载')
  }
  const result = await response.json()
  if (!response.ok) throw new StudioHTTPError(response.status, result.error ?? `Studio HTTP ${response.status}`)
  return result
}

export async function providerRequest(action, data = {}, signal) {
  return json(await post('providers', { action, data }, signal))
}

export async function uploadMedia(ticket, type, file, signal) {
  const query = new URLSearchParams({ ticket, type, name: file.name })
  const uploaded = await json(await fetch(`/api/drama/upload?${query}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file, signal,
  }))
  const { assetId, path, title } = uploaded
  if (!assetId || uploaded.type !== type || !path) throw new Error('服务未返回完整素材信息')
  return { assetId, path, title }
}

export async function initialize(sessionId, signal) {
  return json(await post('init', { sessionId }, signal))
}

export async function operation(ticket, action, data = {}, signal) {
  const body = { ticket, action, data }
  let response
  try {
    response = await post('operation', body, signal)
  } catch (error) {
    if (!(error instanceof TypeError) || signal?.aborted || !data.operationId) throw error
    response = await post('operation', body, signal)
  }
  return json(response)
}

export const generateT2V = (ticket, request, signal) => operation(ticket, 'generateT2V', request, signal)
export const generateI2V = (ticket, request, signal) => operation(ticket, 'generateI2V', request, signal)
export const generateR2V = (ticket, request, signal) => operation(ticket, 'generateR2V', request, signal)
export const generateV2V = (ticket, request, signal) => operation(ticket, 'generateV2V', request, signal)

const eventStreams = new Map()

export function subscribe(ticket, after, signal, onBatch, onError) {
  if (signal.aborted) return
  let entry = eventStreams.get(ticket)
  if (!entry) {
    entry = { controller: new AbortController(), listeners: new Set(), activity: null, batch: null }
    eventStreams.set(ticket, entry)
    const stream = entry
    void readEvents(ticket, after, stream.controller.signal, batch => {
      if (typeof batch.aiRunning === 'boolean') stream.activity = batch
      else stream.batch = batch
      for (const listener of stream.listeners) listener.onBatch(batch)
    }, error => {
      for (const listener of stream.listeners) listener.onError(error)
    }).finally(() => {
      if (eventStreams.get(ticket) === stream) eventStreams.delete(ticket)
      stream.listeners.clear()
    })
  }
  const listener = { onBatch, onError }
  entry.listeners.add(listener)
  signal.addEventListener('abort', () => {
    entry.listeners.delete(listener)
    if (entry.listeners.size || eventStreams.get(ticket) !== entry) return
    eventStreams.delete(ticket)
    entry.controller.abort()
  }, { once: true })
  if (entry.activity) onBatch(entry.activity)
  if (entry.batch && (entry.batch.status.eventSeq > after || !entry.batch.events.length)) onBatch(entry.batch)
}

async function readEvents(ticket, after, signal, onBatch, onError) {
  while (!signal.aborted) {
    try {
      const response = await post('events', { ticket, after }, signal)
      if (!response.ok || !response.headers.get('content-type')?.startsWith('text/event-stream')) {
        await json(response)
        throw new Error('Studio did not return an event stream')
      }
      let buffer = ''
      for await (const text of response.body.pipeThrough(new TextDecoderStream())) {
        buffer += text
        let boundary
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          if (!frame.startsWith('data: ')) continue
          const batch = JSON.parse(frame.slice(6))
          if (batch.error) throw new StudioHTTPError(409, batch.error)
          if (typeof batch.aiRunning === 'boolean') {
            onBatch(batch)
            continue
          }
          after = batch.events.at(-1)?.eventSeq ?? batch.status.eventSeq
          onBatch(batch)
        }
      }
    } catch (error) {
      if (signal.aborted) return
      if ([401, 403, 404, 409].includes(error.status)) {
        onError(error)
        return
      }
    }
    if (!signal.aborted) await new Promise(resolve => setTimeout(resolve, 700))
  }
}

export function mediaURL(ticket, node) {
  if (node.content.assetId) {
    const query = new URLSearchParams({ ticket, type: node.type, assetId: node.content.assetId })
    return `/api/drama/media?${query}`
  }
  if (node.content.path) {
    const query = new URLSearchParams({ ticket, id: node.id })
    return `/api/drama/media?${query}`
  }
  if (typeof node.content.url !== 'string') return undefined
  try {
    const url = new URL(node.content.url)
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.href
  } catch {
    return undefined
  }
}
