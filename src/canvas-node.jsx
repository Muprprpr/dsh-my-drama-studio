export const nodeLabels = {
  script: '剧本', shot: '镜头', prompt: '提示词', image: '图片', video: '视频', note: '备注',
}
export const modeLabels = {
  t2v: '文生视频 · T2V', i2v: '图生视频 · I2V', r2v: '参考生视频 · R2V', asset: '视频素材',
}
export const groupFields = [['episodeId', '集'], ['sceneId', '场'], ['shotId', '镜头']]
export const mediaTypes = new Set(['image', 'video'])

export const presets = [
  { type: 'script', label: '剧本', detail: '整理剧情与对白' },
  { type: 'shot', label: '镜头', detail: '记录镜头设计与场次' },
  { type: 'prompt', label: '提示词笔记', detail: '保存独立的创作记录' },
  { type: 'image', label: '图片', detail: '登记可用的图片素材或图片草稿' },
  { type: 'video', mode: 't2v', label: modeLabels.t2v, detail: '写入完整提示词' },
  { type: 'video', mode: 'i2v', label: modeLabels.i2v, detail: '用一张图片作首帧' },
  { type: 'video', mode: 'r2v', label: modeLabels.r2v, detail: '用一张或多张图片作参考' },
  { type: 'video', mode: 'asset', label: modeLabels.asset, detail: '登记已有视频或成片' },
  { type: 'note', label: '备注', detail: '记录处理意见' },
]

export function shotLabel(node) {
  return groupFields.map(([field]) => node[field]).filter(Boolean).join(' / ')
}

export function nodeTitle(node) {
  return typeof node.content.title === 'string' ? node.content.title : ''
}

export function isMedia(node) {
  return mediaTypes.has(node.type) && [node.content.path, node.content.url].some(value => typeof value === 'string' && value)
}

export function referenceIds(node) {
  return Array.isArray(node?.content.mixedListOrder) ? node.content.mixedListOrder : []
}

export function videoMode(node) {
  if (node.type !== 'video') return ''
  if (Object.hasOwn(modeLabels, node.content.mode)) return node.content.mode
  if (isMedia(node) && !node.content.prompt) return 'asset'
  const count = referenceIds(node).length
  return count === 0 ? 't2v' : count === 1 ? 'i2v' : 'r2v'
}
