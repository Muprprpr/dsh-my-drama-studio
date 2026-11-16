import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, isAbsolute, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const packageName = 'dsh-my-drama-studio'
const workflowId = 'drama-production'
const stateTarget = 'drama-studio/managed-assets.json'
const schemaVersion = 1
export const stageIds = [
  'content-analysis', 'shooting-script', 'storyboard', 'asset-binding',
  'video-deployment', 'video-generation', 'final-review',
]
const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const skillDirectory = name => `skills/${name}/`
export const skillTarget = name => skillDirectory(name) + 'SKILL.md'
export const workflowTarget = (workflow, path) => `drama-studio/workflows/${workflow}/${path}`
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

function fail(status, message) {
  return Object.assign(new Error(message), { assetStatus: status })
}

function problem(error, path) {
  return {
    status: error.assetStatus ?? 'blocked', path,
    error: error.assetStatus ? error.message : `无法访问能力文件：${path}（${error.code ?? 'IO_ERROR'}）`,
  }
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

// Walk only the declared path, rejecting redirected parents and non-files.
function checkParents(root, target, create) {
  let directory = root
  for (const part of target.split('/').slice(0, -1)) {
    directory = resolve(directory, part)
    let info = lstatSync(directory, { throwIfNoEntry: false })
    if (!info && create) {
      try {
        mkdirSync(directory)
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
      }
      info = lstatSync(directory)
    }
    if (!info) return
    if (!info.isDirectory() || info.isSymbolicLink()) throw fail('conflict', `能力目录冲突：${directory}`)
  }
}

function readRegular(root, target, maxBytes = 1024 * 1024) {
  checkParents(root, target, false)
  const path = resolve(root, target)
  const info = lstatSync(path, { throwIfNoEntry: false })
  if (!info) return
  if (!info.isFile() || info.isSymbolicLink()) throw fail('conflict', `能力文件路径冲突：${path}`)
  if (info.size > maxBytes) throw fail('invalid', `能力文件过大：${path}`)
  return readFileSync(path)
}

function readJSON(bytes, path) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/u, ''))
  } catch {
    throw fail('invalid', `能力配置须为有效的 UTF-8 JSON：${path}`)
  }
}

function validResourcePath(relativePath) {
  return relativePath.split('/').every(part =>
    part === part.trim() && /^[\p{L}\p{N}_-][\p{L}\p{N}._-]*$/u.test(part) && !part.endsWith('.') &&
    !/^(?:skill\.md$|(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$))/iu.test(part))
}

