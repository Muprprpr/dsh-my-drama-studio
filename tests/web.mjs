import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
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
export const inject = ['sessionController', 'workspaceRegistry', 'tools']

export async function apply(ctx) {
  console.info('[drama-web-fixture] PID ' + process.pid)
  ctx.effect(() => {
    let used = false
    const watcher = watch(process.env.DSH_HOME, { persistent: false }, (_event, file) => {
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
    return () => watcher.close()
  })
  const llm = join(dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'node_modules',
    '@deepseek-ai', 'dsh-llm', 'lib', 'index.js')
  const { createMessage, createUserMessage } = await import(pathToFileURL(llm).href)
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

function redact(text) {
  return text.replace(/(https?:\/\/127\.0\.0\.1:\d+[^\s?]*\?)[^\s"'<>]+/gu, '$1[redacted]')
}

const chrome = [
  join(process.env.ProgramFiles, 'Google/Chrome/Application/chrome.exe'),
  join(process.env['ProgramFiles(x86)'], 'Microsoft/Edge/Application/msedge.exe'),
].find(existsSync)
const evidence = join(root, 'docs', 'uiux-v2')
const desktop = join(process.env.USERPROFILE ?? '', 'Desktop')
const imageAsset = process.env.DRAMA_UIUX_IMAGE ?? join(desktop, '课件/4-5-6文生图 图生图/文生图 资料/资产/黄色毛绒小鸭.png')
const videoAsset = process.env.DRAMA_UIUX_VIDEO ?? join(desktop, '转绘项目-1000条样片/导出测试/测试片段.mp4')
const hasImage = existsSync(imageAsset)
const hasVideo = existsSync(videoAsset)
const capture = process.env.DRAMA_UIUX_CAPTURE === '1'

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
  await mkdir(join(entryRoot, 'dist'), { recursive: true })
  await writeFile(join(home, 'package.json'), '{"name":"drama-web-fixture","private":true}\n')
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true, dependencies: { 'dsh-my-drama-studio': '0.1.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-my-drama-studio'] } },
  }))
  await writeFile(fixture, fixtureSource)
  const port = await freePort()
  const env = { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: join(home, 'agents'), DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_API_KEY: '' }
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
  } else await copyFile(join(root, 'dist', 'studio.exe'), executable)
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
  const dsh = spawn('pwsh.exe', ['-NoProfile', '-Command', launch], {
    cwd: root, windowsHide: true, env,
  })
  let output = ''
  let launchError
  dsh.on('error', error => { launchError = error })
  dsh.stdout.on('data', chunk => { output += chunk })
  dsh.stderr.on('data', chunk => { output += chunk })
  let browser, page
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
    const pageErrors = []
    page.on('pageerror', error => pageErrors.push(error.message))
    await initialize(page, url)
    await run({ page, context, url, records, home })
    assert.deepEqual(pageErrors, [])
    passed = true
  } catch (error) {
    await page?.screenshot({ path: join(home, 'failure.png'), animations: 'disabled' }).catch(() => {})
    throw new Error(redact(`${error.stack}\nTest profile: ${home}\nDSH output:\n${output.split(/\r?\n/u).slice(0, 25).join('\n')}`))
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

async function pick(page, type, openPicker) {
  if (openPicker) await openPicker()
  else await panel(page).getByRole('toolbar', { name: '画布工具', exact: true })
    .getByRole('button', { name: '新增节点', exact: true }).click()
  const input = page.getByRole('textbox', { name: '查找节点类型', exact: true })
  await input.fill(type)
  await input.press('Enter')
  const draft = draftCard(page).last()
  await draft.waitFor()
  return draft
}

async function inputLayoutTest(page, textarea) {
  const viewport = flow(page).locator('.react-flow__viewport')
  const draft = textarea.locator('xpath=ancestor::article[1]')
  const position = draft.locator('xpath=ancestor::div[contains(@class,"react-flow__node")][1]')
  const bounds = await textarea.boundingBox()
  assert.ok(bounds && bounds.height > 16)
  const before = await viewport.evaluate(element => element.style.transform)
  const nodeBefore = await position.evaluate(element => element.style.transform)
  const point = { x: bounds.x + Math.min(30, bounds.width / 4), y: bounds.y + 13 }
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

async function dragCanvasBlank(page) {
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
  await page.mouse.move(point.x, point.y)
  await page.mouse.down()
  await page.mouse.move(point.x - 30, point.y - 35, { steps: 10 })
  await page.mouse.up()
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

test('U2 U3 U5 node drafts, shared Sessions, media and native theme/layout', { timeout: 180_000 }, async () => {
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
    const draft = await pick(page, '镜头')
    const create = draft.getByRole('form', { name: '新建节点', exact: true })
    await create.waitFor()
    const name = create.getByRole('textbox', { name: '节点名称', exact: true })
    await poll(() => name.evaluate(element => document.activeElement === element), 'new shot did not autofocus its name')
    await name.fill('推门进入餐厅')
    await create.getByRole('textbox', { name: '集', exact: true }).fill('EP01')
    await create.getByRole('textbox', { name: '场', exact: true }).fill('S01')
    await create.getByRole('textbox', { name: '镜头', exact: true }).fill('SH03')
    const description = create.getByRole('textbox', { name: '正文', exact: true })
    await description.fill('中景固定机位。人物推门后停顿，视线落到桌角的黄色小鸭。')
    await screenshot(page, '20-after-new-shot.png')
    await assertCanvasLayout(page)
    await create.getByRole('button', { name: '创建节点', exact: true }).click()
    await create.waitFor({ state: 'hidden' })
    const [original] = (await query(page, first, { q: '推门进入餐厅' })).nodes
    assert.ok(original?.id)
    assert.equal(original.shotId, 'SH03')
    await observer.bringToFront()
    await card(observer, original.id).waitFor()
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

    const newVideo = await pick(page, 't2v', async () => {
      const point = await dragCanvasBlank(page)
      await page.mouse.click(point.x, point.y, { button: 'right' })
    })
    const videoPrompt = newVideo.getByRole('textbox', { name: '完整视频提示词', exact: true })
    await videoPrompt.fill('完整视频提示词。她推开餐厅门，先停顿，再将视线落向桌角。\n镜头保持固定中景。')
    await inputLayoutTest(page, videoPrompt)
    await screenshot(page, '23-after-prompt-editor.png')
    await newVideo.getByRole('button', { name: '取消', exact: true }).click()
    await newVideo.waitFor({ state: 'hidden' })
    assert.equal((await query(page, first, { type: 'video' })).nodes.length, 0)

    await fit(page)
    await card(page, revised.id).locator('.drama-node-titlebar').click({ button: 'right' })
    await page.getByText('复制为新节点', { exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await card(page, revised.id).getByRole('button', { name: '新增后继节点', exact: true }).click()
    const successor = await pick(page, '备注', async () => {})
    await successor.getByRole('textbox', { name: '节点名称', exact: true }).fill('后继剪辑备忘')
    await successor.getByRole('textbox', { name: '正文', exact: true }).fill('将开门声留到镜头前半拍。')
    await successor.getByRole('button', { name: '创建节点', exact: true }).click()
    const note = await poll(async () => (await query(page, first, { q: '后继剪辑备忘' })).nodes[0], 'successor note not persisted')
    const references = await query(page, first)
    assert.ok(references.edges.some(edge => edge.source === revised.id && edge.target === note.id))

    await panel(page).getByRole('button', { name: '整理节点', exact: true }).click()
    await fit(page)
    await dragNode(page, revised.id)
    assert.equal((await query(page, first, { id: revised.id })).nodes[0].content.description, revised.content.description)

    const { imageId, videoId } = await addExistingMedia(page, first, join(home, a.workspaceName))
    await panel(page).getByText(`${6 + Number(hasImage) + Number(hasVideo)} 个节点`, { exact: false }).first().waitFor()
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
        defaults: { duration: 4 }, limits: { durations: [4, 8] },
      },
    })
    await settings('generation_save', {
      revision: models.revision,
      generation: { defaultModelId: models.profiles[0].id, maxConcurrent: 2, outputDirectory: 'assets/native-results' },
    })
    await select(page, a)
    await open(page, a)
    const ticket = await ticketFor(page, a.sessionId)
    const draft = await pick(page, 't2v')
    await draft.getByLabel('节点名称', { exact: true }).fill('排队与结果定位验收')
    await draft.getByLabel('完整视频提示词', { exact: true }).fill('固定中景。人物推开餐厅门，在门口停顿。')
    await draft.getByText('更多参数', { exact: true }).click()
    await draft.getByRole('button', { name: '时长（秒）', exact: true }).click()
    await page.getByRole('menuitem', { name: '8', exact: true }).click()
    await draft.getByRole('button', { name: '创建节点', exact: true }).click()
    await draft.waitFor({ state: 'detached' })
    const [node] = (await query(page, ticket, { q: '排队与结果定位验收' })).nodes
    assert.equal(node.content.params.duration, 8)
    assert.deepEqual(node.content.mixedListOrder, [])
    assert.equal(node.content.textList, undefined)
    const nodeId = node.id
    const source = card(page, nodeId)
    await source.getByRole('button', { name: '生成…', exact: true }).click()
    const confirm = source.getByRole('dialog', { name: '确认生成', exact: true })
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
    await writeFile(join(home, 'allow-fixture-result'), '')
    const completed = await poll(async () => {
      const { tasks } = await operate(page, ticket, 'tasks', {})
      return tasks.find(task => task.id === running.id && task.status === 'completed')
    }, 'Go worker did not finish while the native panel was closed', 20_000)
    assert.ok(completed.resultNodeId)
    const [result] = (await query(page, ticket, { id: completed.resultNodeId })).nodes
    assert.equal(result.basedOn, nodeId)
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
    await resultCard.getByRole('button', { name: '打开视频预览', exact: true }).click()
    const player = resultCard.locator('video')
    assert.ok(await decodeVideoFrame(player))
    assert.ok(await player.evaluate(video => video.videoWidth > 0))
    await screenshot(page, '41-after-task-result-fixture.png')
    console.info('U4 real persisted queue PASS: fixture-only provider, polling with node/drawer, native panel closed, worker completed, persisted result located and played; no external requests')
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
      const draft = await pick(page, mode)
      await draft.getByLabel('节点名称', { exact: true }).fill(title)
      await draft.getByLabel('完整视频提示词', { exact: true }).fill(prompt)
      for (const ref of references) {
        await draft.getByRole('button', { name: picker, exact: true }).click()
        await page.getByRole('menuitem').filter({ hasText: ref.content.title }).click()
      }
      await draft.getByRole('button', { name: '创建节点', exact: true }).click()
      await draft.waitFor({ state: 'detached' })
      const { nodes, edges } = await query(page, ticket)
      const node = nodes.find(item => item.content.title === title)
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
