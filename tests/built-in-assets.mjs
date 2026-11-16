import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, rmdir, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { assetStatus, ensureBuiltInAssets, sha256, skillResourceStatuses } from '../src/capability-assets.js'

const repo = fileURLToPath(new URL('..', import.meta.url))
const managedFile = 'drama-studio/managed-assets.json'
const storyboard = 'skills/drama-storyboard/SKILL.md'
const harness = 'drama-studio/workflows/drama-production/stages/storyboard/harness.md'
const shooting = 'skills/drama-shooting-script/SKILL.md'
const mapping = 'drama-studio/workflows/drama-production/stage-skills.json'
const reference = 'skills/drama-storyboard/references/shot-sizes.md'
const template = 'skills/drama-storyboard/templates/storyboard.md'
const script = 'skills/drama-storyboard/scripts/check.js'
const readJSON = async path => JSON.parse(await readFile(path, 'utf8'))
const runFile = promisify(execFile)

async function write(path, bytes) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'drama-assets-test-'))
  t.after(async () => {
    assert.equal(dirname(root), tmpdir())
    assert.ok(basename(root).startsWith('drama-assets-test-'))
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  })
  const home = join(root, 'home')
  const bundle = join(root, 'bundle')
  const resources = join(bundle, 'resources')
  await mkdir(home)
  await cp(join(repo, 'resources'), resources, { recursive: true })
  const manifestPath = join(resources, 'manifest.json')
  const { assets } = await readJSON(manifestPath)
  const ctx = {
    profileContext: { home },
    get: name => name === 'pluginPackages' && {
      packageOf: () => ({ dir: bundle, version: '0.1.0' }),
    },
  }
  const start = async (version = '0.1.0') => {
    const state = await ensureBuiltInAssets({
      ...ctx, get: () => ({ packageOf: () => ({ dir: bundle, version }) }),
    })
    assert.equal(state.failure, undefined, state.failure?.error)
    assert.deepEqual([...state.errors.values()], [])
    return readJSON(join(home, managedFile))
  }
  return { root, home, resources, manifestPath, assets, ctx, start }
}

test('A/B/C/F — clean install, concurrent/idempotent startup, custom file protection and deletion recovery', async t => {
  const { home, resources, assets, start } = await fixture(t)
  const userFiles = {
    'skills/custom/SKILL.md': 'Custom Skill',
    'drama-studio/workflows/custom/harness.md': 'Custom Harness',
    [mapping]: '{"storyboard":"custom"}',
    'outside/custom/artifact.md': 'Custom file',
  }
  for (const [target, bytes] of Object.entries(userFiles)) await write(join(home, target), bytes)
  const [first, second] = await Promise.all([start(), start()])
  assert.deepEqual(first, second)
  assert.equal(Object.keys(first.assets).length, 17)
  for (const asset of assets) {
    const bytes = await readFile(join(resources, asset.source))
    assert.deepEqual(await readFile(join(home, asset.target)), bytes)
    assert.deepEqual(first.assets[asset.id], { target: asset.target, installedHash: sha256(bytes), status: 'managed' })
  }
  const paths = [...assets.map(item => item.target), ...Object.keys(userFiles), managedFile]
  const mtimes = async paths => Promise.all(paths.map(async file => (await stat(join(home, file), { bigint: true })).mtimeNs))
  const before = await mtimes(paths)
  assert.deepEqual(await start(), first)
  assert.deepEqual(await mtimes(paths), before)
  const index = paths.indexOf(storyboard)
  await rm(join(home, storyboard))
  assert.deepEqual(await start(), first)
  assert.deepEqual(await readFile(join(home, storyboard)), await readFile(join(resources, storyboard)))
  assert.deepEqual(await mtimes(paths.filter((_, i) => i !== index)), before.filter((_, i) => i !== index))
  for (const [target, bytes] of Object.entries(userFiles)) assert.equal(await readFile(join(home, target), 'utf8'), bytes)
})

