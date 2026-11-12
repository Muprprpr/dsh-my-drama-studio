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

export async function subscribe(ticket, after, signal, onBatch, onError) {
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
