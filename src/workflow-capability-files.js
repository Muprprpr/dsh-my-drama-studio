import { open, realpath, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sha256 } from './capability-assets.js'
import { StudioError } from './kernel.js'

const maxFileBytes = { Skill: 512 * 1024, Harness: 64 * 1024 }

function samePath(left, right) {
  return typeof left === 'string' && resolve(left).toLowerCase() === resolve(right).toLowerCase()
}

export function fileError(httpStatus, assetStatus, message) {
  return Object.assign(new StudioError(httpStatus, message), { assetStatus })
}

export async function localFile(path, kind) {
  try {
    if (!samePath(await realpath(path), path)) throw fileError(409, 'conflict', `全局 ${kind} 必须位于规定路径：${path}`)
    const info = await stat(path, { bigint: true })
    if (!info.isFile()) throw fileError(409, 'conflict', `${kind} 必须是普通文件：${path}`)
    if (!info.size) throw fileError(400, 'invalid', `${kind} 文件没有指令：${path}`)
    if (info.size > maxFileBytes[kind]) throw fileError(400, 'invalid', `${kind} 文件不能超过 ${maxFileBytes[kind] / 1024} KiB：${path}`)
    const file = await open(path, 'r')
    try {
      const opened = await file.stat({ bigint: true })
      if (!sameFile(info, opened) || !samePath(await realpath(path), path)) {
        throw fileError(409, 'conflict', `${kind} 路径已变更：${path}`)
      }
      const size = Number(info.size)
      const buffer = Buffer.alloc(size + 1)
      let length = 0
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length)
        if (!bytesRead) break
        length += bytesRead
      }
      const finished = await file.stat({ bigint: true })
      if (length !== size || !sameFile(finished, opened)) {
        throw fileError(409, 'conflict', `${kind} 文件在读取时发生变化，请重试：${path}`)
      }
      const bytes = buffer.subarray(0, length)
      const body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
      if (!body.trim()) throw fileError(400, 'invalid', `${kind} 文件没有指令：${path}`)
      // The Harness SHA describes the exact bytes preserved by the snapshot.
      return { body: kind === 'Harness' ? body : body.trim(), sha256: sha256(bytes), info: finished }
    } finally {
      await file.close()
    }
  } catch (error) {
    if (error instanceof StudioError) throw error
    if (error.code === 'ENOENT') throw fileError(404, 'missing', `${kind} 文件缺失：${path}`)
    if (error.code === 'ENOTDIR') throw fileError(409, 'conflict', `${kind} 目录冲突：${path}`)
    if (error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA') throw fileError(400, 'invalid', `${kind} 文件须为 UTF-8：${path}`)
    throw fileError(409, 'blocked', `无法读取 ${kind} 文件：${path}`)
  }
}

function sameFile(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

export async function verifyUnchanged(path, kind, info) {
  const current = await stat(path, { bigint: true }).catch(() => undefined)
  if (!sameFile(info, current) || !samePath(await realpath(path).catch(() => undefined), path)) {
    throw new StudioError(409, `${kind} 文件在激活时发生变化，请重试：${path}`)
  }
}

export async function checkNativeSkill(skill, name, path, requireInvocation = true) {
  if (!skill || skill.name !== name || (requireInvocation && !skill.invocation?.userInvocable) || !skill.content?.trim()) {
    throw fileError(409, 'invalid', `DSH 原生全局目录未加载 ${name}。请核对 Skill 名称、用户调用权限和正文：${path}`)
  }
  if (skill.source !== 'user-dsh' || typeof skill.path !== 'string' ||
      !samePath(await realpath(skill.path).catch(() => undefined), path)) {
    throw fileError(409, 'conflict', `Skill ${name} 来自 ${skill.source}（${skill.path ?? '无文件路径'}），需要 user-dsh：${path}`)
  }
  return skill
}

export function skillRegistry(ctx, lifetime) {
  const runtimeRequire = createRequire(ctx.profileContext.installAnchor)
  let nativeSkill

  function nativeSkillAPI() {
    return nativeSkill ??= import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-skill')).href)
  }

  async function globalSkills(sessionId, read, agent = sessionId && ctx.agents.get(sessionId)) {
    const presets = ctx.get('agentPresets')
    const registry = (agent && presets?.serviceFor(agent, 'skills')) || ctx.get('skills')
    if (!registry?.get || !registry.list) throw new StudioError(503, 'DSH 原生全局 Skill 目录不可用')
    // Omit cwd so same-named project files cannot replace the global binding.
    const query = ctx.get('sessionQuery')
    if (agent || !presets || (sessionId && !query)) return read(registry, { scope: agent, signal: lifetime })
    let preset
    if (sessionId) {
      const observation = await query.observeSession(sessionId)
      try {
        preset = observation.projections?.values.agentPreset
      } finally {
        observation[Symbol.dispose]()
      }
    }
    const lease = await presets.acquireScope(preset)
    try {
      return await read(registry, { scope: lease?.key, signal: lifetime })
    } finally {
      await lease?.[Symbol.asyncDispose]()
    }
  }

  return { globalSkills, nativeSkillAPI }
}