function readBundle(ctx) {
  const hostPackage = ctx.get('pluginPackages')?.packageOf?.(packageName, import.meta.url)
  const packageDir = hostPackage?.dir ?? fileURLToPath(new URL('..', import.meta.url))
  const packageInfo = hostPackage ?? readJSON(readFileSync(resolve(packageDir, 'package.json')), resolve(packageDir, 'package.json'))
  const manifestPath = resolve(packageDir, 'resources', 'manifest.json')
  if (typeof packageInfo.version !== 'string' || !packageInfo.version) throw fail('invalid', `缺少插件版本：${packageDir}`)
  const resourceDir = resolve(packageDir, 'resources')
  const info = lstatSync(resourceDir, { throwIfNoEntry: false })
  if (!info) throw fail('missing', `内置资源目录缺失：${resourceDir}`)
  if (!info.isDirectory() || info.isSymbolicLink()) throw fail('conflict', `内置资源目录冲突：${resourceDir}`)
  const root = realpathSync(resourceDir)
  const manifestBytes = readRegular(root, 'manifest.json')
  if (!manifestBytes) throw fail('missing', `内置资源清单缺失：${manifestPath}`)
  const manifest = readJSON(manifestBytes, manifestPath)
  if (manifest?.schemaVersion !== schemaVersion || !Array.isArray(manifest.assets)) {
    throw fail('invalid', `不支持的内置资源清单：${manifestPath}`)
  }

  const assets = new Map()
  const ids = new Set()
  const targets = new Set()
  let primaryCount = 0
  for (const item of manifest.assets) {
    if (!item || !stageIds.includes(item.stageId) || !['skill', 'harness', 'skill-resource'].includes(item.type)) {
      throw fail('invalid', `清单包含未知的阶段或资源类型：${manifestPath}`)
    }
    const name = 'drama-' + item.stageId
    const ancillary = item.type === 'skill-resource'
    const prefix = skillDirectory(name)
    const suffix = typeof item.target === 'string' && item.target.startsWith(prefix) && item.target.slice(prefix.length)
    if (ancillary && (!suffix || !validResourcePath(suffix))) {
      throw fail('invalid', `附属资源必须位于对应 Skill 目录：${manifestPath}（${name}）`)
    }
    const target = ancillary ? prefix + suffix : item.type === 'skill'
      ? skillTarget(name) : workflowTarget(workflowId, `stages/${item.stageId}/harness.md`)
    const source = item.type === 'harness' ? target.slice('drama-studio/'.length) : target
    const id = item.type + ':' + (ancillary ? name + '/' + suffix : item.type === 'skill' ? name : item.stageId)
    const targetKey = target.toUpperCase()
    if (item.id !== id || item.source !== source || item.target !== target || ids.has(id) || targets.has(targetKey)) {
      throw fail('invalid', `清单资源重复或路径与阶段不匹配：${manifestPath}（${id}）`)
    }
    const path = resolve(root, source)
    const bytes = readRegular(root, source, ancillary ? undefined : item.type === 'skill' ? 512 * 1024 : 64 * 1024)
    if (!bytes) throw fail('missing', `内置资源文件缺失：${path}`)
    if (!ancillary) {
      let body
      try {
        body = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim()
      } catch {
        throw fail('invalid', `内置资源须为 UTF-8：${path}`)
      }
      if (!body) throw fail('invalid', `内置资源内容为空：${path}`)
      primaryCount++
    }
    assets.set(target, { id, target, bytes, hash: sha256(bytes), ...(ancillary && { skill: name }) })
    ids.add(id)
    targets.add(targetKey)
  }
  if (primaryCount !== stageIds.length * 2) throw fail('missing', `内置资源清单必须覆盖全部阶段的 Skill 和 Harness：${manifestPath}`)
  return { assets, packageVersion: packageInfo.version }
}

function readRecords(bytes, path) {
  if (!bytes) return {}
  const state = readJSON(bytes, path)
  if (state?.schemaVersion !== schemaVersion || !object(state.assets) || Object.values(state.assets).some(entry =>
    !object(entry) || typeof entry.target !== 'string' ||
    (entry.installedHash !== undefined &&
      (typeof entry.installedHash !== 'string' || entry.installedHash.length !== 64 || !/^[0-9a-f]{64}$/u.test(entry.installedHash))))) {
    throw fail('invalid', `管理记录格式无效：${path}`)
  }
  return state.assets
}

