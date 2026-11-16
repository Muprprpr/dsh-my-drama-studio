import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { access, appendFile, copyFile, cp, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

// A fixture plugin mounted by the installed DSH CLI. Only the model response is scripted.
export const name = 'drama-built-in-assets-fixture'
export const inject = ['agentPresets', 'connection', 'llm', 'pluginPackages', 'profileContext', 'sessionController', 'tools', 'webServer', 'workspaceRegistry']

const storyboard = 'storyboard'
const upgraded = 'asset-binding'
const testVersion = '99.0.0-fixture'
const custom = 'drama-test-resources'
const ordinary = 'ordinary-fixture-skill'
const imported = 'test-custom-storyboard'
const provider = 'drama-built-in-test'
const model = 'scripted'
const packageName = 'dsh-my-drama-studio'
const relativeResources = ['references/shot-sizes.md', 'templates/storyboard.md', 'scripts/check.js']
const resourceTarget = (key, part) => 'skills/' + key + '/' + part
const bundledResources = relativeResources.map(part => resourceTarget('drama-' + storyboard, part))
const fixedStages = [
  'content-analysis', 'shooting-script', storyboard, 'asset-binding',
  'video-deployment', 'video-generation', 'final-review',
]
const managedStages = ['topic-selection', ...fixedStages]
const ledgerPath = 'drama-studio/managed-assets.json'
const workflowDir = 'drama-studio/workflows/drama-production'
const skillPath = key => join('skills', key, 'SKILL.md')
const harnessPath = stage => join(workflowDir, 'stages', stage, 'harness.md')
const stageTargets = stage => [skillPath('drama-' + stage), harnessPath(stage)]
const digest = value => createHash('sha256').update(value).digest('hex')
const hash = value => value?.replace(/^sha256:/u, '')
const log = value => console.info('[' + name + '] ' + value)

export function apply(ctx) {
  const life = new AbortController()
  const done = verify(ctx, life.signal).catch(error => {
    if (!life.signal.aborted) console.error('[' + name + '] FAIL', error.stack)
  })
  ctx.effect(() => async () => {
    life.abort()
    await done
  }, name)
}

async function until(check, signal, label, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    signal.throwIfAborted()
    const result = await check()
    if (result) return result
    await delay(50, undefined, { signal })
  }
  throw new Error('Timed out waiting for ' + label)
}

async function put(path, body) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, body)
}

const skillText = (key, marker, policy = '') =>
  '---\nname: ' + key + '\ndescription: Native integration fixture.\n' + policy + '---\n' + marker + '\n'

