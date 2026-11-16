import { resolve } from 'node:path'
import legacy from '../resources/workflow-profiles/legacy-drama-production.json' with { type: 'json' }
import shortDrama from '../resources/workflow-profiles/short-drama.json' with { type: 'json' }
import shortVideo from '../resources/workflow-profiles/short-video.json' with { type: 'json' }
import {
  assetStatus, atomicWrite, problem, readJSON, readRegular, readStageSkills, sha256,
  skillNamePattern, skillTarget, withHomeLock, workflowTarget,
} from './capability-assets.js'
import { StudioError } from './kernel.js'
import { fileError, localFile } from './workflow-capability-files.js'

const target = 'drama-studio/workflows/stage-bindings.json'
const legacyTarget = workflowTarget('drama-production', 'stage-skills.json')
const profiles = [shortDrama, shortVideo, legacy]
const definitionById = new Map(profiles.map(profile => [profile.id, profile]))
const schemaVersion = 1
const blank = () => ({ schemaVersion, profiles: {} })
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const configFailure = (path, message) => fileError(409, 'invalid', `${message}：${path}`)
const validName = name => typeof name === 'string' && skillNamePattern.test(name)

export const newWorkflowProfiles = profiles.slice(0, 2).map(({ id, name, version }) => ({ id, name, version }))

