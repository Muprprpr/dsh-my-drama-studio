import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

export class StudioError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export async function startKernel(ctx) {
  const token = randomBytes(32).toString('base64url')
  const executable = fileURLToPath(new URL('./studio.exe', import.meta.url))
  const child = spawn(executable, [], {
    windowsHide: true,
    env: { ...process.env, DRAMA_STUDIO_TOKEN: token },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  child.stdin.on('error', error => {
    if (error.code !== 'EPIPE') console.error('[my-drama-studio] Go stdin:', error.message)
  })
  const closed = new Promise(resolve => child.once('close', resolve))
  ctx.effect(() => async () => {
    child.stdin.end()
    const stop = setTimeout(() => child.kill(), 6000)
    try {
      await closed
    } finally {
      clearTimeout(stop)
    }
  })

  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  let timer
  let origin
  try {
    origin = await new Promise((resolve, reject) => {
      lines.once('line', line => {
        if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(line)) reject(new Error('Studio kernel returned an invalid loopback address'))
        else resolve(line)
      })
      child.once('error', reject)
      child.once('exit', code => reject(new Error(`Studio kernel exited during startup (${code})`)))
      timer = setTimeout(() => reject(new Error('Studio kernel startup timed out')), 10000)
    })
  } catch (error) {
    child.stdin.end()
    throw error
  } finally {
    clearTimeout(timer)
    lines.close()
  }

  return async function kernel(sessionId, workspace, action, data = {}, signal) {
    const deadline = AbortSignal.timeout(20000)
    let response
    try {
      response = await fetch(origin, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, workspaceId: workspace.id, workspacePath: workspace.path, action, data }),
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      })
    } catch (error) {
      if (signal?.aborted) throw error
      throw new StudioError(503, 'Studio Go service unavailable')
    }
    const value = await response.json()
    if (!response.ok) throw new StudioError(response.status, value.error ?? 'Studio operation failed')
    return value
  }
}
