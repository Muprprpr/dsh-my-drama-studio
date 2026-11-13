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
const assetFolders = { image: ['assets', 'images'], video: ['assets', 'videos'], audio: ['assets', 'audio'] }
const importedFilename = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9]+$/
const maxUploadBytes = 128 * 1024 * 1024

function mediaContentType(type, filename) {
  if (typeof filename === 'string' && Object.hasOwn(formats, type)) {
    return formats[type][extname(filename).toLowerCase()]
  }
}

export async function importMedia(req, workspacePath, type, name) {
  if (!mediaContentType(type, name)) {
    throw new StudioError(415, '请选择支持的图片、视频或音频文件')
  }
  const declaredSize = Number(req.headers['content-length'])
  if (declaredSize > maxUploadBytes) throw new StudioError(413, '素材文件不能超过 128 MB')
  const folders = assetFolders[type]
  const base = await realpath(workspacePath)
  let dir = base
  for (const folder of folders) {
    dir = resolve(dir, folder)
    await mkdir(dir).catch(error => { if (error.code !== 'EEXIST') throw error })
    if ((await realpath(dir)).toLowerCase() !== dir.toLowerCase()) {
      throw new StudioError(409, '素材目录已重定向，请检查项目目录')
    }
  }
  const assetId = randomUUID() + extname(name)
  const file = resolve(dir, assetId)
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
  return { assetId, type, path: [...folders, assetId].join('/'), title: name.split(/[\\/]/).at(-1).slice(0, 160) }
}

export function importedMediaURL(ticket, type, assetId) {
  return `/api/drama/media?${new URLSearchParams({ ticket, type, assetId })}`
}

export function streamImportedMedia(req, res, workspacePath, type, assetId) {
  if (typeof assetId !== 'string' || !importedFilename.test(assetId) || !mediaContentType(type, assetId)) {
    throw new StudioError(404, 'Media unavailable')
  }
  const folders = assetFolders[type]
  return streamMedia(req, res, workspacePath, type, [...folders, assetId].join('/'), folders)
}

export async function streamMedia(req, res, workspacePath, type, path,
  folders = type === 'video' ? ['assets'] : assetFolders[type]) {
  const contentType = mediaContentType(type, path)
  if (!contentType || isAbsolute(path)) throw new StudioError(404, 'Media unavailable')
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