test('D/E/G — Windows atomic upgrades preserve user edits and previously owned files', async t => {
  const { home, resources, assets, start } = await fixture(t)
  const ownTarget = 'skills/drama-final-review/SKILL.md'
  const sameTarget = 'skills/drama-video-generation/SKILL.md'
  const userBytes = Buffer.from('Previously owned file')
  const editedBytes = Buffer.from('Edited by user')
  const upgradedBytes = Buffer.from('Upgraded official file')
  const entry = (records, target) => records.assets[assets.find(asset => asset.target === target).id]
  await write(join(home, ownTarget), userBytes)
  await write(join(home, sameTarget), await readFile(join(resources, sameTarget)))
  const before = await start()
  assert.equal(entry(before, ownTarget).status, 'user-owned')
  assert.equal(entry(before, sameTarget).status, 'managed')
  await write(join(home, storyboard), editedBytes)
  await write(join(home, harness), editedBytes)
  assert.equal(entry(await start(), storyboard).status, 'user-modified')
  for (const target of [storyboard, shooting, ownTarget, harness]) {
    await write(join(resources, assets.find(asset => asset.target === target).source), upgradedBytes)
  }
  const after = await start('0.2.0')
  assert.equal(after.packageVersion, '0.2.0')
  for (const target of [storyboard, harness]) {
    assert.deepEqual(await readFile(join(home, target)), editedBytes)
    assert.equal(entry(after, target).status, 'update-available')
    assert.equal(entry(after, target).installedHash, entry(before, target).installedHash)
  }
  assert.deepEqual(await readFile(join(home, ownTarget)), userBytes)
  assert.equal(entry(after, ownTarget).status, 'user-owned')
  assert.deepEqual(await readFile(join(home, shooting)), upgradedBytes)
  assert.equal(entry(after, shooting).installedHash, sha256(upgradedBytes))
  for (const { target } of assets.filter(({ target }) => ![storyboard, shooting, ownTarget, harness].includes(target))) {
    assert.deepEqual(entry(after, target), entry(before, target))
  }
})

test('Invalid manifests and management records prevent writes', async t => {
  const { assets, ctx, home, manifestPath } = await fixture(t)
  const altered = { schemaVersion: 1, assets: [{ ...assets[0], target: '../escaped.md' }, ...assets.slice(1)] }
  await writeFile(manifestPath, JSON.stringify(altered))
  let result = await ensureBuiltInAssets(ctx)
  assert.equal(result.failure.status, 'invalid')
  await assert.rejects(readFile(join(home, managedFile)), { code: 'ENOENT' })
  await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, assets }))
  await write(join(home, managedFile), '{broken')
  result = await ensureBuiltInAssets(ctx)
  assert.equal(result.failure.status, 'invalid')
  assert.equal(await readFile(join(home, managedFile), 'utf8'), '{broken')
  await assert.rejects(readFile(join(home, storyboard)), { code: 'ENOENT' })
})

test('A redirected stage directory is reported as a conflict and leaves external files intact', async t => {
  const { ctx, root, home } = await fixture(t)
  const external = join(root, 'outside')
  const localDirectory = dirname(join(home, storyboard))
  await write(join(external, 'SKILL.md'), 'External file')
  await mkdir(dirname(localDirectory))
  await symlink(external, localDirectory, process.platform === 'win32' ? 'junction' : 'dir')
  const result = await ensureBuiltInAssets(ctx)
  assert.equal(result.failure, undefined)
  assert.equal(result.errors.get(storyboard)?.status, 'conflict')
  assert.equal(await readFile(join(external, 'SKILL.md'), 'utf8'), 'External file')
  assert.equal(assetStatus(result, shooting, sha256(await readFile(join(home, shooting)))).status, 'ready')
})

test('Skill resources share the ledger, preserve edits and unknown files, and are never executed', async t => {
  const { home, resources, assets, start, ctx, manifestPath } = await fixture(t)
  const marker = join(home, 'script-was-executed')
  const scriptSource = `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed')\n`
  await writeFile(join(resources, script), scriptSource)
  const initiallyOwned = 'Pre-existing reference'
  const unlisted = 'skills/drama-storyboard/templates/my-template.md'
  await write(join(home, reference), initiallyOwned)
  await write(join(home, unlisted), 'Private template')
  const entry = (records, target) => records.assets[assets.find(asset => asset.target === target).id]
  const first = await start()
  assert.equal(entry(first, reference).status, 'user-owned')
  const modified = 'Locally edited template'
  await writeFile(join(home, template), modified)
  await writeFile(join(resources, template), 'New official template')
  const newScriptSource = scriptSource + '// version 2'
  await writeFile(join(resources, script), newScriptSource)
  const next = await start('0.2.0')
  assert.equal(entry(next, template).status, 'update-available')
  assert.equal(entry(next, script).installedHash, sha256(newScriptSource))
  assert.equal(await readFile(join(home, script), 'utf8'), newScriptSource)
  assert.equal(await readFile(join(home, template), 'utf8'), modified)
  assert.equal(await readFile(join(home, reference), 'utf8'), initiallyOwned)
  assert.equal(await readFile(join(home, unlisted), 'utf8'), 'Private template')
  await assert.rejects(readFile(marker), { code: 'ENOENT' })
  const statuses = skillResourceStatuses(await ensureBuiltInAssets(ctx), 'drama-storyboard')
  const owned = statuses.find(status => status.path === join(home, reference))
  assert.equal(owned.status, 'user-owned')
  assert.match(owned.note, /同路径已有异版/u)
  await rm(join(home, script))
  await start()
  assert.equal(await readFile(join(home, script), 'utf8'), newScriptSource)
  await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, assets: assets.filter(asset => asset.target !== script) }))
  const removed = await start()
  assert.equal(entry(removed, script).status, 'deprecated')
  assert.equal(await readFile(join(home, script), 'utf8'), newScriptSource)
})

