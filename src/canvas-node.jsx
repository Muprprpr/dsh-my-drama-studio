export const nodeLabels = {
  script: '剧本', shot: '镜头', prompt: '提示词', image: '图片', video: '视频', audio: '音频', note: '备注',
}
export const modeLabels = {
  t2v: '文生视频 · T2V', i2v: '图生视频 · I2V', r2v: '参考生视频 · R2V', v2v: '视频转视频 · V2V', asset: '视频素材',
}
export const groupFields = [['episodeId', '集'], ['sceneId', '场'], ['shotId', '镜头']]
export const textTypes = new Set(['script', 'shot', 'prompt', 'note'])
export const mediaTypes = new Set(['image', 'video', 'audio'])
export const assetFolders = { image: 'assets/images/', video: 'assets/videos/', audio: 'assets/audio/' }

export const presets = [
  { type: 'script', label: '剧本', detail: '整理剧情与对白' },
  { type: 'shot', label: '镜头', detail: '记录镜头设计与场次' },
  { type: 'prompt', label: '提示词笔记', detail: '保存独立的创作记录' },
  { type: 'image', label: '图片', detail: '登记可用的图片素材或图片草稿' },
  { type: 'video', mode: '', label: '视频生成', detail: '在节点中选择生成方式和模型' },
  { type: 'video', mode: 'asset', label: modeLabels.asset, detail: '登记已有视频或成片' },
  { type: 'audio', label: '音频素材', detail: '登记已有音频' },
  { type: 'note', label: '备注', detail: '记录处理意见' },
]

export function shotLabel(node) {
  return groupFields.map(([field]) => node[field]).filter(Boolean).join(' / ')
}

export function nodeTitle(node) {
  return typeof node?.content.title === 'string' ? node.content.title : ''
}

export function isMedia(node) {
  return mediaTypes.has(node?.type) && [node.content.path, node.content.url].some(value => typeof value === 'string' && value)
}

export function referenceIds(node) {
  return Array.isArray(node?.content.mixedListOrder) ? node.content.mixedListOrder : []
}

export function videoMode(node) {
  if (node.type !== 'video') return ''
  if (node.content.mode === '' || Object.hasOwn(modeLabels, node.content.mode)) return node.content.mode
  if (isMedia(node) && !node.content.prompt) return 'asset'
  const count = referenceIds(node).length
  return count === 0 ? 't2v' : count === 1 ? 'i2v' : 'r2v'
}

export function profileCandidates(profiles, mode) {
  return profiles.filter(profile => (profile.modes ?? [profile.mode]).includes(mode))
}

export function resolveProfile(profiles, preferredId) {
  if (preferredId) return profiles.find(profile => profile.id === preferredId)
  const configured = profiles.filter(profile => profile.configured)
  return configured.find(profile => profile.default) ?? (configured.length === 1 ? configured[0] : undefined)
}

export function referenceLimit(mode, kind, profile) {
  if (mode === 'i2v') return kind === 'image' ? (!profile || profile.limits?.lastFrame ? 2 : 1) : 0
  if (mode === 'v2v') return kind === 'video' ? 1 : 0
  if (mode === 'r2v') {
    if (!profile) return 32
    return profile.limits?.references?.[kind] ?? 0
  }
  if (mode === 't2i') {
    if (textTypes.has(kind)) return 32
    if (kind === 'image') return profile ? profile.limits?.references?.image ?? 0 : 32
  }
  return mode === '' && kind === 'image' ? 32 : 0
}
