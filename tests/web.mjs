import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { createServer as createHTTPServer } from 'node:http'
import { createServer } from 'node:net'
import { basename, dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const root = fileURLToPath(new URL('..', import.meta.url))
const runtime = join(root, '.runtime')
const fixtureSource = `
import { watch } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const name = 'drama-web-fixture'
export const inject = ['sessionController', 'workspaceRegistry', 'tools', 'llm']

export async function apply(ctx) {
  console.info('[drama-web-fixture] PID ' + process.pid)
  const llm = join(dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'node_modules',
    '@deepseek-ai', 'dsh-llm', 'lib', 'index.js')
  const { LlmAdapter, createMessage, createUserMessage } = await import(pathToFileURL(llm).href)
  const provider = 'drama-web-activity-fixture'
  const model = 'held-turn'
  const queued = []
  const running = new Map()
  ctx.llm.registerAdapter([provider], new class extends LlmAdapter {
    async listModels() {
      return [{ provider, id: model, name: model }]
    }
    async * stream(options) {
      const gate = queued.shift()
      if (!gate) throw new Error('No scripted activity turn')
      const signal = options.signal
      const stop = () => gate.finish.resolve()
      signal?.addEventListener('abort', stop, { once: true })
      gate.entered.resolve()
      try {
        signal?.throwIfAborted()
        await gate.finish.promise
        signal?.throwIfAborted()
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Activity turn completed.' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } finally {
        signal?.removeEventListener('abort', stop)
        running.delete(gate.sessionId)
      }
    }
  })
  async function activity({ sessionId, requestId, action, nodeId }) {
    const { agent } = await ctx.sessionController.resolveAgent(sessionId)
    if (!agent) throw new Error('Native activity Agent did not resolve')
    if (action === 'start') {
      await ctx.sessionController.selectModel({ sessionId, provider, model })
      const gate = { sessionId, entered: Promise.withResolvers(), finish: Promise.withResolvers() }
      running.set(sessionId, gate)
      queued.push(gate)
      const signal = AbortSignal.timeout(8000)
      const result = await ctx.sessionController.prompt({
        sessionId, requestId, mode: 'queue', content: [{ type: 'text', text: 'Hold this native turn for Web verification.' }],
      }, signal)
      if (!result.accepted) throw new Error('Native turn admission rejected')
      await Promise.race([
        gate.entered.promise,
        new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
      ])
    } else if (action === 'query') {
      if (!running.has(sessionId)) throw new Error('No native turn to query')
      const result = await ctx.tools.execute({ agent, callId: requestId, name: 'drama_query',
        arguments: { id: nodeId }, signal: AbortSignal.timeout(8000) })
      if (result.isError) throw new Error(result.content?.[0]?.text || 'Native query failed')
      if (!JSON.stringify(result).includes(nodeId)) throw new Error('Native query did not return the requested node')
    } else if (action === 'finish') {
      const gate = running.get(sessionId)
      if (!gate) throw new Error('No native turn to finish')
      gate.finish.resolve()
    } else if (action === 'cancel') {
      if (!ctx.sessionController.cancel({ sessionId }).accepted) throw new Error('Native cancel rejected')
    } else if (action !== 'status') throw new Error('Unknown activity test command')
    return { status: agent.status }
  }
  ctx.effect(() => {
    let used = false
    const commands = new Set()
    const watcher = watch(process.env.DSH_HOME, { persistent: false }, (_event, file) => {
      if (file?.startsWith('activity-request-') && file.endsWith('.json') && !commands.has(file)) {
        commands.add(file)
        void (async () => {
          let result
          try {
            result = await activity(JSON.parse(await readFile(join(process.env.DSH_HOME, file), 'utf8')))
          } catch (error) {
            result = { error: error.message }
          }
          await writeFile(join(process.env.DSH_HOME, file.replace('-request-', '-response-')), JSON.stringify(result))
        })()
      }
      if (file === 'agent-append.json' && !used) {
        used = true
        void (async () => {
          let result
          try {
            const data = JSON.parse(await readFile(join(process.env.DSH_HOME, 'agent-append.json'), 'utf8'))
            const { agent } = await ctx.sessionController.resolveAgent(data.sessionId)
            result = await ctx.tools.execute({ agent, callId: data.callId, name: 'drama_append',
              arguments: data.args, signal: new AbortController().signal })
          } catch (error) { result = { isError: true, content: [{ type: 'text', text: error.message }] } }
          await writeFile(join(process.env.DSH_HOME, 'agent-append.result.json'), JSON.stringify(result))
        })()
      }
      if (file === 'test-stop') {
        watcher.close()
        process.emit('SIGTERM')
      }
    })
    return () => {
      watcher.close()
      for (const gate of running.values()) gate.finish.resolve()
    }
  })
  const records = []
  for (const workspaceName of ['Studio Shared', 'Studio Other']) {
    const path = join(process.env.DSH_HOME, workspaceName)
    await mkdir(path, { recursive: true })
    const workspace = await ctx.workspaceRegistry.create(path)
    for (const suffix of workspaceName === 'Studio Shared' ? ['A', 'B', 'C'] : ['Other']) {
      const name = 'Studio Session ' + suffix
      const { sessionId } = await ctx.sessionController.create({ workspaceId: workspace.id })
      const { agent } = await ctx.sessionController.resolveAgent(sessionId)
      const session = agent.session
      session.append('turn/start', { turn: 1 })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: name }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      session.append('step/start', { turn: 1, step: 1 })
      session.append('assistant/message', {
        stream: [], turn: 1, step: 1,
        message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'Fixture' }],
          source: { kind: 'model', provider: 'fixture', model: 'fixture' } }),
      }, { surfaceOp: 'append' })
      session.append('step/end', { turn: 1, step: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await ctx.sessionController.rename({ sessionId, title: name })
      records.push({ name, workspaceName, sessionId, workspaceId: workspace.id })
    }
  }
  console.info('[drama-web-fixture] sessions ' + JSON.stringify(records))
}
`

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

test('Windows launcher reports an occupied Web port before loading the profile', async () => {
  const server = createServer()
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address()
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts', 'dev.ps1'),
      '-Profile', 'port-check', '-Port', String(port), '-NoOpen',
    ], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10_000,
      env: { ...process.env, DSH_HOME: join(runtime, randomUUID()) },
    })
    assert.equal(result.status, 1, result.error?.message || result.stderr)
    assert.ok(result.stderr.includes(`Port 127.0.0.1:${port} is already in use`), result.stderr)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

function redact(text) {
  return text.replace(/(https?:\/\/127\.0\.0\.1:\d+[^\s?]*\?)[^\s"'<>]+/gu, '$1[redacted]')
}

const chrome = [
  join(process.env.ProgramFiles, 'Google/Chrome/Application/chrome.exe'),
  join(process.env['ProgramFiles(x86)'], 'Microsoft/Edge/Application/msedge.exe'),
].find(existsSync)
const evidence = process.env.DRAMA_UIUX_CAPTURE_DIR ?? join(root, 'docs', 'uiux-v2')
const desktop = join(process.env.USERPROFILE ?? '', 'Desktop')
const imageAsset = process.env.DRAMA_UIUX_IMAGE ?? join(desktop, '课件/4-5-6文生图 图生图/文生图 资料/资产/黄色毛绒小鸭.png')
const projectImageAsset = process.env.DRAMA_UIUX_PROJECT_IMAGE ?? join(dirname(imageAsset), '餐厅门口.png')
const videoAsset = process.env.DRAMA_UIUX_VIDEO ?? join(desktop, '转绘项目-1000条样片/导出测试/测试片段.mp4')
const hasImage = existsSync(imageAsset)
const hasVideo = existsSync(videoAsset)
const capture = process.env.DRAMA_UIUX_CAPTURE === '1'
const studioExecutable = process.env.DRAMA_UIUX_STUDIO_EXE

async function screenshot(page, file) {
  if (!capture) return
  await mkdir(evidence, { recursive: true })
  await page.screenshot({ path: join(evidence, file), animations: 'disabled' })
}

async function withWeb(run, { providerFixture = false } = {}) {
  assert.ok(chrome, 'Install Chrome or Edge for native DSH Web verification')
  await mkdir(runtime, { recursive: true })
  const home = await mkdtemp(join(runtime, 'web-'))
  const profile = join(home, 'profiles', 'web')
  const fixture = join(home, 'fixture.mjs')
  const entryRoot = join(profile, 'node_modules', 'dsh-my-drama-studio')
  await mkdir(dirname(entryRoot), { recursive: true })
  await writeFile(join(home, 'package.json'), '{"name":"drama-web-fixture","private":true}\n')
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true, dependencies: { 'dsh-my-drama-studio': '0.1.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-my-drama-studio'] } },
  }))
  await writeFile(fixture, fixtureSource)
  const port = await freePort()
  const env = { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: join(home, 'agents'), DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_API_KEY: '' }
  const isolatedPlugin = providerFixture || studioExecutable
  if (isolatedPlugin) {
    await mkdir(join(entryRoot, 'dist'), { recursive: true })
    for (const file of ['package.json', 'dsh.bundle.patch', 'dist/host.js', 'dist/client.js']) {
      await copyFile(join(root, file), join(entryRoot, file))
    }
    const executable = join(entryRoot, 'dist', 'studio.exe')
    if (providerFixture) {
      const compile = spawnSync('go.exe', ['test', '-c', '-o', executable, './studio'], {
        cwd: root, encoding: 'utf8', timeout: 90_000, windowsHide: true,
        env: { ...process.env, GOARCH: 'amd64', CGO_ENABLED: '0', GOCACHE: join(runtime, 'uiux-go-cache') },
      })
      assert.equal(compile.status, 0, compile.stderr || compile.error?.message)
      env.DRAMA_UIUX_PROVIDER_FIXTURE = resolve(videoAsset)
    } else await copyFile(studioExecutable, executable)
  } else await symlink(root, entryRoot, 'junction')
  await writeFile(join(profile, 'cordis.patch.yml'), `- id: ui-settings-models
  config:
    credentialOnboarding: false
- insert:
    - id: drama-web-fixture
      name: ${JSON.stringify(fixture.replaceAll('\\', '/'))}
`)
  const launch = `$launcher = Join-Path $env:LOCALAPPDATA 'Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd'
& $launcher web --host 127.0.0.1 --port ${port} --no-open
exit $LASTEXITCODE`
  const [shell, args] = isolatedPlugin ? ['pwsh.exe', ['-NoProfile', '-Command', launch]]
    : ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts', 'dev.ps1'),
      '-Port', String(port), '-NoOpen']]
  const dsh = spawn(shell, args, {
    cwd: root, windowsHide: true, env,
  })
  let output = ''
  let launchError
  dsh.on('error', error => { launchError = error })
  dsh.stdout.on('data', chunk => { output += chunk })
  dsh.stderr.on('data', chunk => { output += chunk })
  let browser, page
  const pageErrors = []
  const consoleErrors = []
  let passed = false
  try {
    let url, records
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline && (!url || !records)) {
      if (launchError) throw launchError
      if (dsh.exitCode !== null) throw new Error(`DSH exited with code ${dsh.exitCode}`)
      url = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?\S+)/u)?.[1]
      const fixtureOutput = output.match(/\[drama-web-fixture\] sessions (\[[^\r\n]+\])/u)?.[1]
      if (fixtureOutput) records = JSON.parse(fixtureOutput)
      if (!url || !records) await delay(100)
    }
    assert.ok(url && records, 'Native DSH did not start')
    assert.match(output, /My Drama Studio Host loaded/u)
    browser = await chromium.launch({ executablePath: chrome, headless: true })
    const context = await browser.newContext({ locale: 'en-US', colorScheme: 'light', viewport: { width: 1680, height: 1000 } })
    page = await context.newPage()
    page.on('pageerror', error => pageErrors.push(error.stack ?? error.message))
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    await initialize(page, url)
    await run({ page, context, url, records, home })
    assert.deepEqual(pageErrors, [])
    passed = true
  } catch (error) {
    await page?.screenshot({ path: join(home, 'failure.png'), animations: 'disabled' }).catch(() => {})
    throw new Error(redact(`${error.stack}\nTest profile: ${home}\nBrowser errors:\n${[...pageErrors, ...consoleErrors].join('\n')}\nDSH output:\n${output.split(/\r?\n/u).slice(0, 25).join('\n')}`))
  } finally {
    const closingBrowser = browser?.close()
    const pid = output.match(/\[drama-web-fixture\] PID (\d+)/u)?.[1]
    if (pid && dsh.exitCode === null) {
      const stopped = new Promise(resolve => dsh.once('exit', resolve))
      await writeFile(join(home, 'test-stop'), '')
      await Promise.race([stopped, delay(8000, undefined, { ref: false })])
      if (dsh.exitCode === null) spawnSync('taskkill.exe', ['/PID', pid, '/T', '/F'], { windowsHide: true, timeout: 2500 })
    }
    dsh.kill()
    dsh.stdin.destroy()
    dsh.stdout.destroy()
    dsh.stderr.destroy()
    dsh.unref()
    await closingBrowser
    if (!isolatedPlugin) await unlink(entryRoot)
    if (passed) {
      const target = resolve(home)
      assert.equal(dirname(target), resolve(runtime))
      assert.ok(basename(target).startsWith('web-'))
      await rm(target, { recursive: true, maxRetries: 4, retryDelay: 120 })
    }
  }
}

async function initialize(page, url) {
  page.setDefaultTimeout(10_000)
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  const onboarding = page.getByRole('button', { name: 'Continue', exact: true })
  if (new URL(url).search) await onboarding.click()
  else {
    await page.getByText('Studio Shared', { exact: true }).waitFor()
    if (await onboarding.isVisible()) await onboarding.click()
  }
  assert.ok(await page.evaluate(() =>
    window.__DSH_BOOT__.entries.some(entry => entry.id === 'dsh-my-drama-studio')))
}

const panel = page => page.getByTestId('drama-canvas')
const flow = page => page.getByRole('region', { name: '创作节点画布', exact: true })
const drama = page => page.getByRole('button', { name: 'Drama', exact: true })
const card = (page, id) => flow(page).locator(`article[data-drama-node-id="${id}"]`)
const graphEdge = (page, source, target) =>
  flow(page).locator('.react-flow__edge[data-id=' + JSON.stringify(JSON.stringify([source, target])) + ']')
const draftCard = page => flow(page).locator('article[data-drama-draft="true"]')
const menu = page => page.getByRole('button', { name: 'Drama 设置', exact: true })
const sidebarMode = (page, mode) => page.locator(`[data-sidebar-right-mode="${mode}"]`).first()

async function select(page, record) {
  const workspace = page.getByText(record.workspaceName, { exact: true }).first()
    .locator('xpath=ancestor::*[@role="treeitem"][1]')
  await workspace.waitFor()
  if (await workspace.getAttribute('aria-expanded') !== 'true') await workspace.click()
  await page.getByRole('treeitem', { name: new RegExp(record.name) }).click()
  await drama(page).waitFor()
  assert.equal(await drama(page).count(), 1)
}

async function open(page, record) {
  await drama(page).click()
  const tab = page.locator('[data-rightbar-col] [data-dockkit-tab]').filter({ hasText: 'Drama Canvas' })
  const scoped = panel(page).and(page.locator(
    `[data-session-id="${record.sessionId}"][data-workspace-id="${record.workspaceId}"][data-canvas-id]`,
  ))
  await scoped.waitFor()
  assert.equal(await tab.count(), 1)
  return scoped.getAttribute('data-canvas-id')
}

