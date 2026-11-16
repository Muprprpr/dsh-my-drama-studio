import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assetStatus, atomicWrite, problem, readJSON, readRegular, sha256, skillNamePattern,
  skillResourceStatuses, skillTarget, withHomeLock } from './capability-assets.js'
import { StudioError } from './kernel.js'
import { checkNativeSkill, fileError, localFile, verifyUnchanged } from './workflow-capability-files.js'

const ledgerTarget = 'drama-studio/skill-imports.json'
const ledgerLimit = 1024 * 1024
const main = 'SKILL.md'
const reservedName = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu
const samePath = (left, right) => resolve(left).toLowerCase() === resolve(right).toLowerCase()

function checkId(id) {
  if (typeof id !== 'string' || !skillNamePattern.test(id) || reservedName.test(id)) {
    throw new StudioError(400, '请输入符合 DSH 规范的 Skill name（小写字母、数字和连字符）')
  }
  return id
}

function pathPart(part) {
  return part !== '.' && part !== '..' && !/[<>:"|?*\x00-\x1f]|[ .]$/u.test(part) && !reservedName.test(part)
}

function importPath(value) {
  if (typeof value !== 'string' || !isAbsolute(value) ||
      !/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/iu.test(value) ||
      value.replace(/^[a-z]:/iu, '').split(/[\\/]+/u).filter(Boolean).some(part => !pathPart(part))) {
    throw new StudioError(400, '请输入完整的 Windows Skill 文件夹路径，路径须指向普通文件夹')
  }
  return resolve(value)
}

async function checkedPath(path, directory) {
  const info = await lstat(path, { bigint: true })
  if (info.isSymbolicLink() || !(directory ? info.isDirectory() : info.isFile()) ||
      !samePath(await realpath(path), path)) {
    throw fileError(409, 'conflict', `Skill 路径须指向原位置的普通文件或目录：${path}`)
  }
  return info
}

async function fileHash(path, signal) {
  const info = await checkedPath(path, false)
  const hash = createHash('sha256')
  const file = await open(path, 'r')
  try {
    const opened = await file.stat({ bigint: true })
    if (opened.dev !== info.dev || opened.ino !== info.ino) {
      throw fileError(409, 'conflict', `Skill 附属文件路径已变更：${path}`)
    }
    for await (const bytes of file.createReadStream({ signal, autoClose: false })) hash.update(bytes)
    await verifyUnchanged(path, 'Skill 附属文件', info)
    return hash.digest('hex')
  } finally {
    await file.close()
  }
}

async function inventory(directory, signal) {
  const files = new Map()
  const directories = new Set()
  async function walk(relative = '') {
    signal.throwIfAborted()
    const path = join(directory, relative)
    await checkedPath(path, true)
    const entries = await readdir(path, { withFileTypes: true })
    for (const entry of entries) {
      if (!pathPart(entry.name)) throw fileError(409, 'conflict', `Skill 附属文件名称无效：${join(path, entry.name)}`)
      const key = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        directories.add(key)
        await walk(key)
      } else {
        files.set(key, await fileHash(join(path, entry.name), signal))
      }
    }
  }
  await walk()
  return { files, directories }
}

function sameTree(left, right) {
  return left.files.size === right.files.size && left.directories.size === right.directories.size &&
    [...left.files].every(([path, hash]) => right.files.get(path) === hash) &&
    [...left.directories].every(path => right.directories.has(path))
}

function parseSkill(document, raw, expected, path, invalidStatus = 400) {
  const match = /^---\r?\n([\s\S]*?)^---(?:\r?\n|$)/mu.exec(raw)
  const frontmatter = match?.index === 0 && document(match[1])
  if (!frontmatter || frontmatter.errors.length) {
    throw fileError(invalidStatus, 'invalid', `SKILL.md 需要有效的 YAML frontmatter：${path}`)
  }
  let fields
  try {
    fields = frontmatter.toJS()
  } catch {
    throw fileError(invalidStatus, 'invalid', `SKILL.md 需要有效的 YAML frontmatter：${path}`)
  }
  const { name, description } = fields ?? {}
  if (name !== expected || typeof description !== 'string' || !description.trim() || !raw.slice(match[0].length).trim()) {
    throw fileError(invalidStatus, 'invalid', `SKILL.md 必须包含与目录一致的 name ${expected}、有效的 description 和正文：${path}`)
  }
  return { frontmatter, offset: match[0].indexOf('\n') + 1 }
}

