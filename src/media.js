import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { StudioError } from './kernel.js'

const formats = {
  image: { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.gif': 'image/gif', '.avif': 'image/avif', '.bmp': 'image/bmp' },
  video: { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4' },
}

export async function streamMedia(req, res, workspacePath, node) {
  const path = node?.content.path
  const contentType = typeof path === 'string' && formats[node.type]?.[extname(path).toLowerCase()]
  if (!contentType || isAbsolute(path)) throw new StudioError(404, 'Media unavailable')
  const folder = node.type === 'image' ? 'images' : 'videos'
  const expected = `assets/${folder}/`
  if (!path.startsWith(expected)) throw new StudioError(404, 'Media unavailable')

  let file, size
  try {
    const base = await realpath(workspacePath)
    file = await realpath(resolve(base, path))
    const underBase = relative(base, file)
    if (!underBase.toLowerCase().startsWith(`assets${sep}${folder}${sep}`)) {
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