test('Skill resources reject Windows aliases and escapes, including case-only duplicates and Junctions', async t => {
  const { home, root, ctx, resources, assets, manifestPath } = await fixture(t)
  const original = assets.find(asset => asset.target === reference)
  async function changeAsset(changes) {
    const updated = { ...original, ...changes }
    await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, assets: [...assets, updated] }))
    const result = await ensureBuiltInAssets(ctx)
    assert.equal(result.failure?.status, 'invalid', result.failure?.error)
    await assert.rejects(readFile(join(home, managedFile)), { code: 'ENOENT' })
  }
  for (const suffix of [
    '../other.md', 'references/../other.md', 'references\\shot-sizes.md', 'references/con.txt',
    'references/shot-sizes.md.', 'REFERENCES/shot-sizes.md', 'references/name:stream',
  ]) {
    const target = 'skills/drama-storyboard/' + suffix
    await changeAsset({ id: 'skill-resource:drama-storyboard/' + suffix, source: target, target })
  }
  await changeAsset({ source: 'skills/drama-content-analysis/SKILL.md' })
  await changeAsset({ target: 'skills/drama-final-review/unlisted.md' })
  await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, assets }))
  const outside = join(root, 'external-reference')
  const rootReference = dirname(join(resources, reference))
  await write(join(outside, basename(reference)), 'External reference')
  await rm(join(resources, reference))
  await rmdir(rootReference)
  await symlink(outside, rootReference, 'junction')
  let result = await ensureBuiltInAssets(ctx)
  assert.equal(result.failure?.status, 'conflict')
  await assert.rejects(readFile(join(home, managedFile)), { code: 'ENOENT' })
  await rm(rootReference)
  await write(join(resources, reference), 'Packaged reference')
  const homeReference = dirname(join(home, reference))
  await mkdir(dirname(homeReference), { recursive: true })
  await symlink(outside, homeReference, 'junction')
  result = await ensureBuiltInAssets(ctx)
  assert.equal(result.failure, undefined)
  assert.equal(result.errors.get(reference)?.status, 'conflict')
  assert.equal(skillResourceStatuses(result, 'drama-storyboard').find(asset => asset.path === join(home, reference))?.status, 'conflict')
  assert.equal(await readFile(join(outside, basename(reference)), 'utf8'), 'External reference')
})