function atomicWrite(root, target, bytes, previousHash) {
  checkParents(root, target, true)
  const path = resolve(root, target)
  const temporary = resolve(dirname(path), `.drama-${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', flush: true })
    if (!readFileSync(temporary).equals(bytes)) throw fail('blocked', `能力文件写入校验失败：${path}`)
    if (previousHash === undefined) {
      // An editor or another installer may have created the target meanwhile.
      linkSync(temporary, path)
    } else {
      const current = readRegular(root, target)
      if (!current || sha256(current) !== previousHash) throw fail('conflict', `能力文件在更新时发生变化：${path}`)
      renameSync(temporary, path)
    }
  } finally {
    try {
      unlinkSync(temporary)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
}

function ownership(asset, record, hash) {
  if (!asset) return 'custom'
  if (!record) return hash === asset.hash ? 'ready' : 'user-owned'
  if (!record.installedHash) return 'user-owned'
  if (hash === record.installedHash || hash === asset.hash) return 'ready'
  return asset.hash === record.installedHash ? 'user-modified' : 'update-available'
}

async function lockAssets(root) {
  if (process.platform !== 'win32') throw fail('blocked', '内置能力装填需要 Windows Host')
  const lock = stateTarget + '.lock'
  const path = resolve(root, lock)
  const server = createServer(socket => socket.destroy())
  // Windows releases the named pipe even if its owner is terminated.
  const address = '\\\\.\\pipe\\dsh-my-drama-studio-assets-' + sha256(root.toLowerCase())
  for (let attempt = 0; ; attempt++) {
    const listening = once(server, 'listening')
    server.listen(address)
    try {
      await listening
      break
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error
      if (attempt >= 30) throw fail('blocked', `另一个 Host 正在装填此 DSH Home 的能力：${root}`)
      await delay(100)
    }
  }
  const unlock = () => server[Symbol.asyncDispose]()
  try {
    checkParents(root, lock, false)
    // Older builds left an empty file with no way to verify the owner.
    if (lstatSync(path, { throwIfNoEntry: false })) {
      throw fail('blocked', `发现旧版装填锁。确认旧 Host 已全部退出后清理：${path}`)
    }
    return unlock
  } catch (error) {
    await unlock()
    throw error
  }
}

export async function ensureBuiltInAssets(ctx) {
  const state = { errors: new Map(), records: {} }
  let path = ctx.profileContext?.home
  try {
    if (typeof path !== 'string' || !isAbsolute(path)) throw fail('blocked', 'DSH Host 未提供有效的 DSH Home')
    const root = state.root = realpathSync(path)
    path = fileURLToPath(new URL('../resources', import.meta.url))
    Object.assign(state, readBundle(ctx))
    path = resolve(root, stateTarget)
    const unlock = await lockAssets(root)
    try {
      const previous = readRegular(root, stateTarget)
      const records = state.records = readRecords(previous, path)
      for (const asset of state.assets.values()) {
        const { id, target } = asset
        try {
          const record = Object.hasOwn(records, id) ? records[id] : undefined
          if (record && record.target !== target) throw fail('conflict', `管理记录目标与清单冲突：${resolve(root, target)}`)
          const current = readRegular(root, target)
          const hash = current && sha256(current)
          if (!current || (hash === record?.installedHash && hash !== asset.hash)) {
            atomicWrite(root, target, asset.bytes, hash)
            records[id] = { target, installedHash: asset.hash, status: 'managed' }
          } else {
            const status = ownership(asset, record, hash)
            records[id] = {
              target,
              installedHash: status === 'ready' ? hash : record?.installedHash,
              status: status === 'ready' ? 'managed' : status,
            }
          }
        } catch (error) {
          state.errors.set(target, problem(error, resolve(root, target)))
        }
      }
      const activeIds = new Set([...state.assets.values()].map(asset => asset.id))
      for (const [id, record] of Object.entries(records)) {
        if (!activeIds.has(id)) record.status = 'deprecated'
      }
      const next = Buffer.from(JSON.stringify({ schemaVersion, packageVersion: state.packageVersion, assets: records }, null, 2) + '\n')
      if (!previous?.equals(next)) atomicWrite(root, stateTarget, next, previous && sha256(previous))
    } finally {
      await unlock()
    }
  } catch (error) {
    state.failure = problem(error, error.dest ?? error.path ?? path)
  }
  return state
}

export function assetStatus(state, target, hash) {
  const path = resolve(state.root, target)
  const asset = state.assets.get(target)
  const record = asset && state.records[asset.id]
  return { status: ownership(asset, record, hash), path, hash }
}

export function skillResourceStatuses(state, name) {
  const results = []
  for (const asset of state.assets?.values() ?? []) {
    if (asset.skill !== name) continue
    const { target } = asset
    const path = resolve(state.root, target)
    const issue = state.errors.get(target)
    if (issue) {
      results.push(issue)
      continue
    }
    try {
      const bytes = readRegular(state.root, target)
      if (!bytes) throw fail('missing', `Skill 附属资源缺失：${path}`)
      const status = assetStatus(state, target, sha256(bytes))
      results.push(status.status === 'user-owned'
        ? { ...status, note: '同路径已有异版文件，已保留用户版本。' }
        : status)
    } catch (error) {
      results.push(problem(error, path))
    }
  }
  return results
}

export function readStageSkills(root) {
  const target = workflowTarget(workflowId, 'stage-skills.json')
  const path = resolve(root, target)
  try {
    const bytes = readRegular(root, target, 16 * 1024)
    if (!bytes) return { names: {} }
    const names = readJSON(bytes, path)
    if (!object(names) || Object.entries(names).some(([stage, name]) =>
      !stageIds.includes(stage) || typeof name !== 'string' || name !== name.trim() || !skillNamePattern.test(name))) {
      throw fail('invalid', `阶段 Skill 映射须使用固定阶段 ID 和有效的 Skill 名称：${path}`)
    }
    return { names }
  } catch (error) {
    return { failure: problem(error, path) }
  }
}