async function verify(ctx, signal) {
  const home = await realpath(ctx.profileContext.home)
  assert.equal(home, await realpath(process.env.DSH_HOME))
  assert.ok(basename(dirname(home)).startsWith('drama-built-in-host-'), 'Requires an isolated test home')
  const scenario = process.env.DRAMA_BUILT_IN_SCENARIO
  const lib = createRequire(ctx.profileContext.installAnchor)
  const { renderSkillContent } = await import(pathToFileURL(lib.resolve('@deepseek-ai/dsh-skill')).href)
  const { LlmAdapter } = await import(pathToFileURL(lib.resolve('@deepseek-ai/dsh-llm')).href)
  const requests = []
  let pendingRead
  ctx.llm.registerAdapter([provider], new class extends LlmAdapter {
    async listModels() {
      return [{ provider, id: model, name: model }]
    }

    async * stream(options) {
      if (!options.purpose || options.purpose === 'agent') {
        requests.push(options.messages)
        if (pendingRead) {
          const file_path = pendingRead
          pendingRead = undefined
          assert.ok(options.tools?.some(tool => tool.name === 'read'))
          const block = { type: 'tool-call', id: randomUUID(), name: 'read', arguments: JSON.stringify({ file_path }) }
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'block-end', index: 0, block }
          yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Local fixture reply.' } }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  })

  const project = join(dirname(home), 'workspace-' + scenario)
  await mkdir(join(project, '.git'), { recursive: true })
  await put(join(project, '.dsh', skillPath('drama-storyboard')), skillText('drama-storyboard', 'PROJECT_RULES'))
  const workspaceDB = join(project, '.drama-studio', 'studio.db')
  await mkdir(dirname(workspaceDB), { recursive: true })
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
  const existingDB = new DatabaseSync(workspaceDB)
  try {
    existingDB.exec('CREATE TABLE IF NOT EXISTS canvas_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL);' +
      "INSERT INTO canvas_meta VALUES(1,'legacy-canvas-fixture') ON CONFLICT DO NOTHING")
  } finally {
    existingDB.close()
  }
  const workspace = await ctx.workspaceRegistry.create(project)
  const sessions = ctx.sessionController
  const { sessionId } = await sessions.create({ workspaceId: workspace.id })
  await sessions.selectModel({ sessionId, provider, model })
  const { agent } = await sessions.resolveAgent(sessionId)
  assert.ok(agent)
  const registry = ctx.agentPresets.serviceFor(agent, 'skills') ?? ctx.get('skills')
  assert.equal(typeof registry?.registerProvider, 'function')
  assert.equal(typeof registry?.register, 'function')
  const nativeOptions = { scope: agent, signal }

  const origin = ctx.webServer.getOrigin()
  const cookie = await until(async () => {
    const response = await fetch(ctx.connection.authenticatedUrl(origin), { redirect: 'manual', signal })
    return response.status === 303 ? response.headers.get('set-cookie')?.split(';', 1)[0] : undefined
  }, signal, 'DSH owner login')
  const request = (route, body) => fetch(new URL('/api/drama/' + route, origin), {
    method: 'POST', headers: { 'content-type': 'application/json', origin, cookie },
    body: JSON.stringify(body), signal,
  })
  async function ok(response, label) {
    const data = await response.json()
    assert.ok(response.ok, label + ' HTTP ' + response.status + ' ' + JSON.stringify(data))
    return data
  }
  const { ticket } = await until(async () => {
    const response = await request('init', { sessionId })
    if (response.status !== 404 || response.headers.get('content-type')?.includes('application/json')) {
      return ok(response, 'init')
    }
    await response.body?.cancel()
  }, signal, 'Studio routes')
  const op = (action, data) => request('operation', { ticket, action, data })
  const library = (action, data) => request('skills', { action, data })
  const read = async () => ok(await op('workflow_get'), 'workflow_get')
  const activate = stageId => op('workflow_activate', { operationId: randomUUID(), stageId })
  const stageFiles = view => view.stages.find(stage => stage.id === storyboard).files
  await ok(await op('bind', { operationId: randomUUID() }), 'bind')

  async function chat(file) {
    pendingRead = file
    const previous = agent.session.snapshotEvents().at(-1)?.seq ?? -1
    const index = requests.length
    const accepted = await sessions.prompt({
      sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'Test the installed runtime.' }],
    }, signal)
    assert.equal(accepted.accepted, true)
    const end = await until(() => agent.session.snapshotEvents().find(event =>
      event.seq > previous && event.type === 'turn/end'), signal, 'native chat turn')
    assert.equal(end.data.reason.kind, 'completed', JSON.stringify(end))
    assert.equal(requests.length, index + (file ? 2 : 1))
    return JSON.stringify(requests.at(-1))
  }

  async function readSkillResources(definition) {
    const paths = []
    assert.equal(definition.resourceBase.kind, 'directory')
    for (const relative of relativeResources) {
      assert.ok(definition.content.includes(relative), 'Skill must explicitly reference ' + relative)
      const path = join(definition.resourceBase.path, relative)
      const result = await ctx.tools.execute({
        agent, callId: randomUUID(), name: 'read', arguments: { file_path: path }, signal,
      })
      assert.equal(result.isError, false, JSON.stringify(result.content))
      assert.equal(await realpath(result.meta.path), await realpath(path))
      const text = result.meta.lines.map(line => line.text).join('\n')
      assert.equal(text.trimEnd(), (await readFile(path, 'utf8')).replaceAll('\r\n', '\n').trimEnd())
      paths.push(path)
    }
    return paths
  }

  let view = await read()
  if (scenario === 'blocked') {
    assert.equal(view.capabilities.ready, false)
    assert.match(JSON.stringify(view.capabilities), /managed-assets\.json/u)
    assert.equal((await activate(storyboard)).ok, false)
    assert.doesNotMatch(await chat(), /\[Drama Studio Workflow Stage\]/u)
    log('PASS blocked bootstrap leaves ordinary DSH chat available')
    return
  }
  if (scenario === 'blocked-target' || scenario === 'denied-target') {
    const target = join(home, bundledResources[2])
    const denied = scenario === 'denied-target'
    const status = denied ? 'blocked' : 'conflict'
    assert.equal(view.capabilities.ready, false)
    assert.equal(view.capabilities.status, status)
    const resource = stageFiles(view).resourceAssets.find(resource => resource.path === target)
    assert.equal(resource?.status, status)
    assert.equal(stageFiles(view).skillReady, false)
    assert.ok(view.stages.filter(stage => stage.id !== storyboard).every(stage => stage.files.skillReady))
    const activation = await activate(storyboard)
    assert.equal(activation.status, denied ? 503 : 409)
    assert.ok(JSON.stringify(await activation.json()).includes('check.js'))
    assert.doesNotMatch(await chat(), /\[Drama Studio Workflow Stage\]/u)
    if (denied) {
      await assert.rejects(readFile(target), { code: 'ENOENT' })
      log('PASS Windows ACL write denial leaves no formal file and ordinary DSH chat still works')
    } else {
      assert.equal(await readFile(join(target, 'private.txt'), 'utf8'), 'User directory contents\n')
      log('PASS conflicted ancillary target blocks only its stage and preserves ordinary DSH chat and user bytes')
    }
    return
  }
  assert.deepEqual(view.stages.map(stage => stage.id), fixedStages)
  assert.equal(view.workflowProfileId, 'legacy-drama-production')
  const unavailable = view.stages.filter(stage => !stage.files.skillReady || !stage.files.harnessReady)
  assert.deepEqual(unavailable.map(stage => ({ id: stage.id, issues: stage.files.issues })), [])
  const ledger = JSON.parse(await readFile(join(home, ledgerPath), 'utf8'))
  assert.equal(Object.keys(ledger.assets).filter(id => ledger.assets[id].status !== 'deprecated').length,
    managedStages.length * 2 + bundledResources.length - (scenario === 'upgrade' ? 1 : 0))
  const native = (key, cwd) => registry.get(key, { ...nativeOptions, ...(cwd && { cwd }) })
  for (const stage of view.stages) {
    const key = 'drama-' + stage.id
    const definition = await native(key)
    const files = stage.files
    assert.equal(files.skillName, key)
    assert.equal(files.skillSource, 'user-dsh')
    assert.equal(definition.source, 'user-dsh')
    assert.equal(await realpath(definition.path), join(home, skillPath(key)))
    assert.equal(definition.invocation.userInvocable, true)
    assert.equal(definition.invocation.modelInvocable, false)
    assert.equal(definition.resourceBase.kind, 'directory')
    assert.equal(await realpath(definition.resourceBase.path), dirname(join(home, skillPath(key))))
    assert.match(renderSkillContent(definition), /Resolve relative paths/u)
    assert.ok(definition.content.trim())
    assert.equal(hash(files.skillAsset.hash), digest(await readFile(join(home, skillPath(key)))))
    assert.equal(hash(files.harnessAsset.hash), digest(await readFile(join(home, harnessPath(stage.id)))))
  }
  assert.equal((await native('drama-storyboard', project)).source, 'project-dsh')
  const official = await native('drama-storyboard')
  assert.doesNotMatch(official.content, /PROJECT_RULES/u)
  if (scenario === 'user-owned') {
    assert.equal(stageFiles(view).skillAsset.status, 'user-owned')
    assert.match(official.content, /USER_OWNED_RULES/u)
    await ok(await activate(storyboard), 'activate user-owned stage Skill')
    assert.match(await chat(), /USER_OWNED_RULES/u)
    await assert.rejects(access(join(home, skillPath(imported))), { code: 'ENOENT' })
    log('PASS user-owned Skill preserved, discovered and activated in second DSH Home')
    return
  }

  assert.equal(view.capabilities.ready, true, JSON.stringify(view.capabilities))
  if (scenario === 'packed') {
    const packageDir = join(home, 'profiles', 'web', 'node_modules', packageName)
    const info = ctx.pluginPackages.packageOf(packageName, import.meta.url)
    assert.equal(await realpath(info.dir), await realpath(packageDir))
    assert.equal(await realpath(process.cwd()), await realpath(dirname(home)))
    const manifest = JSON.parse(await readFile(join(packageDir, 'resources', 'manifest.json'), 'utf8'))
    assert.equal(manifest.assets.length, managedStages.length * 2 + bundledResources.length)
    for (const asset of manifest.assets) {
      const installed = await readFile(join(home, asset.target))
      assert.deepEqual(installed, await readFile(join(packageDir, 'resources', asset.source)))
      const record = ledger.assets[asset.id]
      assert.equal(record.target, asset.target)
      assert.equal(record.status, 'managed')
      assert.equal(hash(record.installedHash), digest(installed))
    }
    const paths = await readSkillResources(official)
    assert.deepEqual(stageFiles(view).resourceAssets.map(asset => asset.status), paths.map(() => 'ready'))
    const catalog = await ok(await library('list'), 'packed Skill Library')
    assert.deepEqual(catalog.skills.filter(skill => skill.builtIn && skill.bindable).map(skill => skill.id).sort(),
      managedStages.map(id => 'drama-' + id).sort())
    await ok(await activate(storyboard), 'activate packed stage Skill')
    const turn = await chat(paths[0])
    assert.match(turn, /\[Drama Studio Workflow Stage\]/u)
    const firstLine = (await readFile(paths[0], 'utf8')).split(/\r?\n/u)[0]
    assert.ok(firstLine && turn.includes(JSON.stringify(firstLine).slice(1, -1)), 'Packed read text missing from native tool result')
    log('PACK ' + JSON.stringify({
      packageRoot: info.dir, cwd: process.cwd(), home, version: info.version,
      node: process.versions.node, electron: process.versions.electron,
      stages: view.stages.map(({ id, files }) => ({ id, source: files.skillSource, skill: files.skillReady, harness: files.harnessReady })),
      assets: manifest.assets.map(({ id, target }) => ({ id, target, installedHash: ledger.assets[id].installedHash })),
      resourceBase: official.resourceBase.path, nativeRead: paths,
    }))
    log('PASS packed Host read all three resources through native DSH tools')
    return
  }
  if (scenario === 'repeat' || scenario === 'recovery') {
    const skill = (await ok(await library('detail', { skillId: imported }), 'read imported Skill after restart')).skill
    assert.equal(skill.source, 'user-imported')
    assert.equal(skill.userModified, true)
    assert.match(skill.content, /EDITED_AFTER_IMPORT/u)
    log('PASS complete capabilities after ' + scenario + ' start')
    return
  }
  if (scenario === 'upgrade') {
    assert.equal(view.capabilities.packageVersion, testVersion)
    assert.equal(ledger.packageVersion, testVersion)
    for (const stage of [storyboard, upgraded]) {
      const modified = stage === storyboard
      const status = modified ? 'update-available' : 'ready'
      const { files } = view.stages.find(item => item.id === stage)
      assert.equal(files.skillAsset.status, status)
      assert.equal(files.harnessAsset.status, status)
      for (const [index, target] of stageTargets(stage).entries()) {
        const installed = await readFile(join(home, target), 'utf8')
        assert.match(installed, modified ? /USER_EDITED/u : /BUNDLED_UPGRADE/u)
        assert.doesNotMatch(installed, modified ? /BUNDLED_UPGRADE/u : /USER_EDITED/u)
        const record = ledger.assets[index === 0 ? 'skill:drama-' + stage : 'harness:' + stage]
        assert.equal(record.status, modified ? 'update-available' : 'managed')
        if (modified) assert.notEqual(hash(record.installedHash), digest(installed))
        else assert.equal(hash(record.installedHash), digest(installed))
      }
    }
    const [reference, template, script] = bundledResources
    const resourceRecord = target => ledger.assets['skill-resource:' + target.slice('skills/'.length)]
    assert.match(await readFile(join(home, reference), 'utf8'), /USER_EDITED/u)
    assert.doesNotMatch(await readFile(join(home, reference), 'utf8'), /BUNDLED_UPGRADE/u)
    assert.equal(resourceRecord(reference).status, 'update-available')
    const templateBytes = await readFile(join(home, template))
    assert.match(templateBytes.toString('utf8'), /BUNDLED_UPGRADE/u)
    assert.equal(resourceRecord(template).status, 'managed')
    assert.equal(hash(resourceRecord(template).installedHash), digest(templateBytes))
    assert.equal(resourceRecord(script).status, 'deprecated')
    log('PASS ancillary upgrade preserved edited reference and removed script, replaced unchanged template')
    log('PASS real Host upgraded unchanged Skill and Harness, preserved both user-edited files')
    return
  }
  log('PASS seven legacy native user-dsh Skills and seven Harnesses, raw hashes and resource bases, project shadow excluded')
  await readSkillResources(official)
  log('PASS native Skill resourceBase resolved and read references, templates and script contents')
  await put(join(home, skillPath(ordinary)), skillText(ordinary, 'ORDINARY_RULES'))
  await verifyLibrary(signal, home, library, native, readSkillResources)
  await ok(await activate(storyboard), 'activate with bundled defaults')
  const frozen = (await read()).session
  assert.ok(frozen.snapshotId)
  assert.equal(frozen.skillSha256, digest(renderSkillContent(official)))
  await put(join(home, skillPath(custom)), skillText(custom, ['CUSTOM_RULES_V1', ...relativeResources].join('\n')))
  for (const [index, path] of relativeResources.entries()) {
    await put(join(home, resourceTarget(custom, path)), await readFile(join(home, bundledResources[index])))
  }
  const oldMappingPath = join(home, workflowDir, 'stage-skills.json')
  const mappingPath = join(home, 'drama-studio/workflows/stage-bindings.json')
  const currentHarness = join(home, harnessPath(storyboard))
  const originalHarness = await readFile(currentHarness)
  const modifiedHarness = 'CUSTOM_HARNESS_V2\n'
  const formerMapping = JSON.stringify({ [storyboard]: custom })
  await put(oldMappingPath, formerMapping)
  const settings = await ok(await library('bindings'), 'migrate legacy stage mapping')
  const binding = id => settings.profiles.find(profile => profile.id === id).stages.find(stage => stage.id === storyboard)
  assert.equal(binding('legacy-drama-production').skillId, custom)
  assert.equal(binding('short-drama').skillId, 'drama-storyboard')
  assert.equal(binding('short-video').skillId, 'drama-storyboard')
  const migration = JSON.parse(await readFile(mappingPath, 'utf8'))
  assert.equal(migration.legacyMigration.sha256, digest(formerMapping))
  assert.equal(await readFile(oldMappingPath, 'utf8'), formerMapping)
  const mapped = skill => put(mappingPath, JSON.stringify({ ...migration, profiles: { 'legacy-drama-production': { [storyboard]: skill } } }))
  await put(currentHarness, modifiedHarness)
  const mappedView = await until(async () => {
    const next = await read()
    return stageFiles(next).skillReady && stageFiles(next).skillName === custom && next
  }, signal, 'native discovery of mapped Skill')
  assert.ok(mappedView.stages.filter(stage => stage.id !== storyboard)
    .every(stage => stage.files.skillName === 'drama-' + stage.id && stage.files.skillReady))
  assert.equal(mappedView.session.snapshotId, frozen.snapshotId)
  assert.equal(mappedView.session.harnessSha256, frozen.harnessSha256)
  assert.doesNotMatch(await chat(), /CUSTOM_HARNESS_V2|CUSTOM_RULES_V1|PROJECT_RULES/u)
  await ok(await activate(''), 'exit stage')
  await ok(await activate(storyboard), 'reactivate with mapped Skill and edited Harness')
  view = await read()
  assert.notEqual(view.session.snapshotId, frozen.snapshotId)
  assert.equal(view.session.harnessSha256, digest(modifiedHarness))
  assert.equal(view.session.skillSha256, digest(renderSkillContent(await native(custom))))
  log('PASS activation snapshot ' + JSON.stringify({ profileId: view.workflowProfileId, skillId: custom,
    skillSha256: view.session.skillSha256, harnessSha256: view.session.harnessSha256 }))
  const rendered = await chat()
  assert.match(rendered, /CUSTOM_HARNESS_V2/u)
  assert.match(rendered, /CUSTOM_RULES_V1/u)
  assert.doesNotMatch(rendered, /PROJECT_RULES/u)
  const [reference] = await readSkillResources(await native(custom))
  const active = (await read()).session
  assert.doesNotMatch(await chat(reference), /FIXTURE_REFERENCE_V2/u)
  await appendFile(reference, '\nFIXTURE_REFERENCE_V2\n')
  const laterTurn = await chat(reference)
  assert.match(laterTurn, /FIXTURE_REFERENCE_V2/u)
  assert.match(laterTurn, /CUSTOM_RULES_V1/u)
  const afterEdit = (await read()).session
  assert.equal(afterEdit.snapshotId, active.snapshotId)
  assert.equal(afterEdit.skillSha256, active.skillSha256)
  assert.equal(afterEdit.harnessSha256, active.harnessSha256)
  log('PASS later native turn read updated reference with unchanged active Skill and Harness snapshot')
  const callSkill = key => ctx.tools.execute({ agent, callId: randomUUID(), name: 'skill', arguments: { name: key }, signal })
  const mappedCall = await callSkill(custom)
  assert.equal(mappedCall.isError, true)
  assert.match(JSON.stringify(mappedCall.content), /Workflow 管理的阶段能力/u)
  const ordinarySkill = await until(() => native(ordinary), signal, 'ordinary Skill discovery')
  assert.equal(ordinarySkill.invocation.modelInvocable, true)
  assert.match(ordinarySkill.content, /ORDINARY_RULES/u)
  const ordinaryCall = await callSkill(ordinary)
  assert.equal(ordinaryCall.isError, false, JSON.stringify(ordinaryCall.content))
  assert.match(JSON.stringify(ordinaryCall.content), /ORDINARY_RULES/u)
  await ok(await activate(''), 'exit mapped stage')

  for (const key of ['missing-storyboard', '../outside']) {
    await mapped(key)
    const result = await activate(storyboard)
    assert.equal(result.ok, false)
    const error = (await result.json()).error
    assert.ok(error.includes(key) || error.includes(mappingPath), error)
    if (key === 'missing-storyboard') assert.ok(error.includes(join(home, skillPath(key))), error)
    assert.equal((await read()).session.activeStageId ?? '', '')
  }
  await put(join(home, skillPath('empty-storyboard')), skillText('empty-storyboard', ''))
  await mapped('empty-storyboard')
  const empty = await until(async () => {
    const definition = await native('empty-storyboard')
    return definition && { content: definition.content }
  }, signal, 'native discovery of header-only Skill')
  assert.equal(empty.content, '')
  assert.equal(stageFiles(await read()).skillReady, false)
  assert.equal((await activate(storyboard)).ok, false)
  await mapped('foreign-stage-skill')
  await put(join(process.env.DSH_AGENTS_HOME, skillPath('foreign-stage-skill')), skillText('foreign-stage-skill', 'EXTERNAL_SOURCE'))
  const external = await activate(storyboard)
  assert.equal(external.status, 409)
  assert.match((await external.json()).error, /user-agents.*user-dsh/u)
  await mapped('drama-storyboard')
  await rename(currentHarness, currentHarness + '.missing')
  const missingHarness = await activate(storyboard)
  assert.equal(missingHarness.status, 404)
  assert.ok((await missingHarness.json()).error.includes(currentHarness))
  await rename(currentHarness + '.missing', currentHarness)
  await writeFile(currentHarness, originalHarness)
  await ok(await library('bind', { profileId: 'legacy-drama-production', stageId: storyboard, skillId: null }), 'reset legacy mapping')
  assert.equal(await readFile(oldMappingPath, 'utf8'), formerMapping)
  log('PASS fresh or edited capabilities used at reactivation, frozen activation retained, invalid or missing mapping rejected')
}

async function verifyLibrary(signal, home, call, native, readSkillResources) {
  async function success(action, data) {
    const response = await call(action, data)
    const payload = await response.json()
    assert.ok(response.ok, action + ' HTTP ' + response.status + ' ' + JSON.stringify(payload))
    return payload
  }
  async function reject(action, data, status, reason) {
    const response = await call(action, data)
    const payload = await response.json()
    assert.equal(response.status, status, JSON.stringify(payload))
    assert.match(payload.error, reason)
  }
  const id = imported
  const source = join(dirname(home), id)
  const original = skillText(id, ['ORIGINAL_CONTENT', ...relativeResources].join('\n'))
  await put(join(source, 'SKILL.md'), original)
  const script = 'require("node:fs").writeFileSync(' + JSON.stringify(join(source, 'unexpected-script-execution')) + ', "executed");\n'
  for (const path of relativeResources) await put(join(source, path), path.endsWith('.js') ? script : path + '\n')
  const list = await success('refresh')
  assert.equal(list.directory, join(home, 'skills'))
  assert.equal(list.canOpen, true, 'Native path opener capability')
  assert.deepEqual(list.skills.filter(skill => skill.builtIn && skill.bindable).map(skill => skill.id).sort(),
    managedStages.map(stage => 'drama-' + stage).sort())
  assert.equal(list.skills.find(skill => skill.id === ordinary).source, 'user-managed')
  assert.equal(list.skills.find(skill => skill.id === ordinary).description, 'Native integration fixture.')
  const first = await success('import', { path: source })
  assert.equal(first.status, 'imported')
  assert.equal(first.skill.source, 'user-imported')
  assert.equal(first.skill.nativeSource, 'user-dsh')
  assert.equal(first.skill.bindable, true)
  assert.equal(first.skill.hash, digest(original))
  assert.equal(first.skill.content, original.trim())
  assert.deepEqual(await success('open_directory', { skillId: id }), { opened: true, path: join(home, 'skills', id) })
  const discovered = await until(() => native(id), signal, 'native import discovery')
  assert.equal(discovered.source, 'user-dsh')
  assert.equal(await realpath(discovered.path), join(home, skillPath(id)))
  const resourceFiles = await readSkillResources(discovered)
  assert.equal(resourceFiles.length, relativeResources.length)
  assert.deepEqual(first.skill.resources.map(resource => resource.relativePath).sort(), [...relativeResources].sort())
  await assert.rejects(access(join(source, 'unexpected-script-execution')), { code: 'ENOENT' })
  assert.equal((await success('import', { path: source })).status, 'already-exists')
  await appendFile(join(source, 'SKILL.md'), 'CHANGED_SOURCE\n')
  await reject('import', { path: source }, 409, /已存在.*内容不同/u)
  assert.equal(await readFile(discovered.path, 'utf8'), original)
  const originalOfficial = await readFile(join(home, skillPath('drama-storyboard')), 'utf8')
  const officialConflict = join(dirname(home), 'drama-storyboard')
  await put(join(officialConflict, 'SKILL.md'), skillText('drama-storyboard', 'NO_OVERWRITE'))
  await reject('import', { path: officialConflict }, 409, /已存在.*内容不同/u)
  const clone = await success('clone', { skillId: 'drama-storyboard', name: 'test-custom-official' })
  assert.equal(clone.skill.source, 'user-imported')
  assert.match(clone.skill.content, /name: "test-custom-official"/u)
  assert.equal(clone.skill.resources.length, relativeResources.length)
  assert.equal(await readFile(join(home, skillPath('drama-storyboard')), 'utf8'), originalOfficial)
  const invalid = join(dirname(home), 'invalid-skill')
  await put(join(invalid, 'SKILL.md'), '---\nname: [unterminated\n---\nBODY\n')
  await reject('import', { path: invalid }, 400, /YAML frontmatter/u)
  await reject('import', { path: source + '\\..\\' + id }, 400, /Windows Skill 文件夹路径/u)
  const linked = join(dirname(home), 'junction-skill')
  await put(join(linked, 'SKILL.md'), skillText('junction-skill', 'LINK_ESCAPE'))
  await symlink(join(source, 'references'), join(linked, 'references'), 'junction')
  await reject('import', { path: linked }, 409, /普通文件或目录/u)
  await assert.rejects(access(join(home, 'skills', 'junction-skill')), { code: 'ENOENT' })
  await put(join(process.env.DSH_AGENTS_HOME, skillPath(id)), skillText(id, 'LOWER_PRECEDENCE'))
  await reject('bind', { profileId: 'short-drama', stageId: storyboard, skillId: id }, 409, /同名来源.*user-dsh.*user-agents/u)
  await rm(join(process.env.DSH_AGENTS_HOME, skillPath(id)))
  await appendFile(discovered.path, 'EDITED_AFTER_IMPORT\n')
  const edited = (await success('detail', { skillId: id })).skill
  assert.equal(edited.userModified, true)
  assert.match(edited.content, /EDITED_AFTER_IMPORT/u)
  assert.notEqual(edited.hash, first.skill.hash)
  log('PASS native Skill Library list/detail/refresh, imported resource reads, conflict and junction protection, edit and clone')
}

async function footprint(home, paths) {
  return new Map(await Promise.all(paths.map(async path => {
    const file = join(home, path)
    return [path, { hash: digest(await readFile(file)), mtimeNs: (await stat(file, { bigint: true })).mtimeNs }]
  })))
}

async function makeUpgrade(repo, root) {
  const dir = join(root, 'upgrade-package')
  await mkdir(join(dir, 'dist'), { recursive: true })
  await Promise.all([
    cp(join(repo, 'resources'), join(dir, 'resources'), { recursive: true }),
    ...['host.js', 'studio.exe'].map(name => copyFile(join(repo, 'dist', name), join(dir, 'dist', name))),
  ])
  const manifest = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'))
  await writeFile(join(dir, 'package.json'), JSON.stringify({ ...manifest, version: testVersion }))
  for (const stage of [storyboard, upgraded]) {
    for (const target of stageTargets(stage)) {
      const source = target.startsWith('skills') ? target : target.slice('drama-studio/'.length)
      await appendFile(join(dir, 'resources', source), '\nBUNDLED_UPGRADE\n')
    }
  }
  const [reference, template, script] = bundledResources
  for (const path of [reference, template]) await appendFile(join(dir, 'resources', path), '\nBUNDLED_UPGRADE\n')
  const manifestPath = join(dir, 'resources', 'manifest.json')
  const resources = JSON.parse(await readFile(manifestPath, 'utf8'))
  resources.assets = resources.assets.filter(asset => asset.source !== script)
  await writeFile(manifestPath, JSON.stringify(resources))
  await rm(join(dir, 'resources', script))
  return join(dir, 'dist', 'host.js')
}

async function preparePackedProfile(home, archive, sourceFixture) {
  const listing = execFileSync('tar.exe', ['-tf', archive], { encoding: 'utf8', windowsHide: true }).trimEnd().split(/\r?\n/u)
  assert.ok(listing.every(path => path.startsWith('package/') && !/[\\:]/u.test(path) &&
    path.split('/').every(part => part !== '..')), 'Unexpected archive member')
  for (const path of ['dist/host.js', 'dist/client.js', 'dist/studio.exe', 'dsh.bundle.patch', 'resources/manifest.json',
    ...bundledResources.map(resource => 'resources/' + resource)]) {
    assert.ok(listing.includes('package/' + path), 'Missing packaged entry ' + path)
  }
  const profile = join(home, 'profiles', 'web')
  const nodeModules = join(profile, 'node_modules')
  await mkdir(nodeModules, { recursive: true })
  const fixture = join(profile, 'fixture.mjs')
  await copyFile(sourceFixture, fixture)
  execFileSync('tar.exe', ['-xf', archive, '-C', nodeModules], { windowsHide: true })
  const packageDir = join(nodeModules, packageName)
  await rename(join(nodeModules, 'package'), packageDir)
  const { version } = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
  await writeFile(join(home, 'package.json'), JSON.stringify({ name: 'drama-pack-home', private: true }))
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true, dependencies: { [packageName]: version },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', packageName] } },
  }))
  await writeFile(join(profile, 'cordis.patch.yml'), [
    '- insert:', '    - id: ' + name, '      name: ' + JSON.stringify(fixture.replaceAll('\\', '/')),
  ].join('\n') + '\n')
  console.info('PACK archive contains ' + listing.length + ' entries')
}