async function heldProcess(t, command, args, env) {
  const child = spawn(command, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const exited = once(child, 'exit')
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  async function stop() {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
  }
  t.after(stop)
  const lines = createInterface({ input: child.stdout })
  try {
    const [ready] = await Promise.race([
      once(lines, 'line', { signal: AbortSignal.timeout(10_000) }),
      exited.then(() => { throw new Error('Lock fixture exited early: ' + stderr) }),
    ])
    assert.equal(ready, 'HELD')
  } finally {
    lines.close()
  }
  return stop
}

function holdFile(t, path, share) {
  return heldProcess(t, 'powershell.exe', ['-NoProfile', '-Command', `
    $ErrorActionPreference = 'Stop'
    $handle = [System.IO.File]::Open($env:DRAMA_TEST_ASSET, 'Open', 'Read', $env:DRAMA_TEST_SHARE)
    try { [Console]::WriteLine('HELD'); [void][Console]::ReadLine() } finally { $handle.Dispose() }
  `], { ...process.env, DRAMA_TEST_ASSET: path, DRAMA_TEST_SHARE: share })
}

test('Windows process termination releases the actual Bootstrap lock, and a live owner cannot be displaced', async t => {
  const { home, ctx, root, start } = await fixture(t)
  const old = await start()
  const ledger = join(await realpath(home), managedFile)
  const child = `
    import fs, { writeSync } from 'node:fs'
    import { syncBuiltinESMExports } from 'node:module'
    import { ensureBuiltInAssets } from ${JSON.stringify(new URL('../src/capability-assets.js', import.meta.url).href)}
    const read = fs.readFileSync
    fs.readFileSync = (path, ...args) => {
      if (path === ${JSON.stringify(ledger.replaceAll('/', '\\'))}) {
        writeSync(1, 'HELD\\n')
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
      }
      return read(path, ...args)
    }
    syncBuiltinESMExports()
    const result = await ensureBuiltInAssets({
      profileContext: { home: ${JSON.stringify(home)} },
      get: () => ({ packageOf: () => ({ dir: ${JSON.stringify(join(root, 'bundle'))}, version: '0.1.0' }) }),
    })
    if (result.failure) throw Error(result.failure.error)
  `
  const stop = await heldProcess(t, process.execPath, ['--input-type=module', '--eval', child], process.env)
  assert.equal((await ensureBuiltInAssets(ctx)).failure?.status, 'blocked')
  assert.deepEqual(await readJSON(join(home, managedFile)), old)
  await stop()
  const file = managedFile + '.lock'
  await assert.rejects(readFile(join(home, file)), { code: 'ENOENT' })
  assert.deepEqual(await start(), old)
  await write(join(home, file), '')
  const legacy = await ensureBuiltInAssets(ctx)
  assert.equal(legacy.failure?.status, 'blocked')
  assert.match(legacy.failure.error, /旧版装填锁/u)
  assert.equal(await readFile(join(home, file), 'utf8'), '')
  await rm(join(home, file))
  assert.deepEqual(await start(), old)
})

test('A/B — interrupted ledger replacement adopts current package bytes without rewriting and protects different bytes', async t => {
  const { home, resources, ctx, start, assets } = await fixture(t)
  const first = await start()
  const record = target => assets.find(entry => entry.target === target).id
  const replacement = 'Changed official bytes after restarting with V2\n'
  const userEdit = 'Independently edited bytes\n'
  await writeFile(join(resources, reference), replacement)
  await writeFile(join(resources, template), replacement)
  await writeFile(join(home, template), userEdit)
  const stop = await holdFile(t, join(home, managedFile), 'Read')
  const failed = await ensureBuiltInAssets(ctx)
  assert.equal(failed.failure?.status, 'blocked')
  assert.equal(failed.failure.path, join(home, managedFile))
  assert.deepEqual(await readJSON(join(home, managedFile)), first)
  assert.equal(await readFile(join(home, reference), 'utf8'), replacement)
  const writtenAt = (await stat(join(home, reference), { bigint: true })).mtimeNs
  await stop()
  const recovered = await start('0.2.0')
  assert.deepEqual(recovered.assets[record(reference)], { target: reference, installedHash: sha256(replacement), status: 'managed' })
  assert.equal((await stat(join(home, reference), { bigint: true })).mtimeNs, writtenAt)
  assert.equal(recovered.assets[record(template)].status, 'update-available')
  assert.equal(await readFile(join(home, template), 'utf8'), userEdit)
  await rm(join(home, reference))
  assert.deepEqual(await start('0.2.0'), recovered)
  await writeFile(join(home, reference), 'truncated')
  const inconsistent = await start('0.2.0')
  assert.equal(inconsistent.assets[record(reference)].status, 'user-modified')
  assert.equal(await readFile(join(home, reference), 'utf8'), 'truncated')
})

test('D — real Windows read/share/write denial preserves formal files and can be retried', async t => {
  const { home, resources, ctx, start, manifestPath } = await fixture(t)
  const readDenied = await holdFile(t, manifestPath, 'None')
  assert.equal((await ensureBuiltInAssets(ctx)).failure?.status, 'blocked')
  await assert.rejects(readFile(join(home, managedFile)), { code: 'ENOENT' })
  await readDenied()
  await start()
  const body = await readFile(join(home, reference))
  await writeFile(join(resources, reference), 'Shipped version after failure')
  const replaceDenied = await holdFile(t, join(home, reference), 'Read')
  let result = await ensureBuiltInAssets(ctx)
  assert.equal(result.errors.get(reference)?.status, 'blocked')
  assert.deepEqual(await readFile(join(home, reference)), body)
  assert.deepEqual(await readdir(dirname(join(home, reference))), [basename(reference)])
  await replaceDenied()
  await start()
  assert.equal(await readFile(join(home, reference), 'utf8'), 'Shipped version after failure')

  const directory = dirname(join(home, script))
  await rm(join(home, script))
  const { stdout } = await runFile('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true })
  const sid = stdout.match(/S-1-(?:\d+-)*\d+/u)?.[0]
  assert.ok(sid, 'Windows current-user SID')
  await runFile('icacls.exe', [directory, '/deny', `*${sid}:(WD,AD)`], { windowsHide: true })
  try {
    result = await ensureBuiltInAssets(ctx)
    assert.equal(result.errors.get(script)?.status, 'blocked')
    await assert.rejects(readFile(join(home, script)), { code: 'ENOENT' })
  } finally {
    await runFile('icacls.exe', [directory, '/remove:d', `*${sid}`], { windowsHide: true })
  }
  await start()
  assert.deepEqual(await readFile(join(home, script)), await readFile(join(resources, script)))
})