function nativeCandidates(registry, options) {
  // rc.3's public catalog discloses winners only. Reuse its provider observation
  // before precedence is applied so a hidden global duplicate cannot be bound.
  if (!registry.layers?.global || typeof registry.layers.chainLayers !== 'function' || typeof registry.listLayerCandidates !== 'function') {
    throw fileError(503, 'blocked', '当前 DSH Host 无法核对全局 Skill 来源冲突')
  }
  const layers = [registry.layers.global, ...registry.layers.chainLayers(options.scope)]
  return Promise.all(layers.map(layer => registry.listLayerCandidates(layer, options))).then(observations => {
    if (observations.some(result => !result.cacheable)) {
      throw fileError(503, 'blocked', 'DSH 原生全局 Skill 目录读取不完整，请刷新后重试')
    }
    const all = new Map()
    for (const { entries } of observations) {
      for (const { candidate } of entries) {
        const list = all.get(candidate.name) ?? []
        list.push(candidate)
        all.set(candidate.name, list)
      }
    }
    return all
  })
}

export function skillLibrary(ctx, capabilities, signal, { globalSkills }) {
  const { root } = capabilities
  const directory = root && join(root, 'skills')
  const runtimeRequire = createRequire(ctx.profileContext.installAnchor)
  let yaml
  let opener

  function parseDocument(raw) {
    yaml ??= createRequire(runtimeRequire.resolve('@deepseek-ai/dsh-skill-filesystem'))('yaml')
    return yaml.parseDocument(raw)
  }

  function openerAPI() {
    return opener ??= Promise.resolve().then(() =>
      import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-native-command')).href),
    ).catch(() => undefined)
  }

  function requireHome() {
    if (!root) throw fileError(503, 'blocked', 'DSH Home 不可用')
  }

  function ledger() {
    const path = join(root, ledgerTarget)
    const bytes = readRegular(root, ledgerTarget, ledgerLimit)
    const records = bytes ? readJSON(bytes, path) : { schemaVersion: 1, skills: {} }
    const object = value => value && typeof value === 'object' && !Array.isArray(value)
    if (records?.schemaVersion !== 1 || !object(records.skills) || Object.entries(records.skills).some(([id, record]) =>
      !skillNamePattern.test(id) || !object(record?.files) || Object.entries(record.files).some(([relativePath, hash]) =>
        relativePath.includes('\\') || !relativePath.split('/').every(part => part && pathPart(part)) ||
        typeof hash !== 'string' || !/^[a-f0-9]{64}$/u.test(hash)))) {
      throw fileError(409, 'invalid', `Skill 导入记录格式无效：${path}`)
    }
    return { bytes, records }
  }

  async function withRegistry(sessionId, run, agent) {
    requireHome()
    await checkedPath(directory, true).catch(error => {
      if (error.code !== 'ENOENT') throw error
    })
    return globalSkills(sessionId, async (registry, options) => {
      const candidates = await nativeCandidates(registry, options)
      async function inspect(id, requireInvocation = true) {
        checkId(id)
        const target = skillTarget(id)
        const skillPath = resolve(root, target)
        const entries = candidates.get(id) ?? []
        if (entries.length > 1) {
          const origins = entries.map(({ source, path }) => path ? `${source} (${path})` : source)
          throw fileError(409, 'conflict', `Skill ${id} 存在同名来源：${origins.join('、')}。期望：${skillPath}`)
        }
        if (entries.length && entries[0].source !== 'user-dsh') {
          const entry = entries[0]
          throw fileError(409, 'conflict', `Skill ${id} 来源为 ${entry.source}（${entry.path ?? '无文件路径'}），期望 user-dsh：${skillPath}`)
        }
        const source = await localFile(skillPath, 'Skill')
        parseSkill(parseDocument, source.body, id, skillPath, 409)
        const skill = await registry.get(id, options)
        // Imports may retain a native user-invocable=false Skill. Stage bindings require user invocation.
        await checkNativeSkill(skill, id, skillPath, requireInvocation)
        await verifyUnchanged(skillPath, 'Skill', source.info)
        if (skill.resourceBase?.kind !== 'directory' || !samePath(skill.resourceBase.path, dirname(skillPath))) {
          throw fileError(409, 'conflict', `Skill ${id} 的原生附属资源目录无效：${dirname(skillPath)}`)
        }
        return { skill, source, skillPath, target }
      }
      return run(inspect, registry, options, candidates)
    }, agent)
  }

  async function describe(id, summary, inspect, registry, options, records, full = false) {
    const target = skillTarget(id)
    const expectedPath = resolve(root, target)
    const builtIn = Boolean(capabilities.assets?.has(target))
    const imported = Object.hasOwn(records.skills, id) ? records.skills[id] : undefined
    const source = builtIn ? 'built-in' : imported ? 'user-imported'
      : summary && summary.source !== 'user-dsh' ? 'external' : 'user-managed'
    const path = summary?.path ?? (source !== 'external' ? expectedPath : undefined)
    const row = { id, source, path, nativeSource: summary?.source, description: summary?.description,
      directory: path && dirname(path), builtIn, userModified: false, bindable: false, canOpen: false, resources: [] }
    const status = await Promise.allSettled([
      inspect(id, false),
      source === 'external' ? undefined : checkedPath(dirname(expectedPath), true),
      source === 'external' ? undefined : openerAPI(),
    ])
    row.canOpen = Boolean(status[1].value && status[2].value?.canOpenNativePath())
    try {
      const bootstrapIssue = (builtIn ? capabilities.failure : undefined) ?? capabilities.errors.get(target)
      if (bootstrapIssue) throw fileError(409, bootstrapIssue.status, bootstrapIssue.error)
      if (status[0].status === 'rejected') throw status[0].reason
      const { skill, source: local } = status[0].value
      row.description = skill.description
      row.nativeSource = skill.source
      row.hash = local.sha256
      row.status = assetStatus(capabilities, target, local.sha256).status
      row.userModified = ['user-owned', 'user-modified', 'update-available'].includes(row.status) ||
        Boolean(imported?.files?.[main] && imported.files[main] !== local.sha256)
      row.resources = skillResourceStatuses(capabilities, id)
      if (full) {
        row.content = local.body
        const entries = await inventory(dirname(expectedPath), signal)
        const byPath = new Map(row.resources.map(asset => [asset.path.toLowerCase(), asset]))
        const resourceFiles = []
        for (const [relativePath, hash] of entries.files) {
          if (relativePath.toLowerCase() === main.toLowerCase()) continue
          const path = join(dirname(expectedPath), relativePath)
          const official = byPath.get(path.toLowerCase())
          const installed = imported?.files && Object.hasOwn(imported.files, relativePath) && imported.files[relativePath]
          const state = official?.status ?? (installed ? installed === hash ? 'ready' : 'user-modified' : 'custom')
          resourceFiles.push({ path, relativePath, hash, status: state, error: official?.error })
          byPath.delete(path.toLowerCase())
        }
        for (const relativePath of Object.keys(imported?.files ?? {})) {
          if (relativePath === main || entries.files.has(relativePath)) continue
          const path = join(dirname(expectedPath), relativePath)
          resourceFiles.push({ path, relativePath, status: 'missing' })
        }
        if (imported && (resourceFiles.some(resource => resource.status === 'missing') ||
          [...entries.files.keys()].some(relativePath => !Object.hasOwn(imported.files, relativePath)))) row.userModified = true
        row.resources = [...resourceFiles, ...byPath.values()]
      }
      const issue = row.resources.find(resource => resource.error)
      if (issue) throw fileError(409, issue.status, issue.error)
      if (row.resources.some(resource => ['user-modified', 'user-owned', 'update-available'].includes(resource.status))) {
        row.userModified = true
      }
      if (!skill.invocation.userInvocable) {
        throw fileError(409, 'invalid', `Skill ${id} 未启用 DSH 用户调用：${expectedPath}`)
      }
      row.bindable = true
    } catch (error) {
      const issue = problem(error, path ?? expectedPath)
      row.status = issue.status
      row.error = issue.error
      if (full && row.canOpen) row.content ??= await localFile(expectedPath, 'Skill').then(file => file.body, () => undefined)
      if (full && !row.content && summary) row.content = (await registry.get(id, options))?.content
    }
    return row
  }

  async function list() {
    return withRegistry(undefined, async (inspect, registry, options) => {
      const { records } = ledger()
      const catalog = await registry.list(options)
      const discovered = new Map(catalog.map(skill => [skill.name, skill]))
      const local = await readdir(directory, { withFileTypes: true }).catch(error => {
        if (error.code !== 'ENOENT') throw error
        return []
      })
      const builtIns = [...(capabilities.assets?.values() ?? [])].filter(asset => asset.id.startsWith('skill:'))
      const names = [...new Set([
        ...discovered.keys(), ...builtIns.map(asset => asset.id.slice(6)), ...Object.keys(records.skills),
        ...local.filter(entry => (entry.isDirectory() || entry.isSymbolicLink()) && skillNamePattern.test(entry.name)).map(entry => entry.name),
      ])].sort()
      const skills = await Promise.all(names.map(id => describe(id, discovered.get(id), inspect, registry, options, records)))
      return { directory, skills, canOpen: Boolean((await openerAPI())?.canOpenNativePath()) }
    })
  }

  async function detail(id) {
    checkId(id)
    return withRegistry(undefined, async (inspect, registry, options) => {
      const summary = (await registry.list(options)).find(skill => skill.name === id)
      return { skill: await describe(id, summary, inspect, registry, options, ledger().records, true) }
    })
  }

  function refresh() {
    return globalSkills(undefined, registry => {
      // Local library mutations bypass the DSH fs tools. Clear the same native
      // catalog cache that the normal filesystem watcher invalidates.
      registry.invalidateCache?.()
    })
  }

  async function openPath(id, file) {
    requireHome()
    const path = id ? file ? join(root, skillTarget(checkId(id))) : join(directory, checkId(id)) : directory
    const command = await openerAPI()
    if (!command?.canOpenNativePath()) throw new StudioError(503, `当前 DSH Host 无法打开本地路径：${path}`)
    await checkedPath(path, !file)
    try {
      await (file ? command.openNativeTextFile : command.openNativeAssociatedPath)(path, signal)
    } catch {
      throw new StudioError(409, `当前 DSH Host 无法打开：${path}`)
    }
    return { opened: true, path }
  }

  async function install(sourceDirectory, id, cloneFrom) {
    requireHome()
    const sourceId = cloneFrom ?? id
    const sourcePath = join(sourceDirectory, main)
    const destination = join(directory, id)
    await checkedPath(sourceDirectory, true)
    await localFile(sourcePath, 'Skill')
    const copied = await withHomeLock(root, async () => {
      await checkedPath(root, true)
      const { bytes, records } = ledger()
      await refresh()
      const input = await inventory(sourceDirectory, signal)
      if (!input.files.has(main)) throw fileError(400, 'invalid', `找不到 ${main}：${sourcePath}`)
      const original = await readFile(sourcePath, 'utf8')
      if (sha256(Buffer.from(original)) !== input.files.get(main)) {
        throw fileError(409, 'conflict', `Skill 在读取时已改变，请重试：${sourcePath}`)
      }
      const { frontmatter, offset } = parseSkill(parseDocument, original, sourceId, sourcePath)
      let changed = original
      if (cloneFrom) {
        const [start, end] = frontmatter.get('name', true).range
        changed = original.slice(0, offset + start) + JSON.stringify(id) + original.slice(offset + end)
        parseSkill(parseDocument, changed, id, sourcePath)
        input.files.set(main, sha256(changed))
      }
      await mkdir(directory, { recursive: true })
      await checkedPath(directory, true)
      const exists = await lstat(destination).catch(error => {
        if (error.code !== 'ENOENT') throw error
      })
      if (exists) {
        if (sameTree(input, await inventory(destination, signal))) {
          await withRegistry(undefined, inspect => inspect(id, false))
          return 'already-exists'
        }
        throw fileError(409, 'conflict', `Skill ${id} 已存在且内容不同。请修改来源目录名称及 frontmatter name 后重试：${destination}`)
      }
      await withRegistry(undefined, (_inspect, _registry, _options, candidates) => {
        if (candidates.has(id) || capabilities.assets?.has(skillTarget(id))) {
          throw fileError(409, 'conflict', `Skill ${id} 与现有全局 Skill 重名。请修改名称后重试：${destination}`)
        }
      })
      const staging = await mkdtemp(join(root, '.drama-skill-import-'))
      try {
        for (const relative of input.directories) await mkdir(join(staging, relative))
        for (const relative of input.files.keys()) {
          signal.throwIfAborted()
          const from = join(sourceDirectory, relative)
          const to = join(staging, relative)
          await checkedPath(from, false)
          if (cloneFrom && relative === main) await writeFile(to, changed, { flag: 'wx' })
          else await copyFile(from, to, constants.COPYFILE_EXCL)
        }
        if (!sameTree(input, await inventory(staging, signal))) {
          throw fileError(409, 'conflict', `Skill 在复制时已改变，请重试：${sourceDirectory}`)
        }
        await checkedPath(directory, true)
        await rename(staging, destination)
        try {
          await refresh()
          await withRegistry(undefined, inspect => inspect(id, false))
          records.skills[id] = { files: Object.fromEntries(input.files) }
          const next = Buffer.from(JSON.stringify(records, null, 2) + '\n')
          if (next.length > ledgerLimit) throw fileError(409, 'blocked', `Skill 导入记录超过容量：${join(root, ledgerTarget)}`)
          atomicWrite(root, ledgerTarget, next, bytes && sha256(bytes))
        } catch (error) {
          // Only roll back the same files that this import installed.
          if (await inventory(destination, signal).then(tree => sameTree(input, tree), () => false)) {
            await rename(destination, staging)
            await refresh()
          }
          throw error
        }
        return 'imported'
      } finally {
        await rm(staging, { recursive: true, force: true })
      }
    })
    return { status: copied, ...(await detail(id)) }
  }

  async function request(action, data) {
    const fields = { list: [], refresh: [], detail: ['skillId'], import: ['path'],
      clone: ['skillId', 'name'], open_directory: ['skillId'], open_file: ['skillId'] }
    if (!Object.hasOwn(fields, action) || Object.keys(data).some(key => !fields[action].includes(key))) {
      throw new StudioError(400, '未知的 Skill Library 请求')
    }
    requireHome()
    try {
      if (action === 'list') return await list()
      if (action === 'refresh') {
        await refresh()
        return await list()
      }
      if (action === 'detail') return await detail(data.skillId)
      if (action === 'open_directory' || action === 'open_file') {
        return await openPath(action === 'open_file' ? checkId(data.skillId) : data.skillId, action === 'open_file')
      }
      if (action === 'import') {
        const path = importPath(data.path)
        return await install(path, checkId(basename(path)))
      }
      const origin = checkId(data.skillId)
      if (!capabilities.assets?.has(skillTarget(origin))) throw new StudioError(400, '请选择需复制的内置 Skill')
      return await install(join(directory, origin), checkId(data.name), origin)
    } catch (error) {
      if (error instanceof StudioError) throw error
      if (error.assetStatus) throw fileError(409, error.assetStatus, error.message)
      throw fileError(409, 'blocked', `无法完成 Skill Library 操作（${error.code ?? 'IO_ERROR'}）：${error.path ?? directory}`)
    }
  }

  return { list, detail, request, withRegistry,
    requireInstalled: (id, sessionId, agent) => withRegistry(sessionId, inspect => inspect(id), agent) }
}
