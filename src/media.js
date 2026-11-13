import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, realpath, stat, unlink } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { StudioError } from './kernel.js'

const formats = {
  image: { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.gif': 'image/gif', '.avif': 'image/avif', '.bmp': 'image/bmp' },
  video: { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4' },
  audio: { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg' },
}
const assetPrefixes = { image: ['assets', 'images'], video: ['assets'], audio: ['assets', 'audio'] }
const maxUploadBytes = 128 * 1024 * 1024

export async function importMedia(req, workspacePath, type, name) {
  const extension = typeof name === 'string' && extname(name).toLowerCase()
  if (typeof type !== 'string' || !Object.hasOwn(formats, type) || !Object.hasOwn(formats[type], extension)) {
    throw new StudioError(415, '请选择支持的图片、视频或音频文件')
  }
  const declaredSize = Number(req.headers['content-length'])
  if (declaredSize > maxUploadBytes) throw new StudioError(413, '素材文件不能超过 128 MB')
  const folders = type === 'video' ? ['assets', 'videos'] : assetPrefixes[type]
  const base = await realpath(workspacePath)
  let dir = base
  for (const folder of folders) {
    dir = resolve(dir, folder)
    await mkdir(dir).catch(error => { if (error.code !== 'EEXIST') throw error })
    if ((await realpath(dir)).toLowerCase() !== dir.toLowerCase()) {
      throw new StudioError(409, '素材目录已重定向，请检查项目目录')
    }
  }
  const filename = randomUUID() + extension
  const file = resolve(dir, filename)
  let bytes = 0
  try {
    await pipeline(req.iterator({ destroyOnReturn: false }), async function* (chunks) {
      for await (const chunk of chunks) {
        bytes += chunk.length
        if (bytes > maxUploadBytes) throw new StudioError(413, '素材文件不能超过 128 MB')
        yield chunk
      }
    }, createWriteStream(file, { flags: 'wx' }))
    if (!bytes) throw new StudioError(400, '素材文件为空')
  } catch (error) {
    if (error.code !== 'EEXIST') await unlink(file).catch(() => {})
    throw error
  }
  return { path: [...folders, filename].join('/'), title: name.split(/[\\/]/).at(-1).slice(0, 160) }
}

export async function streamMedia(req, res, workspacePath, node) {
  const path = node?.content.path
  const contentType = typeof path === 'string' && formats[node.type]?.[extname(path).toLowerCase()]
  if (!contentType || isAbsolute(path)) throw new StudioError(404, 'Media unavailable')
  const folders = assetPrefixes[node.type]
  const expected = folders.join('/') + '/'
  if (!path.startsWith(expected)) throw new StudioError(404, 'Media unavailable')

  let file, size
  try {
    const base = await realpath(workspacePath)
    file = await realpath(resolve(base, path))
    const underBase = relative(base, file)
    if (!underBase.toLowerCase().startsWith(folders.join(sep) + sep)) {
      throw new StudioError(404, 'Media is outside the workspace asset directory')
    }
    const info = await stat(file)
    if (!info.isFile() || !info.size) throw new StudioError(404, 'Media unavailable')
    size = info.size
  } catch (error) {
    if (error instanceof StudioError) throw error
    if (error.code === 'ENOENT' || error.code === 'EACCES') throw new StudioError(404, 'Media unavailable')
    throw error
  }

  const headers = {
    'Content-Type': contentType, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store',
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  }
  const range = req.headers.range
  let start = 0
  let end = size - 1
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (match && match[1]) {
      start = Number(match[1])
      if (match[2]) end = Math.min(end, Number(match[2]))
    } else if (match?.[2]) {
      start = Math.max(0, size - Number(match[2]))
    } else {
      start = size
    }
    if (start >= size || end < start) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` })
      res.end()
      return
    }
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`
  }
  res.writeHead(range ? 206 : 200, { ...headers, 'Content-Length': end - start + 1 })
  await pipeline(createReadStream(file, { start, end }), res)
}