export function stageBindings(capabilities, library) {
  const root = capabilities.root
  const path = root && resolve(root, target)

  function readConfig() {
    if (!root) throw new StudioError(503, '无法定位当前 DSH Home 的阶段绑定配置')
    const bytes = readRegular(root, target, 128 * 1024)
    if (!bytes) return { config: blank() }
    const config = readJSON(bytes, path)
    if (config?.schemaVersion !== schemaVersion || !object(config.profiles) ||
        Object.keys(config).some(key => !['schemaVersion', 'profiles', 'legacyMigration'].includes(key)) ||
        (config.legacyMigration !== undefined &&
          (!object(config.legacyMigration) || config.legacyMigration.source !== legacyTarget ||
            !/^[a-f0-9]{64}$/u.test(config.legacyMigration.sha256 ?? '')))) {
      throw configFailure(path, '阶段绑定配置版本或结构无效')
    }
    return { config, hash: sha256(bytes) }
  }

  function writeConfig(config, previousHash) {
    atomicWrite(root, target, Buffer.from(JSON.stringify(config, null, 2) + '\n'), previousHash)
  }

  function withLegacyMigration(config) {
    if (config.legacyMigration) return { config }
    const old = readStageSkills(root)
    if (old.failure) return { config, legacyFailure: old.failure }
    if (!old.hash) return { config }
    const overrides = config.profiles[legacy.id]
    if (overrides !== undefined && !object(overrides)) {
      return { config, legacyFailure: problem(configFailure(path, '旧工作流的阶段绑定配置无效'), path) }
    }
    const mapping = { ...old.names, ...overrides }
    const next = {
      ...config, profiles: { ...config.profiles, ...(Object.keys(mapping).length && { [legacy.id]: mapping }) },
      legacyMigration: { source: legacyTarget, sha256: old.hash },
    }
    return { config: next }
  }

  async function migrate() {
    if (!root) return
    try {
      await withHomeLock(root, () => {
        const { config, hash } = readConfig()
        const result = withLegacyMigration(config)
        if (result.config !== config) writeConfig(result.config, hash)
      })
    } catch (error) {
      // A malformed file stays intact and is reported by reads. A write failure
      // leaves the old mapping usable and lets the next refresh retry migration.
      console.warn('[my-drama-studio] Workflow binding migration:', problem(error, path).error)
    }
  }

  function read() {
    try {
      return withLegacyMigration(readConfig().config)
    } catch (error) {
      return { config: blank(), failure: problem(error, path) }
    }
  }

  function effective(state, profileId, stageId, defaultSkill) {
    const overrides = state.config.profiles[profileId]
    const present = object(overrides) && Object.hasOwn(overrides, stageId)
    const stored = present ? overrides[stageId] : undefined
    const skillId = validName(stored) ? stored : defaultSkill
    const definition = definitionById.get(profileId)
    const ownFailure = overrides !== undefined && (!object(overrides) ||
        Object.keys(overrides).some(id => !definition?.stages.some(stage => stage.id === id)))
      ? problem(configFailure(path, '此生产模式含未知阶段或无效的绑定配置'), path) : undefined
    const invalid = present && !validName(stored)
      ? problem(configFailure(path, `Skill ID 无效（${typeof stored === 'string' ? stored : '需要名称'}）`), path) : undefined
    return {
      skillId, overridden: present,
      failure: state.failure ?? (profileId === legacy.id && state.legacyFailure || undefined) ?? ownFailure ?? invalid,
    }
  }

  function reservedNames() {
    const { config } = read()
    return Object.values(config.profiles).flatMap(stages => object(stages) ? Object.values(stages).filter(validName) : [])
  }

  function withUsage(result) {
    if (!result.skills && !result.skill) return result
    const state = read()
    const useBySkill = new Map()
    for (const profile of profiles) {
      for (const stage of profile.stages) {
        const { skillId, failure } = effective(state, profile.id, stage.id, stage.defaultSkill)
        if (failure) continue
        const uses = useBySkill.get(skillId) ?? []
        uses.push({ profileId: profile.id, profileName: profile.name, stageId: stage.id, stageName: stage.name })
        useBySkill.set(skillId, uses)
      }
    }
    function withSkill(skill) {
      return { ...skill, usedBy: useBySkill.get(skill.id) ?? [] }
    }
    return result.skills ? { ...result, skills: result.skills.map(withSkill) } : { ...result, skill: withSkill(result.skill) }
  }

  async function harnessStatus(stageId) {
    const target = workflowTarget('drama-production', `stages/${stageId}/harness.md`)
    const path = root && resolve(root, target)
    const issue = capabilities.failure ?? capabilities.errors.get(target)
    if (issue) return { ...issue, path: path ?? issue.path }
    try {
      const { sha256: hash } = await localFile(path, 'Harness')
      return assetStatus(capabilities, target, hash)
    } catch (error) {
      return { status: error.assetStatus ?? 'blocked', error: error.message, path }
    }
  }

  async function settings() {
    await migrate()
    const state = read()
    const listing = await library.list()
    const byId = new Map(listing.skills.map(skill => [skill.id, skill]))
    const harnesses = new Map()
    return {
      profiles: await Promise.all(profiles.map(async profile => ({
        ...profile,
        stages: await Promise.all(profile.stages.map(async stage => {
          const { skillId, overridden, failure } = effective(state, profile.id, stage.id, stage.defaultSkill)
          const skill = byId.get(skillId) ?? null
          if (!harnesses.has(stage.id)) harnesses.set(stage.id, harnessStatus(stage.id))
          const harness = await harnesses.get(stage.id)
          const expected = root && resolve(root, skillTarget(skillId))
          const skillFailure = skill?.bindable ? undefined : skill?.error ?? `Skill ${skillId} 未通过全局来源验证：${expected ?? 'DSH_HOME'}`
          return { ...stage, skillId, overridden, skill, harness, issues: [failure?.error ?? skillFailure, harness.error].filter(Boolean) }
        })),
      }))),
      skills: listing.skills,
      failure: state.failure,
    }
  }

  async function save(profileId, stageId, skillId) {
    const profile = definitionById.get(profileId)
    const stage = profile?.stages.find(item => item.id === stageId)
    if (!stage || (skillId !== null && !validName(skillId))) throw new StudioError(400, '需要有效的生产模式、阶段及 Skill ID')
    if (!root) throw new StudioError(503, '无法定位当前 DSH Home 的阶段绑定配置')
    await withHomeLock(root, async () => {
      const { config: original, hash } = readConfig()
      const { config, legacyFailure } = withLegacyMigration(original)
      if (profileId === legacy.id && legacyFailure) throw new StudioError(409, legacyFailure.error)
      if (config.profiles[profileId] !== undefined && !object(config.profiles[profileId])) {
        throw configFailure(path, '此生产模式的阶段绑定配置无效')
      }
      if (skillId !== null) await library.requireInstalled(skillId)
      const overrides = { ...config.profiles[profileId] }
      if (skillId === null || skillId === stage.defaultSkill) delete overrides[stageId]
      else overrides[stageId] = skillId
      if (Object.keys(overrides).length) config.profiles[profileId] = overrides
      else delete config.profiles[profileId]
      writeConfig(config, hash)
    })
    return settings()
  }

  return { migrate, read, effective, reservedNames, settings, save, withUsage }
}
