import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

export class StudioError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

async function startActivityCheck(ctx, token, check) {
  const server = createServer({ requestTimeout: 3000 }, async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/human-write' || req.headers.authorization !== 'Bearer ' + token) {
      res.writeHead(403).end()
      return
    }
    try {
      const chunks = []
      let length = 0
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        length += chunk.length
        if (length > 1024 * 1024) {
          res.writeHead(413).end()
          return
        }
        chunks.push(chunk)
      }
      const { workspaceId, sessionId, sessionIds, nodeIds } = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const allowed = check(workspaceId, sessionId, sessionIds, nodeIds) === true
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ allowed }))
    } catch (error) {
      console.error('[my-drama-studio] Agent activity check:', error.message)
      res.writeHead(503).end()
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  ctx.effect(() => () => {
    server.close()
    server.closeAllConnections()
  })
  return `http://127.0.0.1:${server.address().port}/human-write`
}

export async function startKernel(ctx, checkHumanWrite) {
  const token = randomBytes(32).toString('base64url')
  const activityURL = await startActivityCheck(ctx, token, checkHumanWrite)
  const executable = fileURLToPath(new URL('./studio.exe', import.meta.url))
  const child = spawn(executable, [], {
    windowsHide: true,
    env: { ...process.env, DSH_HOME: ctx.profileContext.home, DRAMA_STUDIO_TOKEN: token, DRAMA_STUDIO_ACTIVITY_URL: activityURL },
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

  return async function kernel(sessionId, workspace, action, data = {}, signal, actor) {
    const deadline = AbortSignal.timeout(20000)
    let response
    try {
      response = await fetch(origin, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, workspaceId: workspace.id, workspacePath: workspace.path, action, data, actor }),
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
