const horizontalGap = 92
const verticalGap = 48

export function availablePosition(point, size, placed) {
  let y = point.y
  for (;;) {
    const overlaps = placed.filter(node => point.x < node.x + node.width + 36 && point.x + size.width + 36 > node.x
      && y < node.y + node.height + verticalGap && y + size.height + verticalGap > node.y)
    if (!overlaps.length) return { x: point.x, y }
    y = Math.max(...overlaps.map(node => node.y + node.height + verticalGap))
  }
}

export function layoutCanvas(nodes, edges, origin = { x: 38, y: 94 }) {
  const byId = new Map(nodes.map(node => [node.id, node]))
  const successors = new Map(nodes.map(node => [node.id, new Set()]))
  const degree = new Map(nodes.map(node => [node.id, 0]))
  const related = new Set()
  for (const { source, target } of edges) {
    if (source === target || !byId.has(source) || !byId.has(target) || successors.get(source).has(target)) continue
    successors.get(source).add(target)
    degree.set(target, degree.get(target) + 1)
    related.add(source)
    related.add(target)
  }

  const depth = new Map()
  const queue = nodes.filter(node => related.has(node.id) && degree.get(node.id) === 0).map(node => node.id)
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]
    const level = depth.get(id) ?? 0
    for (const next of successors.get(id)) {
      depth.set(next, Math.max(depth.get(next) ?? 0, level + 1))
      degree.set(next, degree.get(next) - 1)
      if (degree.get(next) === 0) queue.push(next)
    }
  }

  const processed = new Set(queue)
  const layers = new Map()
  const cyclicLayer = Math.max(0, ...queue.map(id => depth.get(id) ?? 0)) + 1
  for (const node of nodes) {
    if (!related.has(node.id)) continue
    const level = processed.has(node.id) ? depth.get(node.id) ?? 0 : cyclicLayer
    if (!layers.has(level)) layers.set(level, [])
    layers.get(level).push(node)
  }

  const positions = {}
  let x = origin.x
  let linkedBottom = origin.y
  for (const [, layer] of [...layers.entries()].sort(([a], [b]) => a - b)) {
    let y = origin.y
    for (const node of layer) {
      positions[node.id] = { x, y }
      y += node.height + verticalGap
    }
    x += Math.max(...layer.map(node => node.width)) + horizontalGap
    linkedBottom = Math.max(linkedBottom, y)
  }

  const independent = nodes.filter(node => !related.has(node.id))
  const columns = Math.max(1, Math.min(3, Math.ceil(Math.sqrt(independent.length))))
  const rowWidth = Math.max(0, ...independent.map(node => node.width)) + horizontalGap
  let y = linkedBottom
  for (let i = 0; i < independent.length; i += columns) {
    const row = independent.slice(i, i + columns)
    row.forEach((node, column) => { positions[node.id] = { x: origin.x + column * rowWidth, y } })
    y += Math.max(...row.map(node => node.height)) + verticalGap
  }
  return positions
}