async function run() {
  assert.equal(process.platform + '/' + process.arch, 'win32/x64')
  const repo = fileURLToPath(new URL('../', import.meta.url))
  const args = process.argv.slice(2)
  const archive = args.length === 2 && args[0] === '--pack' ? resolve(args[1]) : undefined
  assert.ok(!args.length || archive, 'Usage: node tests/built-in-assets-host.mjs [--pack archive.tgz]')
  const host = join(repo, 'dist', 'host.js')
  if (!archive) {
    await access(host)
    await access(join(repo, 'dist', 'studio.exe'))
  }
  const desktop = join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness')
  const customCLI = process.env.DRAMA_DSH_CLI
  const executable = customCLI ? process.execPath : join(desktop, 'DeepSeek Harness.exe')
  const cli = customCLI ? [resolve(customCLI)] : [
    '--expose-internals', join(desktop, 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'),
  ]
  await access(executable)
  const scratch = resolve(tmpdir())
  const root = await mkdtemp(join(scratch, 'drama-built-in-host-'))
  const overlay = join(root, 'fixture.yml')
  const yamlPath = path => JSON.stringify(path.replaceAll('\\', '/'))
  const fixture = fileURLToPath(import.meta.url)
  const homeFor = scenario => join(root, 'home-' + scenario)
  const fresh = homeFor('fresh')
  const owned = homeFor('user-owned')
  const recovered = skillPath('drama-content-analysis')
  const customFiles = ['custom-folder/user-file.txt', join(workflowDir, 'stages', 'user-stage', 'harness.md')]
  const paths = [ledgerPath, 'drama-studio/skill-imports.json', ...customFiles, skillPath(ordinary), skillPath(custom),
    skillPath(imported), ...managedStages.flatMap(stageTargets), ...bundledResources,
    ...relativeResources.flatMap(path => [resourceTarget(custom, path), resourceTarget(imported, path)])]
  const changedOnUpgrade = new Set([ledgerPath, ...stageTargets(upgraded), bundledResources[1]])
  const preservedOnUpgrade = paths.filter(path => !changedOnUpgrade.has(path))
  let first
  let deniedDirectory
  let sid
  try {
    for (const [scenario, proof] of Object.entries(archive ? {
      packed: 'packed Host read all three resources through native DSH tools',
    } : {
      fresh: 'invalid or missing mapping rejected',
      repeat: 'complete capabilities after repeat start',
      recovery: 'complete capabilities after recovery start',
      upgrade: 'preserved both user-edited files',
      'user-owned': 'activated in second DSH Home',
      blocked: 'leaves ordinary DSH chat available',
      'blocked-target': 'blocks only its stage and preserves ordinary DSH chat and user bytes',
      'denied-target': 'write denial leaves no formal file and ordinary DSH chat still works',
    })) {
      const oldHome = ['repeat', 'recovery', 'upgrade'].includes(scenario)
      const home = oldHome ? fresh : homeFor(scenario)
      let entry = host
      let beforeUpgrade
      if (!oldHome) await mkdir(home)
      if (scenario === 'repeat') {
        for (const path of customFiles) await put(join(home, path), 'Private fixture: ' + path)
        first = await footprint(home, paths)
      }
      if (scenario === 'recovery') await rm(join(home, recovered))
      if (scenario === 'upgrade') {
        entry = await makeUpgrade(repo, root)
        for (const target of [...stageTargets(storyboard), bundledResources[0]]) {
          await appendFile(join(home, target), '\nUSER_EDITED\n')
        }
        beforeUpgrade = await footprint(home, preservedOnUpgrade)
      }
      if (scenario === 'user-owned') {
        await put(join(home, skillPath('drama-storyboard')),
          skillText('drama-storyboard', 'USER_OWNED_RULES', 'disable-model-invocation: true\n'))
      }
      if (scenario === 'blocked') await put(join(home, ledgerPath), '{invalid ledger')
      if (scenario === 'blocked-target') await put(join(home, bundledResources[2], 'private.txt'), 'User directory contents\n')
      if (scenario === 'denied-target') {
        sid = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true })
          .match(/S-1-(?:\d+-)*\d+/u)?.[0]
        assert.ok(sid, 'Windows current-user SID')
        deniedDirectory = dirname(join(home, bundledResources[2]))
        await mkdir(deniedDirectory, { recursive: true })
        execFileSync('icacls.exe', [deniedDirectory, '/deny', `*${sid}:(WD,AD)`], { windowsHide: true })
      }
      if (archive) {
        await preparePackedProfile(home, archive, fixture)
      } else {
        await writeFile(overlay, '- insert:\n' +
          '    - id: my-drama-studio\n      name: ' + yamlPath(entry) + '\n' +
          '    - id: ' + name + '\n      name: ' + yamlPath(fixture) + '\n')
      }
      const child = spawn(executable, [...cli, 'web', ...(archive ? [] : ['--patch', overlay]),
        '--host', '127.0.0.1', '--port', '0', '--no-open'], {
        cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env, ...(customCLI ? {} : { ELECTRON_RUN_AS_NODE: '1' }),
          DSH_HOME: home, DSH_AGENTS_HOME: join(root, 'agents-' + scenario),
          DSH_TELEMETRY_DISABLED: '1', DSH_TOOLS_MODE: 'native', DEEPSEEK_API_KEY: '', DRAMA_REAL_WORKFLOW: '',
          DRAMA_BUILT_IN_SCENARIO: scenario,
        },
      })
      const exited = once(child, 'exit')
      const wait = new AbortController()
      let logs = ''
      for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { logs += data.toString() })
      try {
        await Promise.race([exited, until(() => logs.includes(proof) || logs.includes('[' + name + '] FAIL'), wait.signal, proof, 60_000)])
        assert.ok(logs.includes(proof), 'Missing ' + proof)
        for (const line of logs.split(/\r?\n/u)) {
          if (line.startsWith('[' + name + '] PASS') || line.startsWith('[' + name + '] PACK')) console.info(line)
        }
      } catch (error) {
        console.error(logs.replace(/(https?:\/\/[^\s?'"<>]+)\?[^\s'"<>]+/gu, '$1?[redacted]'))
        throw error
      } finally {
        wait.abort()
        if (child.exitCode === null) child.kill()
        await exited
      }
      if (scenario === 'repeat') {
        assert.deepEqual(await footprint(home, paths), first)
        log('PASS identical hashes and mtimes on recheck, with custom Skill, Harness and ordinary file preserved')
      }
      if (scenario === 'recovery') {
        const current = await footprint(home, paths)
        assert.equal(current.get(recovered).hash, first.get(recovered).hash)
        current.delete(recovered)
        first.delete(recovered)
        assert.deepEqual(current, first)
        log('PASS removed Skill restored with all other managed and private files unchanged')
      }
      if (beforeUpgrade) assert.deepEqual(await footprint(home, preservedOnUpgrade), beforeUpgrade)
    }
    if (archive) return
    assert.doesNotMatch(await readFile(join(fresh, skillPath('drama-storyboard')), 'utf8'), /USER_OWNED_RULES/u)
    assert.match(await readFile(join(owned, skillPath('drama-storyboard')), 'utf8'), /USER_OWNED_RULES/u)
    assert.notEqual((await stat(join(fresh, ledgerPath))).ino, (await stat(join(owned, ledgerPath))).ino)
    assert.equal(await readFile(join(homeFor('blocked'), ledgerPath), 'utf8'), '{invalid ledger')
    log('PASS isolated Home writes and ledgers')
  } finally {
    assert.equal(dirname(root), scratch)
    assert.ok(basename(root).startsWith('drama-built-in-host-'))
    if (deniedDirectory) execFileSync('icacls.exe', [deniedDirectory, '/remove:d', `*${sid}`], { windowsHide: true })
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await run()
