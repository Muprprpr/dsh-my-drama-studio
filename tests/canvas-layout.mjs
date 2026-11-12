import test from 'node:test'
import assert from 'node:assert/strict'
import { availablePosition, layoutCanvas } from '../src/canvas-layout.js'

test('layout follows reference direction and reserves measured dimensions', () => {
  const nodes = [
    { id: 'source', width: 320, height: 230 }, { id: 'shot', width: 280, height: 180 },
    { id: 'revision', width: 320, height: 310 }, { id: 'result', width: 360, height: 200 },
    { id: 'note', width: 320, height: 90 },
  ]
  const positions = layoutCanvas(nodes, [
    { source: 'source', target: 'shot' }, { source: 'source', target: 'revision' },
    { source: 'shot', target: 'result' }, { source: 'revision', target: 'result' },
  ])
  assert.ok(positions.shot.x >= positions.source.x + 320)
  assert.ok(positions.revision.y >= positions.shot.y + 180)
  assert.ok(positions.result.x >= positions.revision.x + 320)
  assert.ok(positions.note.y >= positions.revision.y + 310)
})

test('cyclic references retain a finite, non-overlapping placement', () => {
  const positions = layoutCanvas([
    { id: 'a', width: 320, height: 290 }, { id: 'b', width: 320, height: 310 },
  ], [{ source: 'a', target: 'b' }, { source: 'b', target: 'a' }])
  assert.equal(positions.a.x, positions.b.x)
  assert.ok(positions.b.y >= positions.a.y + 290)
})

test('new or unpositioned cards reserve clearance around existing ports', () => {
  const placed = [{ x: 40, y: 90, width: 320, height: 190 }, { x: 40, y: 340, width: 320, height: 250 }]
  assert.deepEqual(availablePosition({ x: 40, y: 105 }, { width: 320, height: 160 }, placed), { x: 40, y: 638 })
  assert.deepEqual(availablePosition({ x: 420, y: 105 }, { width: 320, height: 160 }, placed), { x: 420, y: 105 })
})