async function request(page, endpoint, data) {
  return page.evaluate(async ({ endpoint, data }) => {
    const response = await fetch(`/api/drama/${endpoint}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
      signal: AbortSignal.timeout(15_000),
    })
    return { status: response.status, body: await response.json() }
  }, { endpoint, data })
}

async function ok(page, endpoint, data) {
  const response = await request(page, endpoint, data)
  assert.equal(response.status, 200, response.body.error)
  return response.body
}

const ticketFor = async (page, sessionId) => (await ok(page, 'init', { sessionId })).ticket
const operate = (page, ticket, action, data) => ok(page, 'operation', { ticket, action, data })
const query = (page, ticket, data = {}) => operate(page, ticket, 'query', data)
const append = (page, ticket, nodes, edges = []) =>
  operate(page, ticket, 'append', { operationId: randomUUID(), nodes, edges })

async function poll(fn, label, timeout = 10_000) {
  const deadline = Date.now() + timeout
  let value
  do {
    value = await fn()
    if (value) return value
    await delay(80)
  } while (Date.now() < deadline)
  throw new Error(label)
}

async function nativeActivity(home, record, action, nodeId) {
  const requestId = randomUUID()
  const temporary = join(home, 'activity-' + requestId + '.tmp')
  await writeFile(temporary, JSON.stringify({ sessionId: record.sessionId, requestId, action, nodeId }))
  await rename(temporary, join(home, 'activity-request-' + requestId + '.json'))
  const result = await poll(async () => {
    try {
      return JSON.parse(await readFile(join(home, 'activity-response-' + requestId + '.json'), 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
  }, 'native activity command did not return: ' + action)
  assert.ok(!result.error, result.error)
  return result.status
}

async function frameWidth(page, expected) {
  const width = (await panel(page).boundingBox())?.width ?? 0
  return expected ? Math.abs(width - expected) < 12 : width
}

async function resizeRightbar(page, target) {
  const handle = page.locator('[data-side="rightbar"]').first()
  await handle.waitFor()
  const bounds = await handle.boundingBox()
  const current = await frameWidth(page)
  const x = bounds.x + bounds.width / 2
  const y = bounds.y + Math.min(85, bounds.height / 2)
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + current - target, y, { steps: 12 })
  await page.mouse.up()
  await poll(() => frameWidth(page, target), `native rightbar did not resize to ${target} CSS px`)
}

async function assertCanvasLayout(page) {
  const result = await panel(page).evaluate(root => {
    const flow = root.querySelector('.react-flow')
    const rect = flow.getBoundingClientRect()
    return { flowRatio: rect.height / root.clientHeight, rootOverflow: root.scrollHeight - root.clientHeight,
      horizontalOverflow: root.scrollWidth - root.clientWidth,
      outsideForms: [...root.querySelectorAll('form')].filter(form => !flow.contains(form)).length }
  })
  assert.ok(result.flowRatio > .85, JSON.stringify(result))
  assert.ok(result.rootOverflow < 4 && result.horizontalOverflow < 4, JSON.stringify(result))
  assert.equal(result.outsideForms, 0)
}

async function setPermission(page, enabled) {
  const status = page.getByTestId('drama-permission')
  await menu(page).click()
  const toggle = page.getByRole('switch', { name: '自动执行生成', exact: true })
  await toggle.waitFor()
  assert.equal(await toggle.getAttribute('aria-checked'), String(!enabled))
  await toggle.click()
  await poll(async () => (await status.textContent())?.includes(enabled ? '自动' : '手动'), 'permission pill did not update')
  if (await toggle.isVisible()) await page.keyboard.press('Escape')
}

test('U1 native composer menu and Canvas shell', { timeout: 75_000 }, async () => {
  await withWeb(async ({ page, records, home }) => {
    const [a] = records
    await select(page, a)
    await menu(page).click()
    await page.getByText('打开项目画布', { exact: true }).waitFor()
    await screenshot(page, '10-after-composer-menu.png')
    await page.getByText('打开项目画布', { exact: true }).click()
    await panel(page).waitFor()
    await flow(page).waitFor()
    await assertCanvasLayout(page)
    assert.equal(await panel(page).getByText('生成任务（0）', { exact: true }).count(), 0)
    const nativeControls = await page.evaluate(() => {
      const scopes = [document.querySelector('[data-testid="drama-canvas"]'), document.querySelector('button[aria-label="Drama"]')?.parentElement]
      return scopes.flatMap(scope => [...(scope?.querySelectorAll('button') ?? [])]).filter(button => {
        const style = getComputedStyle(button)
        return button.offsetWidth > 0 && style.appearance === 'auto' && style.borderStyle === 'outset'
      }).length
    })
    assert.equal(nativeControls, 0, 'unreset user-agent buttons are still visible')
    async function openSettings() {
      await page.getByRole('button', { name: 'Account menu', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
      await dialog.getByRole('button', { name: 'Drama Studio', exact: true }).click()
      const section = dialog.getByTestId('drama-settings')
      await section.getByRole('button', { name: '新增渠道', exact: true }).waitFor()
      return section
    }
    const settings = await openSettings()
    await screenshot(page, '11-after-settings.png')

    const apiKey = 'uiux-isolated-provider-credential'
    await settings.getByRole('button', { name: '新增渠道', exact: true }).click()
    await settings.getByRole('button', { name: '协议', exact: true }).click()
    await page.getByRole('menuitem', { name: 'OpenAI 兼容视频', exact: true }).click()
    await settings.getByLabel('渠道名称').fill('隔离测试渠道')
    await settings.getByLabel('Base URL').fill('https://video.invalid')
    await settings.locator('input[type="password"]').fill(apiKey)
    await settings.getByRole('button', { name: '保存渠道', exact: true }).click()
    await settings.getByText('渠道已保存', { exact: true }).waitFor()
    await settings.getByRole('button', { name: '编辑渠道', exact: true }).click()
    assert.equal(await settings.locator('input[type="password"]').inputValue(), '')
    await settings.getByLabel('渠道名称').fill('已编辑的测试渠道')
    await settings.getByRole('button', { name: '保存渠道', exact: true }).click()
    await settings.getByText('已编辑的测试渠道', { exact: true }).waitFor()

    await settings.getByRole('tab', { name: '模型预设', exact: true }).click()
    for (const name of ['测试视频模型 A', '测试视频模型 B']) {
      await settings.getByRole('button', { name: '新建预设', exact: true }).click()
      await settings.getByLabel('预设名称').fill(name)
      await settings.getByLabel('API Model ID').fill(name.endsWith('A') ? 'test-video-a' : 'test-video-b')
      await settings.getByRole('button', { name: '保存预设', exact: true }).click()
      await settings.getByText(name, { exact: true }).waitFor()
    }
    await settings.getByRole('tab', { name: '生成设置', exact: true }).click()
    await settings.getByRole('button', { name: '默认视频模型', exact: true }).click()
    await page.getByRole('menuitem', { name: '测试视频模型 A', exact: true }).click()
    await settings.getByLabel('最大并发数').fill('3')
    await settings.getByRole('button', { name: '保存生成设置', exact: true }).click()
    await settings.getByText('生成设置已保存', { exact: true }).waitFor()

    const data = await ok(page, 'providers', { action: 'provider_settings', data: {} })
    const channel = data.channels.find(item => item.name === '已编辑的测试渠道')
    assert.equal(channel?.configured, true)
    assert.equal(data.profiles.filter(profile => profile.channelId === channel.id).length, 2)
    assert.equal(data.generation.maxConcurrent, 3)
    assert.equal(data.profiles.find(profile => profile.id === data.generation.defaultModelId)?.name, '测试视频模型 A')
    assert.ok(!JSON.stringify(data).includes(apiKey))
    const patch = await readFile(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
    assert.ok(patch.includes('test-video-a') && !patch.includes(apiKey))

    await page.reload()
    await select(page, records.at(-1))
    const reopened = await openSettings()
    await reopened.getByText('已编辑的测试渠道', { exact: true }).waitFor()
    const shared = await ok(page, 'providers', { action: 'provider_settings', data: {} })
    assert.deepEqual(shared.generation, data.generation)
    assert.deepEqual(shared.profiles, data.profiles)
    await reopened.getByRole('tab', { name: '模型预设', exact: true }).click()
    for (const name of ['测试视频模型 A', '测试视频模型 B']) {
      const row = reopened.getByRole('listitem').filter({ hasText: name })
      await row.getByRole('button', { name: '删除预设', exact: true }).click()
      await row.getByRole('button', { name: '确认删除', exact: true }).click()
      await row.waitFor({ state: 'detached' })
    }
    await reopened.getByRole('tab', { name: '视频渠道', exact: true }).click()
    await reopened.getByRole('button', { name: '删除渠道', exact: true }).click()
    await reopened.getByRole('button', { name: '确认删除', exact: true }).click()
    await reopened.getByText('渠道已删除', { exact: true }).waitFor()
    const removed = await ok(page, 'providers', { action: 'provider_settings', data: {} })
    assert.ok(!removed.channels.some(item => item.id === channel.id))

    await reopened.getByRole('button', { name: '新增渠道', exact: true }).click()
    await reopened.getByRole('button', { name: '协议', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Custom REST', exact: true }).click()
    const customName = 'Custom REST 编辑夹具'
    for (const [label, value] of [
      ['渠道名称', customName], ['Base URL', 'https://video.invalid'],
      ['提交任务 URL', '/jobs'], ['查询任务 URL', '/jobs/{taskId}'],
      ['任务 ID 字段路径', 'id'], ['任务状态字段路径', 'status'],
      ['下载 URL', '/jobs/{taskId}/content'], ['时长字段', 'seconds'],
      ['成功状态值', 'done'], ['失败状态值', 'error'],
    ]) await reopened.getByLabel(label, { exact: true }).fill(value)
    await reopened.getByRole('button', { name: '保存渠道', exact: true }).click()
    const customRow = reopened.getByRole('listitem').filter({ hasText: customName })
    await customRow.getByText('密钥未设置', { exact: true }).waitFor()
    await customRow.getByRole('button', { name: '编辑渠道', exact: true }).click()
    assert.equal(await reopened.getByLabel('成功状态值', { exact: true }).inputValue(), 'done')
    await reopened.locator('input[type="password"]').fill(apiKey)
    await reopened.getByRole('button', { name: '保存渠道', exact: true }).click()
    await customRow.getByText('密钥已设置', { exact: true }).waitFor()
    const saved = await ok(page, 'providers', { action: 'provider_settings', data: {} })
    const custom = saved.channels.find(item => item.name === customName)
    assert.equal(custom?.configured, true)
    assert.equal(custom.advanced.downloadUrl, '/jobs/{taskId}/content')
    assert.deepEqual(custom.advanced.fields, { duration: 'seconds' })
    assert.deepEqual(custom.advanced.statusMap, { done: 'completed', error: 'failed' })
    assert.ok(!JSON.stringify(saved).includes(apiKey))
    console.info('U1 native DSH settings PASS: channel CRUD, shared models/defaults, browser reload, and protected credential')
  })
})

async function pick(page, name, ticket, type, openPicker) {
  const before = new Set((await query(page, ticket, { type })).nodes.map(node => node.id))
  if (openPicker) await openPicker()
  else await panel(page).getByRole('toolbar', { name: '画布工具', exact: true })
    .getByRole('button', { name: '新增节点', exact: true }).click()
  const input = page.getByRole('textbox', { name: '查找节点类型', exact: true })
  await input.fill(name)
  await input.press('Enter')
  const node = await poll(async () => (await query(page, ticket, { type })).nodes.find(node => !before.has(node.id)),
    'selecting ' + name + ' did not create a persisted node')
  await card(page, node.id).waitFor()
  return node
}

const nodeEditor = (page, id) => card(page, id).getByRole('form', { name: '编辑节点', exact: true })

async function editDetails(page, id, values) {
  const target = card(page, id)
  await target.hover()
  await target.getByRole('button', { name: '重命名', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '节点详情', exact: true })
  await dialog.waitFor()
  for (const [field, value] of Object.entries(values)) await dialog.getByRole('textbox', { name: field, exact: true }).fill(value)
  await dialog.getByRole('button', { name: '关闭节点详情', exact: true }).click()
}

async function chooseDuration(page, id, value) {
  const label = '时长（秒）'
  await nodeEditor(page, id).getByRole('button', { name: label, exact: true }).click()
  const popup = page.getByRole('dialog', { name: label, exact: true })
  const duration = popup.getByRole('spinbutton', { name: label, exact: true })
  await duration.fill(String(value))
  await duration.press('Enter')
  return popup
}

async function updateVideo(page, ticket, id, prompt) {
  await nodeEditor(page, id).getByRole('textbox', { name: '提示词', exact: true }).fill(prompt)
  await poll(async () => (await query(page, ticket, { id })).nodes[0]?.content.prompt === prompt,
    'video prompt did not persist')
}

async function chooseVideoMode(page, ticket, id, mode) {
  await nodeEditor(page, id).getByRole('button', { name: '视频方式', exact: true }).click()
  await page.getByRole('menuitem', { name: mode.toUpperCase(), exact: true }).click()
  return poll(async () => {
    const [node] = (await query(page, ticket, { id })).nodes
    return node?.content.mode === mode && node
  }, 'changing the video mode did not persist: ' + mode)
}

test('New canvas nodes are persisted and usable immediately from the picker', { timeout: 75_000 }, async () => {
  await withWeb(async ({ page, records, url }) => {
    const [record] = records
    await select(page, record)
    await open(page, record)
    let ticket = await ticketFor(page, record.sessionId)
    await panel(page).getByRole('button', { name: '搜索', exact: true }).click()
    const initialSearch = panel(page).getByRole('textbox', { name: '搜索节点', exact: true })
    await initialSearch.fill('不会匹配新节点')
    await initialSearch.press('Enter')
    const image = await pick(page, '图片', ticket, 'image')
    const picture = card(page, image.id)
    const upload = picture.getByRole('button', { name: '上传图片', exact: true })
    await upload.waitFor()
    if (hasImage) {
      const chooser = page.waitForEvent('filechooser')
      await upload.click()
      await (await chooser).setFiles(imageAsset)
      await poll(async () => (await query(page, ticket, { id: image.id })).nodes[0]?.content.path,
        'uploading a PNG did not persist before adding it as a reference')
      await picture.locator('img').first().evaluate(img => img.decode())
    }
    const imagePrompt = '新建图片功能验收，室内自然光照亮木桌。'
    await picture.getByRole('textbox', { name: '提示词', exact: true }).fill(imagePrompt)
    await clickBlank(page)
    await poll(async () => (await query(page, ticket, { id: image.id })).nodes[0]?.content.prompt === imagePrompt,
      'editing an immediately-created image did not persist')
    const video = await pick(page, '视频生成', ticket, 'video', async () => {
      await panel(page).getByRole('toolbar', { name: '画布工具', exact: true })
        .getByRole('button', { name: '新增节点', exact: true }).click()
      const picker = page.locator('.drama-v2-picker-list')
      await picker.getByText('视频生成', { exact: true }).waitFor()
      await picker.getByText('视频素材', { exact: true }).waitFor()
      assert.equal(await picker.getByText('视频生成', { exact: true }).count(), 1)
      assert.equal(await picker.getByText(/T2V|I2V|R2V|V2V/u).count(), 0)
    })
    const target = card(page, video.id)
    assert.equal(video.content.mode ?? '', '', 'new video should start without a selected generation mode')
    const editorMode = nodeEditor(page, video.id).getByRole('button', { name: '视频方式', exact: true })
    await editorMode.getByText('选择方式', { exact: true }).waitFor()
    await editorMode.click()
    for (const mode of ['T2V', 'I2V', 'R2V', 'V2V']) await page.getByRole('menuitem', { name: mode, exact: true }).waitFor()
    await page.keyboard.press('Escape')
    const unconfigured = await pick(page, '视频生成', ticket, 'video')
    await updateVideo(page, ticket, unconfigured.id, '先写提示词，之后选择生成方式。')
    const [unconfiguredStored] = (await query(page, ticket, { id: unconfigured.id })).nodes
    assert.equal(unconfiguredStored.content.mode, '', 'editing a prompt unexpectedly selected a generation mode')
    const missingMode = await request(page, 'operation', { ticket, action: 'generateT2V', data: {
      operationId: randomUUID(), nodeId: unconfigured.id, confirmed: true,
    } })
    assert.equal(missingMode.status, 400, JSON.stringify(missingMode.body))
    assert.match(missingMode.body.error, /生成方式/u)
    const submit = nodeEditor(page, unconfigured.id).getByRole('button', { name: '生成…', exact: true })
    assert.ok(await submit.isDisabled(), 'generation was enabled without a selected mode')
    await clickBlank(page)
    await dragReference(page, image.id, video.id)
    async function assertBlankMediaLink(id) {
      const linked = await poll(async () => {
        const snapshot = await query(page, ticket, { id })
        return snapshot.edges.some(edge => edge.source === image.id && edge.target === id) && snapshot.nodes[0]
      }, 'video media link was not persisted before the prompt was written')
      assert.equal((linked.content.prompt ?? '').trim(), '')
      assert.equal(linked.content.mode, 'i2v')
      assert.deepEqual(linked.content.mixedListOrder, [image.id])
      assert.equal(linked.content.textList, undefined)
      return linked
    }
    await assertBlankMediaLink(video.id)
    const generate = target.getByRole('button', { name: '生成…', exact: true })
    await generate.waitFor()
    assert.ok(await generate.isDisabled(), 'generation was enabled without an inline prompt')
    const blocked = await request(page, 'operation', { ticket, action: 'generateI2V',
      data: { operationId: randomUUID(), nodeId: video.id, confirmed: true } })
    assert.equal(blocked.status, 400, JSON.stringify(blocked.body))
    assert.match(blocked.body.error, /提示词/u)
    const prompt = '新建视频功能验收，镜头缓慢推近木桌，保持自然光。'
    await updateVideo(page, ticket, video.id, prompt)
    await clickBlank(page)
    await panel(page).getByRole('button', { name: '搜索', exact: true }).click()
    const search = panel(page).getByRole('textbox', { name: '搜索节点', exact: true })
    await search.fill('新建视频功能验收')
    await search.press('Enter')
    await picture.waitFor({ state: 'detached' })
    await fit(page)
    await target.locator('.drama-node-titlebar').click({ button: 'right' })
    await page.getByRole('menuitem', { name: /^删除节点/u }).click()
    const confirm = page.getByRole('dialog', { name: '删除节点', exact: true })
    await confirm.getByRole('button', { name: '确认删除', exact: true }).click()
    await target.waitFor({ state: 'detached' })
    assert.equal((await query(page, ticket, { id: video.id })).nodes[0].deleted, true)
    assert.equal((await query(page, ticket, { id: image.id })).nodes[0].content.prompt, imagePrompt)
    const audio = await pick(page, '音频素材', ticket, 'audio')
    await card(page, audio.id).getByRole('button', { name: '上传音频', exact: true }).waitFor()
    await nodeEditor(page, audio.id).getByRole('button', { name: '保存修改', exact: true }).waitFor()
    const standalone = await pick(page, '提示词笔记', ticket, 'prompt')
    await nodeEditor(page, standalone.id).getByRole('textbox', { name: '提示词', exact: true }).fill('独立文本说明')
    await nodeEditor(page, standalone.id).getByRole('button', { name: '保存修改', exact: true }).click()
    await poll(async () => (await query(page, ticket, { id: standalone.id })).nodes[0]?.content.prompt === '独立文本说明',
      'editing a new standalone prompt node did not persist')
    await clickBlank(page)
    await fit(page)
    const successor = await pick(page, '视频生成', ticket, 'video', async () => {
      await picture.hover()
      await picture.getByRole('button', { name: '新增后继节点', exact: true }).click()
    })
    await assertBlankMediaLink(successor.id)
    const pickerVideo = await pick(page, '视频生成', ticket, 'video')
    await chooseVideoMode(page, ticket, pickerVideo.id, 'i2v')
    const editor = nodeEditor(page, pickerVideo.id)
    await editor.getByRole('button', { name: '添加首帧', exact: true }).click()
    const references = page.getByRole('dialog', { name: '添加参考素材', exact: true })
    await references.getByRole('button', { name: '添加图片素材', exact: true }).click()
    const [source] = (await query(page, ticket, { id: image.id })).nodes
    await page.getByRole('menuitem').filter({ hasText: source.content.title ?? '图片' }).click()
    const manual = await assertBlankMediaLink(pickerVideo.id)
    await clickBlank(page)
    await dragReference(page, standalone.id, pickerVideo.id)
    await flow(page).getByRole('alert').filter({ hasText: /只接受图片、视频或音频/u }).waitFor()
    const invalidEdge = await request(page, 'operation', { ticket, action: 'append', data: {
      operationId: randomUUID(), edges: [{ source: standalone.id, target: pickerVideo.id }],
    } })
    assert.equal(invalidEdge.status, 400, JSON.stringify(invalidEdge.body))
    assert.equal((await query(page, ticket, { id: pickerVideo.id })).nodes[0].revision, manual.revision)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await initialize(page, new URL(url).origin)
    await select(page, record)
    if (!(await panel(page).isVisible())) await open(page, record)
    ticket = await ticketFor(page, record.sessionId)
    await flow(page).waitFor()
    await assertBlankMediaLink(successor.id)
    await assertBlankMediaLink(pickerVideo.id)
    assert.equal((await query(page, ticket, { id: unconfigured.id })).nodes[0].content.mode, '')
    assert.deepEqual((await query(page, ticket, { id: pickerVideo.id })).edges,
      [{ source: image.id, target: pickerVideo.id }])
    assert.equal((await operate(page, ticket, 'tasks', {})).tasks.length, 0)
  })
})

async function inputLayoutTest(page, textarea) {
  const viewport = flow(page).locator('.react-flow__viewport')
  const draft = textarea.locator('xpath=ancestor::article[1]')
  const position = draft.locator('xpath=ancestor::div[contains(@class,"react-flow__node")][1]')
  const bounds = await textarea.boundingBox()
  assert.ok(bounds && bounds.height > 16)
  const before = await viewport.evaluate(element => element.style.transform)
  const nodeBefore = await position.evaluate(element => element.style.transform)
  const point = { x: bounds.x + Math.min(30, bounds.width / 4), y: bounds.y + 13 }
  const target = await textarea.evaluate((element, point) => {
    const hit = document.elementFromPoint(point.x, point.y)
    return hit === element ? '' : hit?.outerHTML.slice(0, 180) ?? 'outside viewport'
  }, point)
  assert.equal(target, '', 'textarea drag starts outside the editor')
  await page.mouse.move(point.x, point.y)
  await page.mouse.down()
  await page.mouse.move(point.x + 46, point.y + 10, { steps: 9 })
  await page.mouse.up()
  const selectedText = await textarea.evaluate(element => element.selectionEnd - element.selectionStart)
  assert.ok(selectedText > 0, 'text drag did not select text')
  await textarea.press('Control+a')
  assert.equal(await textarea.evaluate(element => element.selectionEnd - element.selectionStart === element.value.length), true)
  await textarea.press('Backspace')
  assert.equal(await textarea.inputValue(), '')
  assert.equal(await draft.count(), 1, 'editing shortcut deleted the draft')
  const scrollText = Array.from({ length: 32 }, (_, i) => `第 ${i + 1} 行，滚轮只滚动节点中的长文本。`).join('\n')
  await textarea.fill(scrollText)
  await textarea.evaluate(element => { element.scrollTop = 0 })
  await page.mouse.move(point.x, point.y)
  await page.mouse.wheel(0, 380)
  await poll(() => textarea.evaluate(element => element.scrollTop > 0), 'wheel did not scroll the textarea')
  assert.equal(await viewport.evaluate(element => element.style.transform), before, 'text wheel/drag moved the canvas')
  assert.equal(await position.evaluate(element => element.style.transform), nodeBefore, 'text selection dragged the node')
}

async function dragCanvasBlank(page, withSpace = false) {
  const region = flow(page)
  const point = await region.evaluate(element => {
    const bounds = element.getBoundingClientRect()
    for (const yy of [.78, .62, .46]) {
      for (const xx of [.81, .66, .48, .28]) {
        const x = Math.round(bounds.left + bounds.width * xx)
        const y = Math.round(bounds.top + bounds.height * yy)
        if (document.elementFromPoint(x, y)?.classList.contains('react-flow__pane')) return { x, y }
      }
    }
    return null
  })
  assert.ok(point, 'no visible blank canvas area')
  const viewport = region.locator('.react-flow__viewport')
  const before = await viewport.evaluate(element => element.style.transform)
  if (withSpace) {
    await region.focus()
    await page.keyboard.down('Space')
  }
  await page.mouse.move(point.x, point.y)
  await page.mouse.down()
  await page.mouse.move(point.x - 30, point.y - 35, { steps: 10 })
  await page.mouse.up()
  if (withSpace) await page.keyboard.up('Space')
  await poll(async () => (await viewport.evaluate(element => element.style.transform)) !== before, 'blank drag did not pan canvas')
  return point
}

async function setTheme(page, scheme) {
  await page.emulateMedia({ colorScheme: scheme })
  await page.waitForFunction(dark => document.body.hasAttribute('data-ds-dark-theme') === dark, scheme === 'dark')
}

async function fit(page) {
  await panel(page).getByRole('button', { name: '适配视图', exact: true }).click()
  await delay(280)
}

async function dragReference(page, source, target) {
  await fit(page)
  const point = handle => handle.evaluate(element => {
    const box = element.getBoundingClientRect()
    const x = box.left + box.width / 2
    const y = box.top + box.height / 2
    const hit = document.elementFromPoint(x, y)
    return { x, y, clickable: hit === element, hit: hit?.outerHTML.slice(0, 160) }
  })
  const from = await point(card(page, source).locator('.drama-port-output'))
  const to = await point(card(page, target).locator('.drama-port-input'))
  assert.ok(from.clickable && to.clickable, JSON.stringify({ from, to }))
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 20 })
  await page.mouse.up()
}

async function clickBlank(page) {
  const blank = await flow(page).locator('.react-flow__pane').evaluate(pane => {
    const bounds = pane.getBoundingClientRect()
    for (const y of [.72, .82, .48, .6, .22]) {
      for (const x of [.88, .72, .52, .38, .18, .12]) {
        const point = { x: bounds.left + bounds.width * x, y: bounds.top + bounds.height * y }
        if (document.elementFromPoint(point.x, point.y) === pane) return point
      }
    }
    return null
  })
  assert.ok(blank, 'no blank canvas area available')
  await page.mouse.click(blank.x, blank.y)
}

async function dragNode(page, id) {
  const titlebar = card(page, id).locator('.drama-node-titlebar')
  await titlebar.scrollIntoViewIfNeeded()
  const hit = await titlebar.evaluate(element => {
    const rect = element.getBoundingClientRect()
    const x = rect.left + rect.width * .3
    const y = rect.top + rect.height * .48
    const target = document.elementFromPoint(x, y)
    return { x, y, matches: target?.closest('.drama-node-titlebar') === element, target: target?.outerHTML.slice(0, 180) }
  })
  assert.ok(hit.matches, JSON.stringify(hit))
  const movable = card(page, id).locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " ")," react-flow__node ")][1]')
  const viewport = flow(page).locator('.react-flow__viewport')
  const state = async () => ({
    position: await movable.evaluate(element => element.style.transform),
    selection: await movable.getAttribute('class'),
    viewport: await viewport.evaluate(element => element.style.transform),
  })
  const before = await state()
  await page.mouse.move(hit.x, hit.y)
  await page.mouse.down()
  await page.mouse.move(hit.x + 40, hit.y + 55, { steps: 10 })
  const during = await state()
  await page.mouse.up()
  const after = await state()
  assert.notEqual(after.position, before.position, JSON.stringify({ hit, before, during, after }))
  assert.equal(after.viewport, before.viewport, 'title drag moved the viewport')
}

async function focusNode(page, id) {
  const title = card(page, id).locator('.drama-node-heading strong')
  const point = await poll(() => title.evaluate(element => {
    const box = element.getBoundingClientRect()
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    return document.elementFromPoint(x, y) === element && { x, y }
  }), 'the node title was not visible for focus')
  await page.mouse.dblclick(point.x, point.y)
  await poll(async () => (await flow(page).getAttribute('data-focused-node')) === id,
    'double-clicking the node title did not open focus mode')
}

async function ensureZoomScreenshot(url, home, record, context) {
  const profile = join(home, 'browser-125')
  await mkdir(join(profile, 'Default'), { recursive: true })
  // Actual Chromium page zoom. The default storage partition is keyed "x".
  await writeFile(join(profile, 'Default', 'Preferences'), JSON.stringify({
    partition: { default_zoom_level: { x: Math.log(1.25) / Math.log(1.2) } },
  }))
  const zoomed = await chromium.launchPersistentContext(profile, {
    executablePath: chrome, headless: true, viewport: null,
    locale: 'en-US', colorScheme: 'light', args: ['--window-size=1680,1000', '--force-device-scale-factor=1'],
  })
  try {
    const state = await context.storageState()
    await zoomed.addCookies(state.cookies)
    await zoomed.addInitScript(origins => {
      const state = origins.find(item => item.origin === location.origin)
      for (const item of state?.localStorage ?? []) localStorage.setItem(item.name, item.value)
    }, state.origins)
    const page = zoomed.pages()[0]
    await initialize(page, new URL(url).origin)
    await select(page, record)
    await open(page, record)
    const actual = await page.evaluate(() => ({ devicePixelRatio, scale: visualViewport.scale, width: innerWidth }))
    assert.equal(actual.devicePixelRatio, 1.25)
    assert.equal(actual.scale, 1)
    assert.ok(actual.width < 1350, JSON.stringify(actual))
    await assertCanvasLayout(page)
    await fit(page)
    await screenshot(page, '24-after-chrome-125.png')
    console.info('Chrome 125% native page zoom PASS', JSON.stringify(actual))
  } finally { await zoomed.close() }
}

async function decodeVideoFrame(player) {
  return player.evaluate(async video => {
    video.muted = true
    await video.play()
    await new Promise(resolve => {
      video.addEventListener('seeked', resolve, { once: true })
      video.currentTime = Math.min(1, video.duration / 2)
    })
    await new Promise(resolve => video.requestVideoFrameCallback(resolve))
    video.pause()
    return video.currentTime > 0 && video.videoWidth > 0
  })
}

async function addExistingMedia(page, ticket, workspace) {
  const imageId = randomUUID()
  const videoId = randomUUID()
  const meta = { episodeId: 'EP01', sceneId: 'S01', shotId: 'SH03' }
  const additions = [
    { type: 'script', ...meta, content: { title: '夜归', text: '她推开餐厅的门。桌边留着一盏灯，一只黄色小鸭静静地等着她。' } },
    { type: 'prompt', ...meta, content: { title: '餐厅镜头提示', prompt: '室内固定中景，暖灯下门缓缓打开，人物推门后停住，视线落到桌角。' } },
    { type: 'note', ...meta, content: { title: '剪辑备忘', text: '保留开门后的半拍停顿。' } },
  ]
  if (hasImage) {
    await mkdir(join(workspace, 'assets', 'images'), { recursive: true })
    await copyFile(imageAsset, join(workspace, 'assets', 'images', 'duck.png'))
    additions.push({ id: imageId, type: 'image', ...meta, content: { title: '黄色毛绒小鸭', description: '课程现有道具参考图', path: 'assets/images/duck.png' } })
  }
  if (hasVideo) {
    await mkdir(join(workspace, 'assets', 'videos'), { recursive: true })
    await copyFile(videoAsset, join(workspace, 'assets', 'videos', 'local-clip.mp4'))
    additions.push({ id: videoId, type: 'video', ...meta, content: { title: '项目原有视频片段', description: '已有视频素材，用于检查播放。', path: 'assets/videos/local-clip.mp4' } })
  }
  await append(page, ticket, additions)
  return { imageId, videoId }
}

test('U2 U3 U5 new nodes, derived drafts, shared Sessions, media and native theme/layout', { timeout: 180_000 }, async () => {
  await withWeb(async ({ page, context, url, records, home }) => {
    const [a, b, c, other] = records
    await select(page, a)
    const canvasId = await open(page, a)
    const first = await ticketFor(page, a.sessionId)
    await assertCanvasLayout(page)
    const observer = await context.newPage()
    await initialize(observer, new URL(url).origin)
    await select(observer, b)
    assert.equal(await open(observer, b), canvasId)
    const second = await ticketFor(observer, b.sessionId)
    await select(observer, c)
    assert.equal(await open(observer, c), canvasId)
    await setPermission(observer, true)
    assert.equal((await ok(observer, 'init', { sessionId: c.sessionId })).status.autoGenerate, true)
    for (const record of [a, b]) assert.equal((await ok(page, 'init', { sessionId: record.sessionId })).status.autoGenerate, false)
    await setPermission(observer, false)
    await select(observer, other)
    assert.notEqual(await open(observer, other), canvasId)
    await select(observer, b)
    assert.equal(await open(observer, b), canvasId)

    await page.bringToFront()
    const shot = await pick(page, '镜头', first, 'shot')
    const create = nodeEditor(page, shot.id)
    await create.getByText('名称与镜头', { exact: true }).click()
    const name = create.getByRole('textbox', { name: '节点名称', exact: true })
    await name.fill('推门进入餐厅')
    await create.getByRole('textbox', { name: '集', exact: true }).fill('EP01')
    await create.getByRole('textbox', { name: '场', exact: true }).fill('S01')
    await create.getByRole('textbox', { name: '镜头', exact: true }).fill('SH03')
    const description = create.getByRole('textbox', { name: '正文', exact: true })
    await description.fill('中景固定机位。人物推门后停顿，视线落到桌角的黄色小鸭。')
    await screenshot(page, '20-after-new-shot.png')
    await assertCanvasLayout(page)
    await create.getByRole('button', { name: '保存修改', exact: true }).click()
    await create.waitFor({ state: 'hidden' })
    const [original] = (await query(page, first, { q: '推门进入餐厅' })).nodes
    assert.ok(original?.id)
    assert.equal(original.shotId, 'SH03')
    await observer.bringToFront()
    await card(observer, original.id).waitFor()
    await card(observer, original.id).hover()
    await card(observer, original.id).getByRole('button', { name: '派生版本', exact: true }).click()
    const revision = draftCard(observer).last().getByRole('form', { name: '另存为新版本', exact: true })
    await revision.getByRole('textbox', { name: '节点名称', exact: true }).fill('推门进入餐厅 V2')
    await revision.getByRole('textbox', { name: '正文', exact: true }).fill('机位贴近门轴。她抬头后才看见桌角的小鸭。')
    await screenshot(observer, '21-after-derived-shot.png')
    await revision.getByRole('button', { name: '保存新版本', exact: true }).click()
    const revised = await poll(async () => (await query(observer, second, { q: '推门进入餐厅 V2' })).nodes[0], 'derived shot not persisted')
    assert.equal(revised.basedOn, original.id)
    assert.equal((await query(page, first, { id: original.id })).nodes[0].content.description, original.content.description)
    await page.bringToFront()
    await card(page, revised.id).waitFor()
    assert.equal(await card(page, original.id).count(), 1)
    await fit(page)
    await flow(page).locator('.react-flow__edge.drama-edge-version').first().waitFor()
    await screenshot(page, '22-after-version-chain.png')

    const newVideo = await pick(page, '视频生成', first, 'video', async () => {
      const point = await dragCanvasBlank(page)
      await page.mouse.click(point.x, point.y, { button: 'right' })
    })
    await chooseVideoMode(page, first, newVideo.id, 't2v')
    await card(page, newVideo.id).getByRole('button', { name: '派生版本', exact: true }).click()
    const videoDraft = draftCard(page).last()
    const videoPrompt = videoDraft.getByRole('textbox', { name: '完整视频提示词', exact: true })
    await videoPrompt.fill('完整视频提示词。她推开餐厅门，先停顿，再将视线落向桌角。\n镜头保持固定中景。')
    await inputLayoutTest(page, videoPrompt)
    await screenshot(page, '23-after-prompt-editor.png')
    await videoDraft.getByRole('button', { name: '取消', exact: true }).click()
    await videoDraft.waitFor({ state: 'hidden' })
    await fit(page)
    await card(page, newVideo.id).locator('.drama-node-titlebar').click()
    await page.keyboard.press('Delete')
    await card(page, newVideo.id).waitFor({ state: 'detached' })
    assert.equal((await query(page, first, { type: 'video' })).nodes.length, 0)

    await fit(page)
    await card(page, revised.id).locator('.drama-node-titlebar').click({ button: 'right' })
    await page.getByRole('menuitem', { name: '复制 · Ctrl+C', exact: true }).waitFor()
    await page.keyboard.press('Escape')
    const successorNode = await pick(page, '备注', first, 'note', async () => {
      await card(page, revised.id).hover()
      await card(page, revised.id).getByRole('button', { name: '新增后继节点', exact: true }).click()
    })
    const successor = nodeEditor(page, successorNode.id)
    await successor.getByText('名称与镜头', { exact: true }).click()
    await successor.getByRole('textbox', { name: '节点名称', exact: true }).fill('后继剪辑备忘')
    await successor.getByRole('textbox', { name: '正文', exact: true }).fill('将开门声留到镜头前半拍。')
    await successor.getByRole('button', { name: '保存修改', exact: true }).click()
    const note = await poll(async () => (await query(page, first, { q: '后继剪辑备忘' })).nodes[0], 'successor note not persisted')
    const references = await query(page, first)
    assert.ok(references.edges.some(edge => edge.source === revised.id && edge.target === note.id))

    await panel(page).getByRole('button', { name: '整理节点', exact: true }).click()
    await fit(page)
    await dragNode(page, revised.id)
    assert.equal((await query(page, first, { id: revised.id })).nodes[0].content.description, revised.content.description)

    const { imageId, videoId } = await addExistingMedia(page, first, join(home, a.workspaceName))
    await panel(page).getByText(`${6 + Number(hasImage) + Number(hasVideo)} 个节点`, { exact: false }).first().waitFor()
    await clickBlank(page)
    await fit(page)
    if (hasImage) {
      const image = card(page, imageId).locator('img').first()
      assert.ok(await image.evaluate(async element => { await element.decode(); return element.naturalWidth > 100 }))
      await screenshot(page, '25-after-image-card.png')
      await card(page, imageId).getByRole('button', { name: '查看大图', exact: true }).click()
      await page.getByRole('dialog').last().locator('img').waitFor()
      await screenshot(page, '26-after-image-preview.png')
      await page.getByRole('button', { name: '关闭预览', exact: true }).click()
    } else console.info('MEDIA DATA BLOCKED: set DRAMA_UIUX_IMAGE to a real workspace image')
    if (hasVideo) {
      const videoCard = card(page, videoId)
      assert.equal(await videoCard.locator('video').count(), 0, 'video must not prefetch before user opens it')
      await videoCard.getByRole('button', { name: '打开视频预览', exact: true }).click()
      const video = videoCard.locator('video')
      assert.equal(await video.evaluate(element => element.paused && !element.autoplay), true)
      assert.ok(await decodeVideoFrame(video))
      assert.ok(await video.evaluate(element => element.videoWidth >= 300 && element.videoHeight >= 300))
      await screenshot(page, '27-after-video-card.png')
    } else console.info('MEDIA DATA BLOCKED: set DRAMA_UIUX_VIDEO to a real workspace MP4')
    await fit(page)
    await screenshot(page, '28-after-light.png')
    await setTheme(page, 'dark')
    await assertCanvasLayout(page)
    await screenshot(page, '29-after-dark.png')
    await resizeRightbar(page, 465)
    await fit(page)
    await assertCanvasLayout(page)
    await screenshot(page, '30-after-narrow-465.png')
    await resizeRightbar(page, 785)
    await fit(page)
    await screenshot(page, '31-after-wide-785.png')
    await sidebarMode(page, 'fullscreen').click()
    await page.locator('[data-sidebar-right-panel="fullscreen"]').waitFor()
    await assertCanvasLayout(page)
    await fit(page)
    await screenshot(page, '32-after-fullscreen.png')
    await sidebarMode(page, 'push').click()
    await ensureZoomScreenshot(url, home, a, context)

    const countBeforeAgent = (await query(page, first)).nodes.length
    const agentNoteId = randomUUID()
    const agentInput = join(home, 'agent-append.tmp')
    const agentResult = join(home, 'agent-append.result.json')
    await writeFile(agentInput, JSON.stringify({ sessionId: b.sessionId, callId: randomUUID(), args: {
      operationId: randomUUID(), nodes: [{ id: agentNoteId, type: 'note', content: {
        title: 'Agent 追加剪辑备注', text: '通过真实 Session 工具调用并由打开的画布接收。',
      } }],
    } }))
    await rename(agentInput, join(home, 'agent-append.json'))
    const toolResult = await poll(async () => {
      try { return JSON.parse(await readFile(agentResult, 'utf8')) }
      catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
    }, 'native Agent append did not return')
    assert.ok(!toolResult.isError, JSON.stringify(toolResult))
    const [agentNote] = (await query(page, first, { id: agentNoteId })).nodes
    assert.equal(agentNote.createdBySession, b.sessionId)
    await poll(() => panel(page).getByText(new RegExp(`^${countBeforeAgent + 1} 个节点`, 'u')).first().isVisible(),
      'open canvas did not receive the Agent mutation')
    await fit(page)
    await card(page, agentNoteId).waitFor()
    console.info('U3 native Agent tool append reached the open peer canvas via SSE')

    const load = origin => Array.from({ length: 50 }, (_, i) => ({
      type: 'note', episodeId: 'LOAD', sceneId: 'S01', shotId: String(i + 1),
      content: { title: `压测 ${origin} ${i + 1}`, text: '共享画布并发写入检查。' },
    }))
    await Promise.all([append(page, first, load('A')), append(observer, second, load('B'))])
    const snapshot = await query(page, first, { episodeId: 'LOAD' })
    assert.equal(snapshot.nodes.length, 100)
    assert.equal(new Set(snapshot.nodes.map(node => node.id)).size, 100)
    await panel(page).getByRole('button', { name: '筛选', exact: true }).click()
    await panel(page).getByRole('textbox', { name: '集', exact: true }).fill('LOAD')
    await page.keyboard.press('Escape')
    await panel(page).getByText(/100 个节点/u).waitFor()
    await fit(page)
    await panel(page).getByRole('button', { name: '搜索', exact: true }).click()
    const search = panel(page).getByRole('textbox', { name: '搜索节点', exact: true })
    await search.fill('压测 B 50')
    await search.press('Enter')
    await fit(page)
    await flow(page).getByText('压测 B 50', { exact: true }).waitFor()
    await panel(page).getByRole('button', { name: '整理节点', exact: true }).click()
    await fit(page)
    assert.equal(await flow(page).locator('video[autoplay]').count(), 0)
    if (hasVideo) {
      const probe = []
      const monitor = request => { if (new URL(request.url()).pathname.startsWith('/api/drama/media')) probe.push(request.url()) }
      page.on('request', monitor)
      try {
        const mediaNodes = Array.from({ length: 6 }, (_, index) => ({
          id: randomUUID(), type: 'video', episodeId: 'LOAD',
          content: { title: '并发画布视频素材 ' + (index + 1), path: 'assets/videos/local-clip.mp4' },
        }))
        await append(page, first, mediaNodes)
        await panel(page).getByRole('button', { name: '搜索', exact: true }).click()
        await search.fill('并发画布视频素材')
        await search.press('Enter')
        await fit(page)
        await panel(page).getByText(/6 个节点/u).waitFor()
        assert.equal(await flow(page).locator('video').count(), 0)
        assert.equal(probe.length, 0, 'hidden/inactive video made a media request')
        await card(page, mediaNodes[0].id).getByRole('button', { name: '打开视频预览', exact: true }).click()
        const player = card(page, mediaNodes[0].id).locator('video')
        await poll(() => player.evaluate(video => video.readyState >= 1), 'selected video metadata did not load')
        assert.equal(await flow(page).locator('video').count(), 1)
        assert.ok(probe.length, 'selected video did not use real media route')
      } finally { page.off('request', monitor) }
    }
    await assertCanvasLayout(page)
    console.info('U2/U3/U5 PASS: native inline drafts, immutable versions, successors, textarea input, actual media, theme/width/125%, 3 Sessions and 100 concurrent nodes')
  })
})

test('U3 shot filter, group and node collapse preserve saved contents', { timeout: 75_000 }, async () => {
  await withWeb(async ({ page, records }) => {
    const [record] = records
    await select(page, record)
    await open(page, record)
    const ticket = await ticketFor(page, record.sessionId)
    const [first, second] = [1, 2].map(index => ({
      id: randomUUID(), type: 'shot', episodeId: 'EP01', sceneId: 'S01', shotId: `SH0${index}`,
      content: { title: `折叠验收镜头 ${index}`, description: `镜头 ${index} 的完整正文。` },
    }))
    await append(page, ticket, [first, second])
    await panel(page).getByText(/^2 个节点/u).waitFor()
    await fit(page)
    const target = card(page, first.id)
    await target.locator('.drama-node-titlebar').click({ button: 'right' })
    await page.getByText('折叠或展开', { exact: true }).click()
    await target.locator('.drama-node-compact-content').waitFor()
    await target.locator('.drama-node-titlebar').click({ button: 'right' })
    await page.getByText('折叠或展开', { exact: true }).click()
    await target.locator('.drama-node-compact-content').waitFor({ state: 'hidden' })

    await panel(page).getByRole('button', { name: '筛选', exact: true }).click()
    await panel(page).getByRole('textbox', { name: '镜头', exact: true }).fill('SH01')
    await panel(page).getByText(/^1 个节点/u).waitFor()
    await card(page, second.id).waitFor({ state: 'hidden' })
    const group = panel(page).getByRole('checkbox', { name: 'EP01 / S01 / SH01', exact: true })
    await group.click()
    await panel(page).getByText('所选分组已折叠', { exact: true }).waitFor()
    await group.click()
    await target.waitFor()
    assert.deepEqual((await query(page, ticket, { id: first.id })).nodes[0].content, first.content)
    console.info('U3 native shot filter, group and card collapse/expand PASS')
  })
})

test('Native human CRUD follows live Workspace Agent activity', { timeout: 100_000 }, async () => {
  await withWeb(async ({ page, context, url, records, home }) => {
    const [a, b, unbound, other] = records
    await select(page, a)
    const canvasId = await open(page, a)
    const aTicket = await ticketFor(page, a.sessionId)
    const peer = await context.newPage()
    await initialize(peer, new URL(url).origin)
    await select(peer, b)
    assert.equal(await open(peer, b), canvasId)
    const bTicket = await ticketFor(peer, b.sessionId)
    const independentContext = await context.browser().newContext({
      storageState: await context.storageState(), locale: 'en-US', viewport: { width: 1680, height: 1000 },
    })
    const independent = await independentContext.newPage()
    await initialize(independent, new URL(url).origin)
    await select(independent, other)
    assert.notEqual(await open(independent, other), canvasId)
    const otherTicket = await ticketFor(independent, other.sessionId)
    await peer.bringToFront()
    await sidebarMode(peer, 'fullscreen').click()
    await peer.locator('[data-sidebar-right-panel="fullscreen"]').waitFor()

    const note = title => ({ id: randomUUID(), type: 'note', content: { title, description: title + '正文' } })
    const original = note('原位修改验收')
    const disposable = note('可以直接删除')
    const source = note('原始引用来源')
    const replacement = note('替换引用来源')
    const linked = note('引用目标')
    const unused = note('同画布未使用节点')
    const separate = note('另一工作区可编辑')
    await append(page, aTicket, [original, disposable, source, replacement, linked, unused], [{ source: source.id, target: linked.id }])
    await append(independent, otherTicket, [separate])
    const mutation = (browser, ticket, action, data) => request(browser, 'operation', {
      ticket, action, data: { operationId: randomUUID(), ...data },
    })
    const current = async (browser, ticket, id) => (await query(browser, ticket, { id })).nodes[0]
    const status = async (browser, record) => (await ok(browser, 'init', { sessionId: record.sessionId })).status
    const update = (node, description) => ({
      id: node.id, revision: node.revision, episodeId: node.episodeId, sceneId: node.sceneId, shotId: node.shotId,
      content: { ...node.content, description },
    })
    const busy = browser => panel(browser).getByRole('status').getByText('AI 工作中', { exact: true })
    const edit = async (browser, nodeId) => {
      await browser.bringToFront()
      await fit(browser)
      const target = card(browser, nodeId)
      const openForm = target.getByRole('form', { name: '编辑节点', exact: true })
      if (await openForm.isVisible()) return openForm
      await target.locator('.drama-node-titlebar').click()
      await openForm.waitFor()
      return openForm
    }
    const remove = async (browser, nodeId) => {
      await browser.bringToFront()
      await fit(browser)
      await card(browser, nodeId).locator('.drama-node-titlebar').click({ button: 'right' })
      await browser.getByRole('menuitem', { name: /^删除节点/u }).click()
      const confirmation = browser.getByRole('dialog', { name: '删除节点', exact: true })
      await confirmation.getByRole('button', { name: '确认删除', exact: true }).click()
      await confirmation.waitFor({ state: 'hidden' })
    }
    const save = form => form.getByRole('button', { name: '保存修改', exact: true })
    const body = form => form.getByRole('textbox', { name: '正文', exact: true })

    const before = await current(page, aTicket, original.id)
    assert.equal(before.revision, 1)
    const initialEdit = await edit(peer, original.id)
    await body(initialEdit).fill('Session B 保存到原节点。')
    await save(initialEdit).click()
    await initialEdit.waitFor({ state: 'hidden' })
    const edited = await current(peer, bTicket, original.id)
    assert.equal(edited.revision, 2)
    assert.equal(edited.id, original.id)
    assert.equal(edited.createdBySession, a.sessionId)
    assert.equal(edited.content.description, 'Session B 保存到原节点。')
    await page.bringToFront()
    await fit(page)
    await card(page, original.id).getByText(edited.content.description, { exact: true }).waitFor()
    assert.equal((await mutation(page, aTicket, 'update_node', update(before, '旧版本不能覆盖'))).status, 409)
    await remove(peer, disposable.id)
    assert.equal((await current(peer, bTicket, disposable.id)).deleted, true)
    assert.ok(!(await query(peer, bTicket)).nodes.some(node => node.id === disposable.id))

    // Reopen the peer canvas after the delete refresh before measuring another card.
    await peer.reload({ waitUntil: 'domcontentloaded' })
    await initialize(peer, new URL(url).origin)
    if (!(await panel(peer).isVisible())) {
      await select(peer, b)
      await open(peer, b)
    }
    const unsaved = await edit(peer, original.id)
    const draftText = 'AI 在保存前启动，这段未保存正文仍须保留。'
    await body(unsaved).fill(draftText)

    let linkTarget = await current(peer, bTicket, linked.id)
    assert.equal((await mutation(peer, bTicket, 'update_edge', {
      source: source.id, target: linked.id, newSource: replacement.id, revision: linkTarget.revision,
    })).status, 200)
    let graph = await query(peer, bTicket)
    assert.ok(graph.edges.some(edge => edge.source === replacement.id && edge.target === linked.id))
    assert.ok(!graph.edges.some(edge => edge.source === source.id && edge.target === linked.id))
    linkTarget = await current(peer, bTicket, linked.id)

    await page.bringToFront()
    await setPermission(page, true)
    assert.equal((await status(peer, b)).aiRunning, false)
    assert.equal(await nativeActivity(home, unbound, 'start'), 'running')
    assert.equal((await status(peer, b)).aiRunning, false, 'unbound Agent locked the Canvas')
    assert.equal((await status(peer, b)).autoGenerate, false)
    await nativeActivity(home, unbound, 'cancel')

    assert.equal(await nativeActivity(home, a, 'start'), 'running')
    await busy(peer).waitFor()
    assert.equal(await nativeActivity(home, a, 'query', original.id), 'running')
    assert.equal(await nativeActivity(home, a, 'query', linked.id), 'running')
    await poll(() => save(unsaved).isDisabled(), 'open draft save did not reflect native activity')
    assert.equal(await body(unsaved).inputValue(), draftText)
    assert.equal((await status(peer, b)).aiRunning, true)
    assert.equal((await status(independent, other)).aiRunning, false)
    const otherBefore = await current(independent, otherTicket, separate.id)
    assert.equal((await mutation(independent, otherTicket, 'update_node', update(otherBefore, '独立工作区照常保存。'))).status, 200)
    assert.equal((await current(independent, otherTicket, separate.id)).revision, 2)
    const unusedBefore = await current(peer, bTicket, unused.id)
    assert.equal((await mutation(peer, bTicket, 'update_node', update(unusedBefore, '同画布中未使用的节点照常保存。'))).status, 200)

    for (const [action, data] of [
      ['update_node', update(edited, '后台请求也不可覆盖')],
      ['delete_node', { id: original.id, revision: edited.revision }],
      ['update_edge', { source: replacement.id, target: linked.id, newSource: source.id, revision: linkTarget.revision }],
      ['delete_edge', { source: replacement.id, target: linked.id, revision: linkTarget.revision }],
    ]) {
      const rejected = await mutation(peer, bTicket, action, data)
      assert.equal(rejected.status, 423, action + ' escaped native activity gate: ' + JSON.stringify(rejected.body))
    }
    assert.ok((await mutation(peer, bTicket, 'append', {
      nodes: [{ ...original, content: { description: '批量覆盖也必须失败' } }],
    })).status >= 400)
    assert.equal((await current(peer, bTicket, original.id)).revision, edited.revision)

    await page.bringToFront()
    await busy(page).waitFor()
    await fit(page)
    await card(page, original.id).locator('.drama-node-titlebar').click({ button: 'right' })
    assert.ok(await page.getByRole('menuitem', { name: /^删除节点/u }).isDisabled())
    await page.keyboard.press('Escape')
    const added = await pick(page, '备注', aTicket, 'note')
    const addition = nodeEditor(page, added.id)
    await addition.getByText('名称与镜头', { exact: true }).click()
    await addition.getByRole('textbox', { name: '节点名称', exact: true }).fill('AI 工作时人工新增')
    await addition.getByRole('textbox', { name: '正文', exact: true }).fill('新增和阅读仍然可用。')
    await addition.getByRole('button', { name: '保存修改', exact: true }).click()
    await addition.waitFor({ state: 'hidden' })
    assert.equal((await query(peer, bTicket, { q: 'AI 工作时人工新增' })).nodes.length, 1)

    assert.equal(await nativeActivity(home, b, 'start'), 'running')
    assert.equal(await nativeActivity(home, b, 'query', original.id), 'running')
    await nativeActivity(home, a, 'finish')
    await poll(async () => (await nativeActivity(home, a, 'status')) === 'idle', 'native A did not finish')
    assert.equal(await nativeActivity(home, b, 'status'), 'running')
    assert.equal((await status(peer, b)).aiRunning, true)
    assert.ok(await busy(peer).isVisible())
    assert.ok(await save(unsaved).isDisabled())
    await nativeActivity(home, b, 'cancel')
    await peer.bringToFront()
    await busy(peer).waitFor({ state: 'hidden' })
    await poll(() => save(unsaved).isEnabled(), 'final Agent cancellation did not restore edit')
    assert.equal(await body(unsaved).inputValue(), draftText)
    await save(unsaved).click()
    await unsaved.waitFor({ state: 'hidden' })
    assert.equal((await current(page, aTicket, original.id)).content.description, draftText)
    assert.equal((await current(page, aTicket, original.id)).revision, 3)
    assert.equal((await status(peer, b)).aiRunning, false)

    const conflicted = await edit(peer, original.id)
    await body(conflicted).fill('版本冲突也要保留这段未保存正文。')
    const latest = await current(page, aTicket, original.id)
    assert.equal((await mutation(page, aTicket, 'update_node', update(latest, 'Session A 先保存。'))).status, 200)
    await save(conflicted).click()
    await conflicted.getByRole('alert').filter({ hasText: /画布内容已变化/u }).waitFor()
    assert.equal(await body(conflicted).inputValue(), '版本冲突也要保留这段未保存正文。')
    assert.equal((await current(page, aTicket, original.id)).content.description, 'Session A 先保存。')
    await conflicted.getByRole('button', { name: '取消', exact: true }).click()
    await conflicted.waitFor({ state: 'hidden' })

    await remove(peer, replacement.id)
    assert.equal((await current(peer, bTicket, replacement.id)).deleted, true)
    graph = await query(peer, bTicket)
    assert.ok(!graph.nodes.some(node => node.id === replacement.id))
    assert.ok(graph.nodes.some(node => node.id === linked.id))
    assert.ok(!graph.edges.some(edge => edge.source === replacement.id && edge.target === linked.id))
    console.info('Human edits PASS: same-ID UI save/delete, revisions, edge replacement/delete, native overlapping Agent turns, backend 423, add while busy, draft preservation, workspace isolation and cancellation')
  })
})

test('Native UI changes and deletes a saved edge', { timeout: 65_000 }, async () => {
  await withWeb(async ({ page, records }) => {
    const [record] = records
    await select(page, record)
    await open(page, record)
    const ticket = await ticketFor(page, record.sessionId)
    const note = title => ({ id: randomUUID(), type: 'note', content: { title, description: title + '正文' } })
    const source = note('原始来源')
    const next = note('新来源')
    const target = note('连线目标')
    await append(page, ticket, [source, next, target], [{ source: source.id, target: target.id }])
    await flow(page).getByText('3 个节点', { exact: true }).waitFor()
    await flow(page).getByRole('button', { name: '适配视图', exact: true }).click()
    await page.bringToFront()
    await delay(220)
    const edge = id => graphEdge(page, id, target.id)
    const from = edge(source.id).locator('circle.react-flow__edgeupdater-source')
    const to = card(page, next.id).locator('.drama-port-output')
    const point = await from.evaluate(el => {
      const rect = el.getBoundingClientRect()
      for (let i = 0; i <= 6; i++) {
        for (let j = 0; j <= 6; j++) {
          const x = rect.left + rect.width * (i + 1) / 8
          const y = rect.top + rect.height * (j + 1) / 8
          if (document.elementFromPoint(x, y) === el) return { x, y }
        }
      }
      return null
    })
    assert.ok(point, 'native edge source anchor was not clickable')
    const toRect = await to.boundingBox()
    await page.mouse.move(point.x, point.y)
    await page.mouse.down()
    await page.mouse.move(toRect.x + toRect.width / 2, toRect.y + toRect.height / 2, { steps: 20 })
    await page.mouse.up()
    await poll(async () => (await query(page, ticket)).edges.some(e => e.source === next.id && e.target === target.id),
      'dragging the saved edge endpoint did not replace its source')
    await edge(next.id).waitFor()
    const path = edge(next.id).locator('.react-flow__edge-interaction')
    const hit = await path.evaluate(el => {
      const length = el.getTotalLength()
      for (const fraction of [.5, .25, .75, .4, .6]) {
        const point = el.getPointAtLength(length * fraction).matrixTransform(el.getScreenCTM())
        if (document.elementFromPoint(point.x, point.y) === el) return { x: point.x, y: point.y }
      }
      return null
    })
    assert.ok(hit, 'saved edge was not clickable')
    await page.mouse.click(hit.x, hit.y, { button: 'right' })
    await page.getByRole('menuitem', { name: '删除连线', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '删除连线', exact: true })
    await dialog.getByRole('button', { name: '确认删除', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    assert.equal((await query(page, ticket)).edges.length, 0)
    assert.equal((await query(page, ticket, { id: target.id })).nodes[0].revision, 3)
    console.info('Native reconnect pointer and delete confirmation exercised the saved graph')
  })
})

test('Native deletion preserves source content and removes its live references', { timeout: 65_000 }, async () => {
  await withWeb(async ({ page, records, home }) => {
    const [record] = records
    await select(page, record)
    await open(page, record)
    const ticket = await ticketFor(page, record.sessionId)
    const source = { id: randomUUID(), type: 'note', content: { title: '待删除来源', description: '来源内容仍可读取。' } }
    const target = { id: randomUUID(), type: 'note', content: { title: '引用目标', description: '目标内容。' } }
    await append(page, ticket, [source, target], [{ source: source.id, target: target.id }])
    assert.equal(await nativeActivity(home, record, 'start'), 'running')
    assert.equal(await nativeActivity(home, record, 'query', target.id), 'running')
    await panel(page).getByText('AI 工作中', { exact: true }).waitFor()
    const blocked = await request(page, 'operation', { ticket, action: 'delete_node',
      data: { operationId: randomUUID(), id: source.id, revision: 1 } })
    assert.equal(blocked.status, 423)
    await nativeActivity(home, record, 'cancel')
    await panel(page).getByText('AI 工作中', { exact: true }).waitFor({ state: 'hidden' })
    await fit(page)
    await card(page, source.id).locator('.drama-node-titlebar').click()
    await page.keyboard.press('Delete')
    await poll(async () => (await query(page, ticket, { id: source.id })).nodes[0].deleted, 'idle source deletion did not persist')
    const active = await query(page, ticket)
    assert.ok(!active.nodes.some(node => node.id === source.id))
    assert.ok(!active.edges.some(edge => edge.source === source.id && edge.target === target.id))
    await flow(page).getByText('1 个节点', { exact: true }).waitFor()
    const [archived] = (await query(page, ticket, { id: source.id })).nodes
    assert.equal(archived.deleted, true)
    assert.deepEqual(archived.content, source.content)
    console.info('Native Agent use protected source deletion until idle; deletion removed the active edge and kept source content')
  })
})

test('U4 native task drawer follows real Go worker in isolated provider fixture', { timeout: 150_000, skip: !hasVideo }, async () => {
  await withWeb(async ({ page, records, home }) => {
    const [a] = records
    const settings = (action, data) => ok(page, 'providers', { action, data })
    const configured = await settings('channel_save', {
      channel: { name: '本地验收渠道', protocol: 'openai-video', baseUrl: 'https://video.example.com' },
      apiKey: 'uiux-local-fixture-token',
    })
    const models = await settings('provider_save', {
      revision: configured.revision,
      profile: {
        name: '本地验收夹具', channelId: configured.channels[0].id, model: 'fixture-video', modes: ['t2v'],
        defaults: { duration: 4 }, limits: { durationMin: 1, durationMax: 12 },
      },
    })
    await settings('generation_save', {
      revision: models.revision,
      generation: { defaultModelId: models.profiles[0].id, maxConcurrent: 2, outputDirectory: 'assets/native-results' },
    })
    await select(page, a)
    await open(page, a)
    const ticket = await ticketFor(page, a.sessionId)
    const created = await pick(page, '视频生成', ticket, 'video')
    await chooseVideoMode(page, ticket, created.id, 't2v')
    await editDetails(page, created.id, { 节点名称: '排队与结果定位验收', 集: 'EP01', 场: 'S01', 镜头: 'SH08' })
    await updateVideo(page, ticket, created.id, '固定中景。人物推开餐厅门，在门口停顿。')
    const parameterChips = nodeEditor(page, created.id).getByRole('group', { name: '有效生成参数', exact: true })
    await parameterChips.getByRole('button', { name: '时长（秒）', exact: true }).waitFor()
    assert.deepEqual(await parameterChips.getByRole('button').allTextContents(), ['4 秒'],
      'unsupported parameters should not appear alongside the duration-only profile')
    const durationPopup = await chooseDuration(page, created.id, 1)
    const continuousSlider = durationPopup.getByRole('slider', { name: '滑动调整时长', exact: true })
    await poll(async () => (await query(page, ticket, { id: created.id })).nodes[0].content.params?.duration === 1,
      'a valid 1 second override did not save on a continuous model')
    assert.equal(await continuousSlider.inputValue(), '1')
    assert.equal(await continuousSlider.getAttribute('min'), '1')
    assert.equal(await continuousSlider.getAttribute('max'), '12')
    await durationPopup.getByRole('button', { name: '恢复默认', exact: true }).click()
    await poll(async () => {
      const node = (await query(page, ticket, { id: created.id })).nodes[0]
      return node && node.content.params?.duration === undefined
    }, 'restoring default did not clear the duration override')
    assert.equal(await continuousSlider.inputValue(), '4')
    const durationInput = durationPopup.getByRole('spinbutton', { name: '时长（秒）', exact: true })
    await durationInput.fill('8')
    await durationInput.press('Enter')
    await page.keyboard.press('Escape')
    await durationPopup.waitFor({ state: 'hidden' })
    const node = await poll(async () => {
      const [current] = (await query(page, ticket, { id: created.id })).nodes
      return current?.content.params?.duration === 8 && current
    }, 'duration override on a new video node did not save')
    assert.equal(node.content.params.duration, 8)
    assert.deepEqual(node.content.mixedListOrder ?? [], [])
    assert.equal(node.content.textList, undefined)
    const nodeId = node.id
    const source = card(page, nodeId)
    await source.locator('.drama-node-titlebar').click()
    await source.getByRole('button', { name: '生成…', exact: true }).click()
    const confirm = page.getByRole('dialog', { name: '确认生成', exact: true })
    const submit = confirm.getByRole('button', { name: '确认提交', exact: true })
    await submit.click()
    const running = await poll(async () => {
      const { tasks } = await operate(page, ticket, 'tasks', {})
      return tasks.find(task => task.nodeId === nodeId && task.status === 'processing' && task.phase === 'polling')
    }, 'actual task did not reach polling')
    assert.equal(running.providerTaskId, 'uiux-fixture-task')
    await source.getByText('生成中', { exact: true }).first().waitFor()
    const drawer = page.getByRole('region', { name: '生成任务', exact: true })
    assert.equal(await drawer.count(), 0)
    await panel(page).getByRole('button', { name: '任务', exact: true }).click()
    await drawer.getByRole('button', { name: '定位节点', exact: true }).click()
    if (!(await drawer.isVisible())) await panel(page).getByRole('button', { name: '任务', exact: true }).click()
    await drawer.getByText('排队与结果定位验收', { exact: true }).waitFor()
    await screenshot(page, '40-after-task-polling-fixture.png')
    await drawer.getByRole('button', { name: '收起任务', exact: true }).click()
    await drawer.waitFor({ state: 'hidden' })
    await page.locator('[data-sidebar-right-toggle]').first().click()
    await panel(page).waitFor({ state: 'hidden' })
    assert.equal((await ok(page, 'init', { sessionId: a.sessionId })).status.aiRunning, false)
    const pendingEdit = {
      operationId: randomUUID(), id: nodeId, revision: node.revision,
      episodeId: 'EP09', sceneId: 'S09', shotId: 'SH99',
      content: { ...node.content, prompt: '修改原节点的完整视频提示词，已提交任务使用先前的快照。' },
    }
    const blocked = await request(page, 'operation', { ticket, action: 'update_node', data: pendingEdit })
    assert.equal(blocked.status, 423)
    const [unchanged] = (await query(page, ticket, { id: nodeId })).nodes
    assert.equal(unchanged.revision, node.revision)
    await writeFile(join(home, 'allow-fixture-result'), '')
    const completed = await poll(async () => {
      const { tasks } = await operate(page, ticket, 'tasks', {})
      return tasks.find(task => task.id === running.id && task.status === 'completed')
    }, 'Go worker did not finish while the native panel was closed', 20_000)
    assert.ok(completed.resultNodeId)
    const [result] = (await query(page, ticket, { id: completed.resultNodeId })).nodes
    assert.equal(result.basedOn, nodeId)
    assert.deepEqual([result.episodeId, result.sceneId, result.shotId], ['EP01', 'S01', 'SH08'])
    assert.ok(completed.completedAt)
    assert.match(completed.outputPath, /^assets\/native-results\/[^/]+\.mp4$/u)
    assert.equal(result.content.path, completed.outputPath)
    assert.equal((await settings('provider_settings', {})).profiles[0].defaults.duration, 4)
    await poll(async () => {
      const current = (await settings('provider_settings', {})).channels
        .find(channel => channel.id === configured.channels[0].id)
      return current?.verification?.modelCallable === 'verified' &&
        current.verification.taskSucceeded === 'verified'
    }, 'completed video did not verify the channel and model')
    await open(page, a)
    await panel(page).getByRole('button', { name: '任务', exact: true }).click()
    await drawer.getByText('完成', { exact: true }).waitFor()
    await drawer.getByRole('button', { name: '查看结果', exact: true }).click()
    const resultCard = card(page, completed.resultNodeId)
    const player = resultCard.locator('video')
    await player.waitFor()
    assert.ok(await decodeVideoFrame(player))
    assert.ok(await player.evaluate(video => video.videoWidth > 0))
    await operate(page, ticket, 'update_node', { ...pendingEdit, operationId: randomUUID() })
    const [editedSource] = (await query(page, ticket, { id: nodeId })).nodes
    assert.equal(editedSource.revision, node.revision + 1)
    const [preserved] = (await query(page, ticket, { id: completed.resultNodeId })).nodes
    assert.equal(preserved.content.path, completed.outputPath)
    await screenshot(page, '41-after-task-result-fixture.png')
    console.info('U4 persisted queue PASS: polling protected the task source; editing resumed afterward and preserved result lineage and playback')
  }, { providerFixture: true })
})

test('U5 native video editors retain ordered media and inline prompts', { timeout: 100_000 }, async () => {
  await withWeb(async ({ page, records }) => {
    const [record] = records
    const settings = (action, data) => ok(page, 'providers', { action, data })
    const configured = await settings('channel_save', { channel: {
      name: '媒体模式夹具', protocol: 'custom-rest', baseUrl: 'https://video.example.com',
      advanced: {
        submitUrl: '/jobs', submitMethod: 'POST', auth: 'none',
        fields: { firstFrame: 'first_frame', lastFrame: 'last_frame', references: 'references', sourceVideo: 'source_video' },
        taskIdPath: 'id', queryUrl: '/jobs/{taskId}', statusPath: 'status',
        statusMap: { running: 'processing', done: 'completed', error: 'failed' }, outputUrlPath: 'url',
      },
    } })
    await settings('provider_save', {
      revision: configured.revision,
      profile: {
        name: '四种模式夹具', channelId: configured.channels[0].id, model: 'fixture-modes',
        modes: ['t2v', 'i2v', 'r2v', 'v2v'], limits: { lastFrame: true, references: { image: 1, video: 1, audio: 1 } },
      },
    })
    await select(page, record)
    await open(page, record)
    const ticket = await ticketFor(page, record.sessionId)
    const source = (type, title, path) => ({ id: randomUUID(), type, content: { title, path } })
    const head = source('image', '夹具首帧', 'assets/images/head.png')
    const tail = source('image', '夹具尾帧', 'assets/images/tail.png')
    const video = source('video', '夹具源视频', 'assets/videos/source.mp4')
    const audio = source('audio', '夹具参考音频', 'assets/audio/reference.wav')
    await append(page, ticket, [head, tail, video, audio])
    const cases = [
      ['i2v', '首尾帧验收', '保留 @图片1 的初始构图并自然过渡到 @图片2。', '添加图片素材', [head, tail]],
      ['r2v', '多媒体参考验收', '根据 @图片1 定造型，沿用 @视频1 动作，参考 @音频1 节奏。', '添加参考素材', [head, video, audio]],
      ['v2v', '源视频验收', '保留 @视频1 的表演节奏，调整画面亮度。', '添加视频素材', [video]],
    ]
    for (const [mode, title, prompt, picker, references] of cases) {
      const created = await pick(page, '视频生成', ticket, 'video')
      await chooseVideoMode(page, ticket, created.id, mode)
      await editDetails(page, created.id, { 节点名称: title })
      await updateVideo(page, ticket, created.id, prompt)
      const editor = nodeEditor(page, created.id)
      for (const [index, ref] of references.entries()) {
        const slot = mode === 'i2v' ? index === 0 ? '添加首帧' : '添加尾帧'
          : mode === 'v2v' ? '添加源视频' : '添加参考素材'
        await editor.getByRole('button', { name: slot, exact: true }).click()
        await page.getByRole('dialog', { name: '添加参考素材', exact: true })
          .getByRole('button', { name: picker, exact: true }).click()
        await page.getByRole('menuitem').filter({ hasText: ref.content.title }).click()
      }
      await poll(async () => {
        const [node] = (await query(page, ticket, { id: created.id })).nodes
        return node?.content.mixedListOrder?.length === references.length
      }, 'references were not persisted on the new ' + mode + ' video')
      const { nodes, edges } = await query(page, ticket)
      const node = nodes.find(item => item.id === created.id)
      assert.equal(node.content.title, title)
      assert.equal(node.content.mode, mode)
      assert.equal(node.content.prompt, prompt)
      assert.equal(node.content.textList, undefined)
      assert.deepEqual(node.content.mixedListOrder, references.map(ref => ref.id))
      assert.deepEqual(new Set(edges.filter(edge => edge.target === node.id).map(edge => edge.source)),
        new Set(node.content.mixedListOrder))
    }
    assert.equal((await operate(page, ticket, 'tasks', {})).tasks.length, 0)
    console.info('U5 native video editors PASS: I2V first/tail, ordered R2V image/video/audio, V2V source, inline prompts and no generation')
  })
})

test('Canvas claims real file drags before the native composer', { timeout: 65_000, skip: !hasImage }, async () => {
  await withWeb(async ({ page, context, records, home }) => {
    const [record] = records
    await select(page, record)
    await open(page, record)
    await sidebarMode(page, 'fullscreen').click()
    const pane = flow(page).locator('.react-flow__pane')
    const bounds = await pane.boundingBox()
    const point = { x: Math.round(bounds.x + bounds.width * .45), y: Math.round(bounds.y + bounds.height * .35) }
    await page.evaluate(({ x, y }) => {
      if (!document.elementFromPoint(x, y)?.classList.contains('react-flow__pane')) {
        throw new Error('Drop point is outside the blank canvas')
      }
      window.dramaFileDrag = { bubbled: [] }
      for (const type of ['dragover', 'drop']) {
        document.addEventListener(type, () => window.dramaFileDrag.bubbled.push(type), { once: true })
      }
      window.addEventListener('dragover', event => {
        setTimeout(() => {
          window.dramaFileDrag.over = [event.isTrusted, event.defaultPrevented, event.dataTransfer.dropEffect]
        }, 0)
      }, { capture: true, once: true })
    }, point)
    const cdp = await context.newCDPSession(page)
    const data = { items: [], files: [resolve(imageAsset)], dragOperationsMask: 1 }
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      await cdp.send('Input.dispatchDragEvent', { type, ...point, data })
    }
    await cdp.detach()
    await page.waitForFunction(() => window.dramaFileDrag.over)
    assert.deepEqual(await page.evaluate(() => window.dramaFileDrag), { bubbled: [], over: [true, true, 'copy'] })
    const ticket = await ticketFor(page, record.sessionId)
    const node = await poll(async () => (await query(page, ticket)).nodes.find(item => item.content.assetId),
      'Dropping a real PNG did not save an asset node')
    assert.equal(node.type, 'image')
    assert.equal(node.content.path, 'assets/images/' + node.content.assetId)
    assert.ok(Number.isFinite(node.content.canvasPosition?.x) && Number.isFinite(node.content.canvasPosition?.y))
    const original = await readFile(imageAsset)
    assert.deepEqual(await readFile(join(home, record.workspaceName, node.content.path)), original)
    assert.equal(node.content.url, undefined)
    await card(page, node.id).locator('img').first().evaluate(image => image.decode())
  })
})

test('Native canvas uploads media and sends the connected PNG to the configured video endpoint', {
  timeout: 125_000, skip: !hasImage || !hasVideo || !existsSync(projectImageAsset),
}, async () => {
  const profileName = '回环首帧预设 · 长模型名称也保留参数与设置按钮'
  const received = []
  const endpoint = createHTTPServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    received.push({ method: req.method, url: req.url, data: Buffer.concat(chunks) })
    // The test captures the production request without returning a synthetic result.
    res.writeHead(422, { 'Content-Type': 'application/json' }).end('{"error":"Local request capture"}')
  })
  await new Promise((resolve, reject) => endpoint.once('error', reject).listen(0, '127.0.0.1', resolve))
  try {
    await withWeb(async ({ page, records, home }) => {
      const [record] = records
      const settings = (action, data) => ok(page, 'providers', { action, data })
      const configured = await settings('channel_save', { channel: {
        name: '回环请求验收', protocol: 'custom-rest', baseUrl: 'http://127.0.0.1:' + endpoint.address().port,
        advanced: {
          submitUrl: '/jobs', submitMethod: 'POST', auth: 'none',
          fields: { firstFrame: 'input.first_frame', duration: 'input.duration', resolution: 'input.resolution',
            aspectRatio: 'input.aspect_ratio', generateAudio: 'input.generate_audio' },
          taskIdPath: 'id', queryUrl: '/jobs/{taskId}', statusPath: 'status',
          statusMap: { done: 'completed', error: 'failed' }, outputUrlPath: 'url',
        },
      } })
      const saved = await settings('provider_save', {
        revision: configured.revision,
        profile: {
          name: profileName, channelId: configured.channels[0].id, model: 'capture-i2v',
          modes: ['i2v'], defaults: { duration: 4, resolution: '720p', aspectRatio: '16:9', generateAudio: true },
          limits: { durations: [4, 8, 10], resolutions: ['720p', '1080p'], aspectRatios: ['16:9', '9:16'], generateAudio: true },
        },
      })
      const profileId = saved.profiles[0].id
      await select(page, record)
      await open(page, record)
      await sidebarMode(page, 'fullscreen').click()
      let ticket = await ticketFor(page, record.sessionId)

      const png = await readFile(imageAsset)
      const drop = await page.evaluateHandle(({ filename, data }) => {
        const transfer = new DataTransfer()
        transfer.items.add(new File([Uint8Array.from(atob(data), byte => byte.charCodeAt(0))], filename, { type: 'image/png' }))
        return transfer
      }, { filename: basename(imageAsset), data: png.toString('base64') })
      const pane = flow(page).locator('.react-flow__pane')
      const bounds = await pane.boundingBox()
      await pane.dispatchEvent('drop', { dataTransfer: drop,
        clientX: bounds.x + bounds.width * .45, clientY: bounds.y + bounds.height * .35 })
      await drop.dispose()
      const image = await poll(async () => (await query(page, ticket, { type: 'image' })).nodes.find(node => node.content.path),
        'dropping the real PNG did not create a persistent image')
      await card(page, image.id).locator('img').first().evaluate(async element => {
        await element.decode()
        if (!element.naturalWidth || !element.naturalHeight) throw new Error('Uploaded image did not decode')
      })

      const emptyImage = await pick(page, '图片', ticket, 'image')
      const uploadImage = page.waitForEvent('filechooser')
      await card(page, emptyImage.id).getByRole('button', { name: '上传图片', exact: true }).click()
      await (await uploadImage).setFiles(projectImageAsset)
      await poll(async () => (await query(page, ticket, { id: emptyImage.id })).nodes[0].content.path,
        'image node upload did not save the asset')
      await card(page, emptyImage.id).locator('img').first().evaluate(element => element.decode())
      await card(page, emptyImage.id).locator('.drama-node-titlebar').click()
      const imageEditor = card(page, emptyImage.id).getByRole('form', { name: '编辑节点', exact: true })
      await imageEditor.getByRole('textbox', { name: '提示词', exact: true }).fill('保持原图构图，使用自然的室内光。')
      await clickBlank(page)
      await poll(async () => {
        const [node] = (await query(page, ticket, { id: emptyImage.id })).nodes
        return node.content.path && node.content.prompt === '保持原图构图，使用自然的室内光。'
      }, 'image prompt did not autosave without replacing the uploaded image')

      const clip = await pick(page, '视频素材', ticket, 'video')
      const clipUpload = card(page, clip.id).getByRole('button', { name: '上传视频', exact: true })
      const chooser = page.waitForEvent('filechooser')
      await clipUpload.click()
      await (await chooser).setFiles(videoAsset)
      await poll(async () => (await query(page, ticket, { id: clip.id })).nodes[0].content.path,
        'uploading a real MP4 did not update the video asset node')
      await fit(page)
      await card(page, clip.id).locator('.drama-node-titlebar').click()
      const player = card(page, clip.id).locator('video')
      assert.ok(await decodeVideoFrame(player))
      await player.dblclick({ position: { x: 20, y: 18 } })
      assert.equal(await page.evaluate(() => Boolean(document.fullscreenElement)), false)
      assert.equal(await flow(page).getAttribute('data-focused-node'), null)
      assert.equal(await page.getByRole('dialog').count(), 0)
      await player.evaluate(element => element.pause())

      const prompt = '以 @图片1 为首帧，保留小鸭轮廓。固定中景，停顿半秒后渐亮，保留室内环境声。'
      const formFor = node => card(page, node.id).getByRole('form', { name: '编辑节点', exact: true })
      async function newVideo(title, mode = 't2v') {
        const video = await pick(page, '视频生成', ticket, 'video')
        await chooseVideoMode(page, ticket, video.id, mode)
        await editDetails(page, video.id, { 节点名称: title })
        await updateVideo(page, ticket, video.id, prompt.replace('以 @图片1 为首帧，', ''))
        return (await query(page, ticket, { id: video.id })).nodes[0]
      }
      const first = await newVideo('首帧连接验收甲')
      const second = await newVideo('首帧连接验收乙')
      await clickBlank(page)
      const edge = target => graphEdge(page, image.id, target.id)
      for (const target of [first, second]) {
        await clickBlank(page)
        await dragReference(page, image.id, target.id)
        await poll(async () => (await query(page, ticket)).edges.some(item => item.source === image.id && item.target === target.id),
          'canvas drag did not save the image reference for ' + target.content.title)
        await edge(target).waitFor()
      }

      const firstBox = card(page, first.id).locator('.drama-node-titlebar')
      const nodeGeometry = node => card(page, node.id).evaluate(element => {
        const handle = selector => {
          const handle = element.querySelector(selector)
          const style = getComputedStyle(handle)
          return [handle.offsetLeft, handle.offsetTop, style.transform]
        }
        return {
          transform: element.closest('.react-flow__node').style.transform,
          input: handle('.drama-port-input'), output: handle('.drama-port-output'),
        }
      })
      await clickBlank(page)
      await fit(page)
      const before = await nodeGeometry(first)
      await firstBox.click()
      const editor = formFor(first)
      await editor.waitFor()
      assert.deepEqual(await nodeGeometry(first), before, 'opening the editor moved the node or its handles')
      const editorGeometry = await editor.evaluate(element => {
        const box = element.getBoundingClientRect()
        const node = element.closest('article')
        const cardBox = node.getBoundingClientRect()
        const canvas = element.closest('.drama-flow').getBoundingClientRect()
        const prompt = element.querySelector('textarea[name="prompt"]')
        return { height: element.offsetHeight, width: element.offsetWidth, nodeWidth: node.offsetWidth,
          top: box.top, bottom: box.bottom, cardBottom: cardBox.bottom, canvasBottom: canvas.bottom,
          centerOffset: Math.abs(box.left + box.width / 2 - cardBox.left - cardBox.width / 2),
          leftMargin: box.left - canvas.left, rightMargin: canvas.right - box.right,
          promptWidth: prompt.offsetWidth, promptRowWidth: prompt.parentElement.clientWidth,
          scrolling: [element, ...element.querySelectorAll('div, fieldset')].some(candidate =>
            candidate.clientHeight > 0 && candidate.scrollHeight > candidate.clientHeight + 1 &&
            /^(auto|scroll)$/u.test(getComputedStyle(candidate).overflowY)) }
      })
      assert.ok(editorGeometry.height >= 160 && editorGeometry.height <= 270, JSON.stringify(editorGeometry))
      assert.ok(Math.abs(editorGeometry.width - 480) <= 4 && editorGeometry.width > editorGeometry.nodeWidth * 1.4,
        JSON.stringify(editorGeometry))
      assert.ok(editorGeometry.centerOffset <= 2, 'the wide editor is not centered under its card')
      assert.ok(editorGeometry.leftMargin >= 0 && editorGeometry.rightMargin >= 0, 'the wide editor is horizontally clipped')
      assert.equal(editorGeometry.promptWidth, editorGeometry.promptRowWidth, 'the prompt does not fill its available width')
      assert.ok(editorGeometry.top >= editorGeometry.cardBottom, 'editor did not open below the node card')
      assert.ok(editorGeometry.bottom <= editorGeometry.canvasBottom, 'the lower panel is clipped by the canvas')
      assert.equal(editorGeometry.scrolling, false, 'the compact editor has a vertical scrollbar')
      assert.equal(await editor.getByRole('button', { name: '保存修改', exact: true }).count(), 0)
      assert.equal(await editor.getByRole('button', { name: '取消', exact: true }).count(), 0)
      assert.equal(await editor.getByRole('textbox', { name: /搜索/u }).count(), 0)
      const modelButton = editor.getByRole('button', { name: '生成预设', exact: true })
      const generateButton = editor.getByRole('button', { name: '生成…', exact: true })
      const parameterButtons = form => form.getByRole('group', { name: '有效生成参数', exact: true }).getByRole('button')
      const toolbarBoxes = async form => {
        const controls = [
          ...['视频方式', '生成预设', '节点详情'].map(name => form.getByRole('button', { name, exact: true })),
          ...await parameterButtons(form).all(),
        ]
        const boxes = await Promise.all(controls.map(control => control.boundingBox()))
        assert.ok(boxes.every(Boolean), 'every toolbar control must be visible')
        return boxes
      }
      assert.deepEqual(await parameterButtons(editor).allTextContents(), ['4 秒', '720p', '16:9', '音频开'])
      const controlLine = await toolbarBoxes(editor)
      const centers = controlLine.map(box => box.y + box.height / 2)
      assert.ok(Math.max(...centers) - Math.min(...centers) < 4,
        'video mode, model, parameters, and node details should share one row at regular width')
      assert.ok(await modelButton.getByText('默认 · ' + profileName, { exact: true }).evaluate(label =>
        label.scrollWidth > label.clientWidth && getComputedStyle(label).textOverflow === 'ellipsis'),
      'the long model name should truncate to leave room for the parameters')
      assert.ok((await generateButton.boundingBox()).y > centers[0], 'generation action did not follow the compact controls')
      await editor.getByRole('button', { name: '节点详情', exact: true }).click()
      const details = page.getByRole('dialog', { name: '节点详情', exact: true })
      await details.getByRole('button', { name: '关闭节点详情', exact: true }).click()
      const thumbnail = editor.getByRole('button', { name: /^首帧 · /u }).locator('img')
      await thumbnail.evaluate(async image => {
        await image.decode()
        if (!image.naturalWidth) throw new Error('The connected first-frame thumbnail did not decode')
      })
      await flow(page).focus()
      await page.keyboard.press('.')
      await delay(240)
      const zoomedGeometry = await nodeGeometry(first)
      await screenshot(page, 'compact-editor-light.png')
      await setTheme(page, 'dark')
      await screenshot(page, 'compact-editor-dark.png')
      await setTheme(page, 'light')
      const promptBox = editor.getByRole('textbox', { name: '提示词', exact: true })
      const promptHeight = await promptBox.evaluate(element => {
        const style = getComputedStyle(element)
        return element.clientHeight / Number.parseFloat(style.lineHeight)
      })
      assert.ok(promptHeight >= 2 && promptHeight <= 4, 'the prompt editor did not open at its compact height')
      const longPrompt = Array.from({ length: 100 }, (_, index) => String(index + 1) + ' ' + prompt).join('\n')
      const collapsedHeight = await promptBox.evaluate(element => element.offsetHeight)
      await editor.getByRole('button', { name: '展开提示词', exact: true }).click()
      const promptDialog = page.getByRole('dialog', { name: '编辑提示词', exact: true })
      const expandedPrompt = promptDialog.getByRole('textbox', { name: '提示词', exact: true })
      await expandedPrompt.waitFor()
      assert.ok(await expandedPrompt.evaluate(element => element.offsetHeight) > collapsedHeight,
        'the full prompt dialog did not provide a larger editing surface')
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
      await page.evaluate(text => navigator.clipboard.writeText(text), longPrompt)
      await expandedPrompt.press('Control+a')
      await expandedPrompt.press('Control+v')
      assert.equal(await expandedPrompt.inputValue(), longPrompt)
      assert.ok(await expandedPrompt.evaluate(element => element.scrollHeight > element.clientHeight),
        'the 100-line prompt could not scroll inside the editor')
      await expandedPrompt.evaluate(element => { element.scrollTop = 0 })
      await expandedPrompt.hover()
      await page.mouse.wheel(0, 480)
      await poll(() => expandedPrompt.evaluate(element => element.scrollTop > 0), 'the prompt dialog did not scroll')
      await screenshot(page, 'expanded-prompt-editor.png')
      await page.keyboard.press('Escape')
      await promptDialog.waitFor({ state: 'hidden' })
      assert.equal(await promptBox.evaluate(element => element.offsetHeight), collapsedHeight)
      assert.equal(await promptBox.inputValue(), longPrompt)
      await poll(async () => (await query(page, ticket, { id: first.id })).nodes[0].content.prompt === longPrompt,
        'closing the full prompt dialog lost the long edit')
      assert.deepEqual(await nodeGeometry(first), zoomedGeometry, 'the prompt dialog moved the node or its handles')
      await editor.getByRole('button', { name: '展开提示词', exact: true }).click()
      await expandedPrompt.fill(prompt)
      await poll(async () => (await query(page, ticket, { id: first.id })).nodes[0].content.prompt === prompt,
        'changing the expanded prompt did not autosave')
      await expandedPrompt.press('End')
      const inputSession = await page.context().newCDPSession(page)
      try {
        // Chromium dispatches the same composition/input events used by the OS input method.
        await inputSession.send('Input.imeSetComposition', { text: '草', selectionStart: 1, selectionEnd: 1 })
        assert.equal(await expandedPrompt.inputValue(), prompt + '草')
        await delay(550)
        assert.equal((await query(page, ticket, { id: first.id })).nodes[0].content.prompt, prompt,
          'an uncommitted IME composition leaked into the saved prompt')
        await inputSession.send('Input.insertText', { text: '。' })
        await poll(async () => (await query(page, ticket, { id: first.id })).nodes[0].content.prompt === prompt + '。',
          'the committed IME composition did not save')
      } finally {
        await inputSession.detach()
      }
      await promptDialog.getByRole('button', { name: '完成编辑', exact: true }).click()
      await promptDialog.waitFor({ state: 'hidden' })
      await promptBox.press('End')
      await promptBox.press('Backspace')
      assert.equal(await promptBox.inputValue(), prompt)
      assert.ok(!(await query(page, ticket, { id: first.id })).nodes[0].deleted)
      await modelButton.click()
      await page.getByRole('menuitem', { name: profileName, exact: true }).click()
      const viewport = flow(page).locator('.react-flow__viewport')
      const readViewport = () => viewport.evaluate(element => element.style.transform)
      await fit(page)
      const originalViewport = await readViewport()
      const beforeFocus = await nodeGeometry(first)
      await focusNode(page, first.id)
      const exitFocus = page.getByRole('button', { name: '退出聚焦', exact: true })
      await exitFocus.waitFor()
      assert.equal(await flow(page).getAttribute('data-focused-node'), first.id)
      await poll(async () => (await readViewport()) !== originalViewport, 'focus mode did not center the selected node')
      const focusedGeometry = await nodeGeometry(first)
      assert.deepEqual(focusedGeometry, beforeFocus, 'focus mode moved the node or its handles')
      const duration = editor.getByRole('button', { name: '时长（秒）', exact: true })
      await duration.click()
      const parameterPopover = page.getByRole('dialog', { name: '时长（秒）', exact: true })
      await parameterPopover.waitFor()
      const resolution = editor.getByRole('button', { name: '分辨率', exact: true })
      await resolution.click()
      const resolutionPopover = page.getByRole('dialog', { name: '分辨率', exact: true })
      await resolutionPopover.waitFor()
      await parameterPopover.waitFor({ state: 'hidden' })
      const currentResolution = resolutionPopover.getByRole('button', { name: '默认 · 720p', exact: true })
      const nextResolution = resolutionPopover.getByRole('button', { name: '1080p', exact: true })
      assert.equal(await currentResolution.getAttribute('aria-pressed'), 'true')
      await screenshot(page, 'focus-mode-resolution-popup.png')
      await nextResolution.click()
      if (await resolutionPopover.isVisible()) assert.equal(await nextResolution.getAttribute('aria-pressed'), 'true')
      await duration.click()
      await resolutionPopover.waitFor({ state: 'hidden' })
      const [chipBounds, popupBounds] = await Promise.all([duration.boundingBox(), parameterPopover.boundingBox()])
      assert.ok(chipBounds && popupBounds && Math.abs(chipBounds.x - popupBounds.x) < 250 &&
        Math.abs(chipBounds.y - popupBounds.y) < 180, 'duration popup did not open near its control')
      const durationInput = parameterPopover.getByRole('spinbutton', { name: '时长（秒）', exact: true })
      const durationSlider = parameterPopover.getByRole('slider', { name: '滑动调整时长', exact: true })
      const savedDuration = async () => (await query(page, ticket, { id: first.id })).nodes[0].content.params?.duration
      assert.equal(await durationSlider.inputValue(), '0')
      await durationInput.fill('')
      await durationInput.press('1')
      assert.equal(await durationInput.inputValue(), '1', 'typing the first digit should not reset the field')
      await delay(550)
      assert.equal(await savedDuration(), undefined, 'an unfinished value was persisted before commit')
      await durationInput.press('0')
      assert.equal(await durationInput.inputValue(), '10')
      await durationInput.press('Enter')
      await poll(async () => (await savedDuration()) === 10, 'typing and committing 10 seconds did not persist')
      await poll(async () => (await durationSlider.inputValue()) === '2', 'the slider did not follow a typed duration')
      await durationInput.fill('5')
      await durationInput.press('Enter')
      assert.equal(await durationInput.inputValue(), '5')
      await parameterPopover.getByRole('alert').filter({ hasText: '4、8、10' }).waitFor()
      await delay(550)
      assert.equal(await savedDuration(), 10, 'an unsupported duration was persisted')
      await durationSlider.press('ArrowLeft')
      await poll(async () => (await savedDuration()) === 8, 'slider keyboard adjustment did not persist 8 seconds')
      await poll(async () => (await durationInput.inputValue()) === '8', 'the typed field did not follow the slider')
      await durationInput.fill('4')
      await durationInput.press('Tab')
      await poll(async () => (await savedDuration()) === 4, 'a valid duration did not commit on blur')
      await poll(async () => (await durationSlider.inputValue()) === '0', 'the slider did not follow the blur commit')
      await durationSlider.press('ArrowRight')
      await poll(async () => (await savedDuration()) === 8, 'the slider could not restore 8 seconds after the blur commit')
      await screenshot(page, 'focus-mode-parameter-popup.png')
      if (capture) {
        await setTheme(page, 'dark')
        await screenshot(page, 'focus-mode-parameter-popup-dark.png')
        await setTheme(page, 'light')
      }
      const sliderRect = await durationSlider.boundingBox()
      assert.ok(sliderRect?.width > 30, 'duration slider is too narrow to drag')
      const sliderY = sliderRect.y + sliderRect.height / 2
      await page.mouse.move(sliderRect.x + sliderRect.width / 2, sliderY)
      await page.mouse.down()
      await page.mouse.move(sliderRect.x + sliderRect.width - 3, sliderY, { steps: 8 })
      await page.mouse.up()
      await poll(async () => (await savedDuration()) === 10, 'dragging the duration slider did not persist 10 seconds')
      await durationSlider.press('ArrowLeft')
      await poll(async () => (await savedDuration()) === 8, 'the slider could not restore 8 seconds after dragging')
      await page.keyboard.press('Escape')
      await parameterPopover.waitFor({ state: 'hidden' })
      assert.equal(await flow(page).getAttribute('data-focused-node'), first.id, 'closing a popup also exited focus mode')
      await editor.getByRole('button', { name: '展开提示词', exact: true }).click()
      await promptDialog.waitFor()
      await page.keyboard.press('Escape')
      await promptDialog.waitFor({ state: 'hidden' })
      assert.equal(await flow(page).getAttribute('data-focused-node'), first.id, 'closing the full prompt editor also exited focus mode')
      await page.keyboard.press('Escape')
      await exitFocus.waitFor({ state: 'hidden' })
      await poll(async () => (await readViewport()) === originalViewport, 'exiting focus did not restore the exact viewport')
      assert.deepEqual(await nodeGeometry(first), beforeFocus, 'focus mode changed node or port geometry')
      assert.equal(await flow(page).getAttribute('data-focused-node'), null)
      await clickBlank(page)
      await poll(async () => (await query(page, ticket, { id: first.id })).nodes[0].content.params?.duration === 8,
        'advanced parameters did not autosave')
      assert.equal((await query(page, ticket, { id: first.id })).nodes[0].content.params.resolution, '1080p')
      await poll(async () => {
        const [node] = (await query(page, ticket, { id: first.id })).nodes
        return node.content.prompt === prompt && node.content.profileId === profileId
      }, 'prompt or model selection did not autosave')
      await fit(page)
      await firstBox.click()
      await editor.waitFor()
      const editorPanel = card(page, first.id).locator('.drama-node-editor-panel')
      const initialPlacement = await editorPanel.getAttribute('data-placement')
      assert.equal(initialPlacement, 'below')
      const geometryBeforeDrag = await nodeGeometry(first)
      const canvasBounds = await flow(page).boundingBox()
      const sourceBounds = await card(page, first.id).boundingBox()
      const titleBounds = await firstBox.boundingBox()
      const panX = titleBounds.x + titleBounds.width * .45
      const panY = titleBounds.y + titleBounds.height * .5
      const targetY = canvasBounds.y + canvasBounds.height - Math.max(sourceBounds.height * .7, 70)
      await page.mouse.move(panX, panY)
      await page.mouse.down()
      await page.mouse.move(panX, targetY, { steps: 16 })
      await page.mouse.up()
      await poll(async () => (await editorPanel.getAttribute('data-placement')) === 'above',
        'the editor did not flip above the node at the viewport edge')
      const geometryAfterDrag = await nodeGeometry(first)
      assert.notEqual(geometryAfterDrag.transform, geometryBeforeDrag.transform, 'dragging the card did not move it')
      assert.deepEqual(geometryAfterDrag.input, geometryBeforeDrag.input)
      assert.deepEqual(geometryAfterDrag.output, geometryBeforeDrag.output)
      assert.ok(await editorPanel.evaluate(panel => {
        const panelBox = panel.getBoundingClientRect()
        const nodeBox = panel.closest('article').getBoundingClientRect()
        const canvasBox = panel.closest('.drama-flow').getBoundingClientRect()
        return panelBox.bottom <= nodeBox.top && panelBox.top >= canvasBox.top
      }), 'the flipped editor is clipped or overlaps its own card')
      await screenshot(page, 'compact-editor-flipped.png')
      const edgeViewport = await readViewport()
      await focusNode(page, first.id)
      await exitFocus.waitFor()
      await poll(() => editorPanel.evaluate(panel => {
        const box = panel.getBoundingClientRect()
        const card = panel.closest('article').getBoundingClientRect()
        const canvas = panel.closest('.drama-flow').getBoundingClientRect()
        return box.top >= card.bottom && card.top >= canvas.top && box.bottom <= canvas.bottom &&
          box.left >= canvas.left - 1 && box.right <= canvas.right + 1
      }), 'focus did not bring the edge node and its editor into view')
      assert.deepEqual(await nodeGeometry(first), geometryAfterDrag)
      await exitFocus.click()
      await poll(async () => (await readViewport()) === edgeViewport, 'focus did not restore the edge viewport')
      await clickBlank(page)
      await fit(page)
      await card(page, second.id).locator('.drama-node-titlebar').click()
      await formFor(second).waitFor()
      assert.equal(await formFor(first).count(), 0, 'switching selection left the first editor open')
      await clickBlank(page)
      await formFor(second).waitFor({ state: 'hidden' })
      await fit(page)

      const path = edge(second).locator('.react-flow__edge-interaction')
      const hit = await path.evaluate(element => {
        const total = element.getTotalLength()
        for (const fraction of [.5, .3, .7, .4, .6, .8, .9, .2]) {
          const point = element.getPointAtLength(total * fraction).matrixTransform(element.getScreenCTM())
          if (document.elementFromPoint(point.x, point.y) === element) return { x: point.x, y: point.y }
        }
        return null
      })
      assert.ok(hit, 'saved image reference could not be selected')
      await page.mouse.click(hit.x, hit.y)
      await poll(async () => (await edge(second).getAttribute('class'))?.includes('selected'), 'edge did not highlight on click')
      await page.keyboard.press('Delete')
      await poll(async () => !(await query(page, ticket)).edges.some(item => item.source === image.id && item.target === second.id),
        'deleting the selected edge did not remove the reference')
      const afterDelete = await query(page, ticket, { id: second.id })
      assert.ok(!afterDelete.nodes[0].content.mixedListOrder?.includes(image.id), 'removed image remained a model reference')

      const projectAsset = { id: randomUUID(), type: 'image',
        content: { title: '项目原有餐厅门口图', path: 'assets/images/restaurant.png' } }
      const assets = join(home, record.workspaceName, 'assets', 'images')
      await copyFile(projectImageAsset, join(assets, 'restaurant.png'))
      await append(page, ticket, [projectAsset])
      await fit(page)
      await card(page, second.id).locator('.drama-node-titlebar').click()
      const secondEditor = formFor(second)
      const chooseMode = async mode => {
        await secondEditor.getByRole('button', { name: '视频方式', exact: true }).click()
        await page.getByRole('menuitem', { name: mode.toUpperCase(), exact: true }).click()
        await poll(async () => (await query(page, ticket, { id: second.id })).nodes[0].content.mode === mode,
          'changing the mode did not autosave: ' + mode)
      }
      await chooseMode('t2v')
      await chooseMode('i2v')
      const projectEdgeSaved = async () => (await query(page, ticket)).edges.some(item =>
        item.source === projectAsset.id && item.target === second.id)
      async function attachProjectAsset() {
        await secondEditor.getByRole('button', { name: '添加首帧', exact: true }).click()
        await page.getByRole('dialog', { name: '添加参考素材', exact: true })
          .getByRole('button', { name: '从项目资产添加', exact: true }).click()
        await page.getByRole('menuitem').filter({ hasText: projectAsset.content.title }).click()
        await poll(projectEdgeSaved, 'selecting a project asset did not autosave a reference')
      }
      await attachProjectAsset()
      await secondEditor.getByRole('button', { name: '移除参考 1', exact: true }).click()
      await poll(async () => !(await projectEdgeSaved()), 'removing a slot did not autosave disconnection')
      await attachProjectAsset()
      const secondPrompt = '以 @图片1 为首帧，保留餐厅门口的原始构图。'
      await secondEditor.getByRole('textbox', { name: '提示词', exact: true }).fill(secondPrompt)
      await clickBlank(page)
      await secondEditor.waitFor({ state: 'hidden' })
      await poll(async () => (await query(page, ticket, { id: second.id })).nodes[0].content.prompt === secondPrompt,
        'deselecting the node discarded an unsaved prompt edit')
      const finalPrompt = secondPrompt + ' 保留环境声。'
      await fit(page)
      await card(page, second.id).locator('.drama-node-titlebar').click()
      await secondEditor.getByRole('textbox', { name: '提示词', exact: true }).fill(finalPrompt)
      await clickBlank(page)
      const savedPrompt = async expected => (await query(page, ticket, { id: second.id })).nodes[0].content.prompt === expected
      await poll(() => savedPrompt(finalPrompt), 'second prompt edit did not autosave')
      const undo = async expected => {
        await flow(page).focus()
        await page.keyboard.press('Control+z')
        await poll(() => savedPrompt(expected), 'undo restored the wrong autosave revision')
      }
      const redo = async expected => {
        await flow(page).focus()
        await page.keyboard.press('Control+Shift+z')
        await poll(() => savedPrompt(expected), 'redo restored the wrong autosave revision')
      }
      await undo(secondPrompt)
      await undo(prompt.replace('以 @图片1 为首帧，', ''))
      await redo(secondPrompt)
      await redo(finalPrompt)

      await page.reload({ waitUntil: 'domcontentloaded' })
      await panel(page).and(page.locator(`[data-session-id="${record.sessionId}"][data-canvas-id]`)).waitFor()
      ticket = await ticketFor(page, record.sessionId)
      const reloaded = await query(page, ticket)
      const restored = reloaded.nodes.find(node => node.id === first.id)
      assert.equal(restored.content.prompt, prompt)
      assert.equal(restored.content.profileId, profileId)
      assert.equal(restored.content.params.duration, 8)
      assert.equal(restored.content.params.resolution, '1080p')
      assert.deepEqual(restored.content.mixedListOrder, [image.id])
      assert.ok(!restored.content.textList?.length)
      assert.ok(reloaded.edges.some(item => item.source === image.id && item.target === first.id))
      assert.ok(!reloaded.edges.some(item => item.source === image.id && item.target === second.id))
      assert.deepEqual(reloaded.nodes.find(item => item.id === second.id).content.mixedListOrder, [projectAsset.id])
      assert.equal(reloaded.nodes.find(item => item.id === second.id).content.mode, 'i2v')
      assert.equal(reloaded.nodes.find(item => item.id === second.id).content.prompt, finalPrompt)
      assert.ok(reloaded.edges.some(item => item.source === projectAsset.id && item.target === second.id))
      assert.equal((await operate(page, ticket, 'tasks', {})).tasks.length, 0, 'configuration silently submitted a generation')
      assert.equal(received.length, 0, 'editing unexpectedly called the provider')

      await fit(page)
      await card(page, first.id).locator('.drama-node-titlebar').click()
      await card(page, first.id).getByRole('button', { name: '生成…', exact: true }).click()
      await page.getByRole('dialog', { name: '确认生成', exact: true })
        .getByRole('button', { name: '确认提交', exact: true }).click()
      const outgoing = await poll(() => received[0], 'worker did not send a request to the configured channel')
      assert.deepEqual([outgoing.method, outgoing.url], ['POST', '/jobs'])
      const payload = JSON.parse(outgoing.data)
      assert.equal(payload.model, 'capture-i2v')
      assert.equal(payload.prompt, prompt)
      assert.equal(payload.input.duration, 8)
      assert.equal(payload.input.resolution, '1080p')
      assert.equal(payload.input.aspect_ratio, '16:9')
      assert.equal(payload.input.generate_audio, true)
      assert.match(payload.input.first_frame, /^data:image\/png;base64,/u)
      assert.ok(Buffer.from(payload.input.first_frame.split(',')[1], 'base64').equals(png),
        'upstream image bytes differed from the uploaded PNG')
      const failure = await poll(async () => (await operate(page, ticket, 'tasks', {})).tasks.find(task =>
        task.nodeId === first.id && task.status === 'failed'), 'provider rejection was not shown as a failed task')
      assert.equal(failure.resultNodeId, undefined)
      assert.deepEqual((await query(page, ticket, { id: first.id })).nodes[0].content, restored.content)
      assert.equal(received.length, 1, 'the deliberate rejection should not be retried')

      await sidebarMode(page, 'push').click()
      await resizeRightbar(page, 465)
      const narrow = await pick(page, '视频生成', ticket, 'video')
      await chooseVideoMode(page, ticket, narrow.id, 'i2v')
      const narrowPanel = card(page, narrow.id).locator('.drama-node-editor-panel')
      await narrowPanel.waitFor()
      const narrowNodeGeometry = await nodeGeometry(narrow)
      await flow(page).focus()
      await page.keyboard.press('.')
      await delay(280)
      const zoomIn = flow(page).getByRole('button', { name: '放大', exact: true })
      await zoomIn.click()
      await delay(180)
      await poll(() => narrowPanel.evaluate(panel => {
        const box = panel.getBoundingClientRect()
        const canvas = panel.closest('.drama-flow').getBoundingClientRect()
        return panel.offsetWidth < 480 && Math.abs(box.left - canvas.left - 8) < 1 &&
          Math.abs(canvas.right - box.right - 8) < 1
      }), 'zooming in did not constrain the editor to the narrow canvas with both margins')
      const pan = await narrowPanel.evaluate(panel => {
        const pane = panel.closest('.drama-flow').querySelector('.react-flow__pane')
        const canvas = pane.getBoundingClientRect()
        const dy = Math.ceil(canvas.top + 62 - panel.getBoundingClientRect().top)
        if (dy <= 0) return null
        for (const yy of [.8, .84, .88, .76, .72, .68]) {
          const y = canvas.top + canvas.height * yy
          if (y + dy >= canvas.bottom - 12) continue
          for (const xx of [.2, .6, .8]) {
            const x = canvas.left + canvas.width * xx
            if (document.elementFromPoint(x, y) === pane) return { x, y, dy }
          }
        }
        return { dy }
      })
      if (pan) {
        assert.ok('x' in pan, 'no blank space to pan the narrow editor into view')
        await flow(page).focus()
        await page.keyboard.down('Space')
        await page.mouse.move(pan.x, pan.y)
        await page.mouse.down()
        await page.mouse.move(pan.x, pan.y + pan.dy, { steps: 10 })
        await page.mouse.up()
        await page.keyboard.up('Space')
      }
      await poll(() => narrowPanel.evaluate(panel => {
        const box = panel.getBoundingClientRect()
        const canvas = panel.closest('.drama-flow').getBoundingClientRect()
        return box.top >= canvas.top + 61 && box.bottom <= canvas.bottom
      }), 'the narrow editor did not pan fully into view')
      assert.deepEqual(await nodeGeometry(narrow), narrowNodeGeometry, 'the width clamp moved the node or its handles')
      const narrowBounds = await narrowPanel.boundingBox()
      const narrowToolbar = await toolbarBoxes(formFor(narrow))
      assert.equal(narrowToolbar.length, 7, 'narrow editing hid supported controls')
      assert.ok(narrowToolbar.every(box => box.x >= narrowBounds.x && box.y >= narrowBounds.y &&
        box.x + box.width <= narrowBounds.x + narrowBounds.width && box.y + box.height <= narrowBounds.y + narrowBounds.height),
        'the compact toolbar overflowed the narrow editor')
      assert.ok(narrowToolbar.slice(3).some(box => box.y > narrowToolbar[0].y + narrowToolbar[0].height),
        'the parameter controls did not wrap in the narrow editor')
      const narrowDuration = formFor(narrow).getByRole('button', { name: '时长（秒）', exact: true })
      await narrowDuration.click()
      const narrowDurationPopover = page.getByRole('dialog', { name: '时长（秒）', exact: true })
      await narrowDurationPopover.waitFor()
      await page.keyboard.press('Escape')
      await narrowDurationPopover.waitFor({ state: 'hidden' })
      await screenshot(page, 'compact-editor-narrow.png')
      console.info(`Node editor PASS: ${editorGeometry.width}×${editorGeometry.height} CSS px, prompt/IME autosave, focus/viewport, parameter popover and real PNG request`)
    })
  } finally {
    await new Promise(resolve => endpoint.close(resolve))
  }
})

test('Native canvas keyboard operations respect editing and preserve the copied subgraph', {
  timeout: 85_000, skip: !existsSync(projectImageAsset),
}, async () => {
  await withWeb(async ({ page, context, records, home }) => {
    const [record] = records
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await select(page, record)
    await open(page, record)
    await sidebarMode(page, 'fullscreen').click()
    const ticket = await ticketFor(page, record.sessionId)
    const first = { id: randomUUID(), type: 'note', content: { title: '快捷键来源', description: '来源文本。' } }
    const second = { id: randomUUID(), type: 'note', content: { title: '快捷键目标', description: '目标文本。' } }
    await append(page, ticket, [first, second], [{ source: first.id, target: second.id }])
    await fit(page)
    const boxSelect = flow(page).getByRole('button', { name: '框选', exact: true })
    await boxSelect.click()
    await dragCanvasBlank(page, true)
    await boxSelect.click()
    await clickBlank(page)
    await page.keyboard.press('Control+a')
    await flow(page).getByText(/已选 2/u).waitFor()
    await page.keyboard.press('Control+c')
    await page.keyboard.press('Control+v')
    const duplicated = await poll(async () => {
      const graph = await query(page, ticket)
      return graph.nodes.length === 4 && graph
    }, 'copy and paste did not duplicate both selected nodes')
    const original = new Set([first.id, second.id])
    const copies = duplicated.nodes.filter(node => !original.has(node.id))
    assert.deepEqual(new Set(copies.map(node => node.content.description)),
      new Set([first.content.description, second.content.description]))
    assert.equal(duplicated.edges.filter(edge => copies.some(node => node.id === edge.source) &&
      copies.some(node => node.id === edge.target)).length, 1)
    await page.keyboard.press('Control+z')
    await poll(async () => (await query(page, ticket)).nodes.length === 2, 'undo did not remove pasted nodes')
    await page.keyboard.press('Control+Shift+z')
    await poll(async () => (await query(page, ticket)).nodes.length === 4, 'redo did not restore pasted nodes')
    await clickBlank(page)
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Backspace')
    await poll(async () => (await query(page, ticket)).nodes.length === 0, 'Backspace did not remove the selected nodes')
    await page.keyboard.press('Control+z')
    await poll(async () => (await query(page, ticket)).nodes.length === 4, 'undo did not restore the deleted selection')
    await fit(page)
    await card(page, first.id).locator('.drama-node-titlebar').click()
    await card(page, first.id).getByRole('form', { name: '编辑节点', exact: true }).waitFor()
    await page.keyboard.press('Delete')
    await poll(async () => (await query(page, ticket, { id: first.id })).nodes[0].deleted,
      'Delete did not remove the selected node')
    assert.ok(!(await query(page, ticket)).edges.some(edge => edge.source === first.id))

    const png = await readFile(projectImageAsset)
    await page.evaluate(async base64 => {
      const blob = new Blob([Uint8Array.from(atob(base64), byte => byte.charCodeAt(0))], { type: 'image/png' })
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    }, png.toString('base64'))
    await clickBlank(page)
    await page.keyboard.press('Control+v')
    const image = await poll(async () => (await query(page, ticket, { type: 'image' })).nodes.find(node => node.content.path),
      'Ctrl+V with a real clipboard image did not create a node')
    await card(page, image.id).locator('img').first().evaluate(element => element.decode())
    await fit(page)
    await card(page, image.id).locator('.drama-node-titlebar').click()
    await page.keyboard.press('Control+d')
    const copiesOfImage = await poll(async () => {
      const { nodes } = await query(page, ticket, { type: 'image' })
      return nodes.length === 2 && nodes
    }, 'Ctrl+D did not duplicate the image instance')
    assert.ok(copiesOfImage.every(node => node.content.path === image.content.path))
    const duplicate = copiesOfImage.find(node => node.id !== image.id)
    await card(page, duplicate.id).locator('.drama-node-titlebar').click()
    await flow(page).focus()
    await page.keyboard.press('Delete')
    await poll(async () => (await query(page, ticket, { type: 'image' })).nodes.length === 1,
      'deleting a duplicate should leave the other instance')
    assert.ok(existsSync(join(home, record.workspaceName, image.content.path)), 'deleting a node removed its source file')
  })
})
