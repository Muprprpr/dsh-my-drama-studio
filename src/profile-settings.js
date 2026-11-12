import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { StudioError } from './kernel.js'

// The standalone Desktop launcher resolves its shared runtime inside app.asar.
const { default: Schema } = await import('@deepseek-ai/schemastery').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND' || !process.versions.electron) throw error
  const path = join(dirname(process.execPath), 'resources', 'app.asar', 'dsh',
    'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs')
  return import(pathToFileURL(path).href)
})

export const Config = Schema.object({
  studio: Schema.dict(Schema.any()).default({}).volatile(),
})

const namespace = 'my-drama-studio'
const changes = new Set(['channel_save', 'channel_remove', 'provider_save', 'provider_remove', 'generation_save'])
const globalWorkspace = { id: '', path: '' }

export async function openProfileSettings(ctx, config, kernel) {
  const profileHash = createHash('sha256').update(ctx.profileContext.dir.toLowerCase()).digest('hex')
  const prefix = `my-drama-studio/profile-${profileHash}-`
  const invoke = (action, data) => kernel('', globalWorkspace, action, data)
  const credential = id => {
    if (typeof id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(id)) {
      throw new StudioError(400, '渠道凭据引用无效')
    }
    return prefix + id
  }
  const descriptor = () => {
    const form = ctx.settings.describe({ redactSecrets: true }).find(item => item.ns === namespace)
    if (!form) throw new StudioError(503, 'Drama Studio 设置未注册到当前 DSH Profile')
    return form
  }

  let serial = Promise.resolve()
  const serialize = run => {
    const result = serial.then(run)
    serial = result.catch(() => {})
    return result
  }

  async function configure(document) {
    const ids = new Set([...(document.channels ?? []).map(channel => channel.id), ...(document.retired ?? [])])
    const entries = await Promise.all([...ids].map(async id => {
      const record = await ctx.credentials.readRecord(credential(id))
      return [id, record?.kind === 'api-key' ? record.key : undefined]
    }))
    return invoke('provider_configure', { config: document, keys: Object.fromEntries(entries.filter(([, value]) => value)) })
  }

  async function persist(next, revision) {
    try {
      await ctx.settings.mutate(namespace, [{ op: 'set', path: ['studio'], value: next }], revision)
    } catch (error) {
      throw new StudioError(error.code === 'settings/conflict' ? 409 : 400, error.message)
    }
  }

  async function updateKey(id, value) {
    const ref = credential(id)
    if (value) await ctx.credentials.modifyRecord(ref, async () => ({ kind: 'api-key', key: value }))
    else await ctx.credentials.deleteRecord(ref)
  }

  // The original developer launcher used the web profile with one Home-wide DPAPI file.
  const initial = config.studio.get()
  let legacy
  if (ctx.profileContext.name === 'web' && Object.keys(initial).length === 0) {
    try {
      legacy = await invoke('provider_legacy')
    } catch {
      console.warn('[my-drama-studio] Could not read legacy Windows provider settings')
    }
  }
  if (legacy) await invoke('provider_configure', legacy)
  else await configure(initial)

  async function migrateLegacy(form) {
    if (!legacy || Object.keys(form.value.studio ?? {}).length > 0) return form
    const refs = Object.entries(legacy.keys)
    for (const [id, key] of refs) await updateKey(id, key)
    await persist(legacy.config, form.revision)
    legacy = undefined
    return descriptor()
  }

  ctx.effect(() => ctx.settings.configure({ auto: false }, ctx.fiber))
  ctx.on('loader/volatile-update', () => {
    void serialize(() => configure(config.studio.get())).catch(() => {
      console.error('[my-drama-studio] Could not reload Profile settings into the generation kernel')
    })
  })
  ctx.on('credentials/record-updated', key => {
    if (key.startsWith(prefix)) {
      void serialize(() => configure(config.studio.get())).catch(() => {
        console.error('[my-drama-studio] Could not refresh channel credential in the generation kernel')
      })
    }
  })

  return function providerRequest(action, data) {
    if (action === 'channel_test') return invoke(action, data)
    return serialize(async () => {
      const form = await migrateLegacy(descriptor())
      const current = form.value.studio ?? {}
      if (action === 'provider_settings') {
        return { ...await configure(current), revision: form.revision }
      }
      if (!changes.has(action)) throw new StudioError(400, '未知设置操作')
      const { revision, apiKey, ...input } = data
      if (revision !== undefined && revision !== form.revision) {
        throw new StudioError(409, '设置已修改，请重新打开页面后再保存')
      }
      if (apiKey !== undefined && (action !== 'channel_save' || typeof apiKey !== 'string' ||
        apiKey.length > 1024 || /[\s\p{Cc}]/u.test(apiKey))) {
        throw new StudioError(400, 'API 密钥格式无效')
      }
      const plan = await invoke('provider_plan', { config: current, action, data: input })
      const hasKeyChange = apiKey !== undefined
      const previous = hasKeyChange ? await ctx.credentials.readRecord(credential(plan.channelId)) : undefined
      if (hasKeyChange) await updateKey(plan.channelId, apiKey)
      try {
        if (!isDeepStrictEqual(current, plan.config)) await persist(plan.config, form.revision)
      } catch (error) {
        if (hasKeyChange) await updateKey(plan.channelId, previous?.key)
        throw error
      }
      const updated = descriptor()
      const view = await configure(updated.value.studio ?? {})
      return { ...view, revision: updated.revision }
    })
  }
}
