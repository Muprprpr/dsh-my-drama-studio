import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Background, MarkerType, MiniMap, ReactFlow, SelectionMode, getViewportForBounds } from '@xyflow/react'
import { Button, Input, Menu, Modal, IconPlusOutlineRegular, isBehindModal, observeComposition } from '@deepseek-ai/dsh-client-ui-primitives'
import { CanvasCorners, CanvasPicker, CanvasToolbar, IconButton } from './canvas-tools.jsx'
import flowStyle from '@xyflow/react/dist/style.css'
import canvasStyle from './canvas.css'
import { GraphNode, cardStyle } from './node-card.jsx'
import { TaskDrawer, taskActive } from './task-drawer.jsx'
import { availablePosition, layoutCanvas } from './canvas-layout.js'
import {
  groupFields, isMedia, mediaTypes, textTypes,
  nodeLabels, nodeTitle, presets, profileCandidates, referenceIds, referenceLimit, resolveProfile, shotLabel, videoMode,
} from './canvas-node.jsx'

const nodeTypes = { drama: GraphNode }
const emptyPositions = {}
const grid = [12, 12]
const gapX = 412
const minZoom = 0.15
const maxZoom = 2
const focusDuration = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 280
const clipboardType = 'web application/x-dsh-drama-nodes+json'
const edgeId = ({ source, target }) => JSON.stringify([source, target])
const inEditor = event => event.target instanceof Element &&
  Boolean(event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]'))
const groupOf = node => Object.fromEntries(groupFields.map(([field]) => [field, node[field] ?? '']))
const groupFor = (node, filters) => Object.fromEntries(groupFields.map(([field]) => [field, node?.[field] ?? filters[field] ?? '']))
function mediaKind(file) {
  const type = file.type.split('/')[0]
  if (mediaTypes.has(type)) return type
  if (/\.(mp4|mov|m4v|webm)$/i.test(file.name)) return 'video'
  if (/\.(wav|mp3|m4a|ogg)$/i.test(file.name)) return 'audio'
  if (/\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(file.name)) return 'image'
  return ''
}
const mutableSources = node => ['video', 'image', 'shot'].includes(node.type)

function readPositions(key) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? emptyPositions
  } catch {
    return emptyPositions
  }
}

function usePositions(key) {
  const [view, setView] = useState(() => ({ key, positions: readPositions(key) }))
  const positions = view.key === key ? view.positions : emptyPositions
  function update(change) {
    setView(current => ({
      key,
      positions: change(current.key === key ? current.positions : readPositions(key)),
    }))
  }
  useEffect(() => {
    if (view.key !== key) {
      setView({ key, positions: readPositions(key) })
      return
    }
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(key, JSON.stringify(Object.fromEntries(
          Object.entries(view.positions).filter(([id]) => !id.startsWith('draft-')))))
      } catch {
        // The graph remains usable when browser storage is disabled or full.
      }
    }, 100)
    return () => clearTimeout(timer)
  }, [key, view])
  return [positions, update]
}

export function CanvasViewport({
  snapshot, filters, setFilters, append, mutate, agentLockedNodeIds = [], mediaURL, uploadFile,
  submitGeneration, changeTask, queryCanvas, generationProfiles = [], generationDefaults,
}) {
  const { nodes, edges, hasMore, status, tasks = [], referenceNodes = [], lockedNodeIds = [] } = snapshot
  const [positions, setPositions] = usePositions(`drama-layout:${status.canvasId}:${status.sessionId}`)
  const [selected, setSelected] = useState([])
  const [selectedEdges, setSelectedEdges] = useState([])
  const [collapsed, setCollapsed] = useState([])
  const [compact, setCompact] = useState([])
  const [boxSelect, setBoxSelect] = useState(false)
  const [showMap, setShowMap] = useState(false)
  const [drafts, setDrafts] = useState([])
  const [preview, setPreview] = useState(null)
  const [tasksOpen, setTasksOpen] = useState(false)
  const [selectedResults, setSelectedResults] = usePositions(`drama-results:${status.canvasId}:${status.sessionId}`)
  const [picker, setPicker] = useState(null)
  const [assetPicker, setAssetPicker] = useState(null)
  const [rename, setRename] = useState(null)
  const [referenceFocus, setReferenceFocus] = useState(null)
  const [contextNode, setContextNode] = useState(null)
  const [contextEdge, setContextEdge] = useState(null)
  const [removal, setRemoval] = useState(null)
  const [removing, setRemoving] = useState(false)
  const [removalError, setRemovalError] = useState('')
  const [focusId, setFocusId] = useState(null)
  const [editorFocus, setEditorFocus] = useState(null)
  const [edgeError, setEdgeError] = useState('')
  const flow = useRef(null)
  const addAnchor = useRef(null)
  const surface = useRef(null)
  const reconnecting = useRef(null)
  const gesture = useRef(null)
  const copied = useRef(null)
  const history = useRef({ undo: [], redo: [] })
  const latestRevisions = useRef(new Map())
  const writing = useRef(false)
  const latestLocks = useRef(new Set())
  const focusOrigin = useRef(null)

  useEffect(() => {
    if (rename && !selected.includes(rename.id)) setRename(null)
    if (referenceFocus && !selected.includes(referenceFocus.id)) setReferenceFocus(null)
  }, [selected, rename, referenceFocus])

  const index = useMemo(() => new Map([...referenceNodes, ...nodes].map(node => [node.id, node])), [nodes, referenceNodes])
  const resolvedMedia = useMemo(() => new Map(Object.entries(snapshot.resolvedMedia ?? {})), [snapshot.resolvedMedia])
  const locked = new Set([...agentLockedNodeIds, ...lockedNodeIds])
  latestLocks.current = locked
  const lockReason = id => locked.has(id) ? '执行中使用的节点，结束后可编辑。' : ''
  const taskIndex = useMemo(() => {
    const map = new Map()
    for (const task of tasks) {
      for (const id of new Set([task.nodeId, task.resultNodeId].filter(Boolean))) {
        if (!map.has(id)) map.set(id, [])
        map.get(id).push(task)
      }
    }
    return map
  }, [tasks])
  const groups = [...new Set(nodes.map(shotLabel))].filter(Boolean)
  const visible = nodes.filter(node => !collapsed.includes(shotLabel(node)))
  const visibleIds = new Set(visible.map(node => node.id))
  const pageSize = filters.limit || 100
  const offset = filters.offset || 0
  const selectedResultIds = new Set(Object.values(selectedResults))
  const media = [...index.values()].filter(node => !node.deleted)

  const visibleReferences = edges.filter(edge => visibleIds.has(edge.source) && visibleIds.has(edge.target) &&
    (index.get(edge.target).type !== 'video' || mediaTypes.has(index.get(edge.source)?.type)))
  const visibleVersions = visible.filter(node => node.basedOn && visibleIds.has(node.basedOn) &&
    (node.type !== 'video' || mediaTypes.has(index.get(node.basedOn)?.type)))
    .map(node => ({ source: node.basedOn, target: node.id }))
  const relations = [...visibleReferences, ...visibleVersions]
  const ordered = [...visible].sort((a, b) => shotLabel(a).localeCompare(shotLabel(b))
    || String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id))
  const dimensions = node => ({ id: node.id, width: 320,
    height: compact.includes(node.id) ? 88 : node.type === "image" || node.type === "video" ? 410 : 230 })
  const defaultPositions = layoutCanvas(ordered.map(dimensions), relations)
  const placed = ordered.filter(node => positions[node.id]).map(node => ({ ...positions[node.id], ...dimensions(node) }))
  for (const node of ordered) {
    if (positions[node.id]) continue
    const size = dimensions(node)
    defaultPositions[node.id] = availablePosition(defaultPositions[node.id], size, placed)
    placed.push({ ...defaultPositions[node.id], ...size })
  }

  const actions = {
    edit: node => selectNode(node.id),
    delete: node => openRemoval({ nodes: [node], edges: [] }),
    removeReference: (source, target) => openRemoval({ nodes: [], edges: [{ source, target: target.id }] }),
    rename: node => renameNode(node.id),
    chooseAsset: node => setAssetPicker({ node, type: node.type }),
    upload: async (node, file) => await runCanvas(async () => {
      const content = await uploadFile(node.type, file)
      await assignAsset(node, content)
    }),
    revise: node => openEditor({ base: node }),
    duplicate: node => runCanvas(() => pasteNodes(copyData([node.id]))),
    collapse: node => toggleCompact([node.id]),
    addAfter: (node, rect) => openPicker(undefined, node, rect),
    preview: setPreview,
    locate,
    selectResult: node => setSelectedResults(current => ({ ...current, [node.basedOn || node.id]: node.id })),
    submitGeneration,
  }
  function editorFor(draft) {
    return {
      append: appendWithHistory, mutate: editWithHistory, mutationReason: lockReason(draft.id), media, queryCanvas,
      importFile: file => uploadFile(mediaKind(file), file),
      uploadReference: file => createMedia(file, undefined, false),
      attachAsset: asset => asset.deleted || asset.id === draft.id ? createAssetNode(asset) : asset,
      reportSaveError: setEdgeError,
      finish: id => finishEdit(draft.id, id),
      close: () => draft.edit ? setSelected([]) : closeDraft(draft.id),
    }
  }
  const graphNodes = visible.map(node => {
    const draft = !node.deleted && selected.length === 1 && selected[0] === node.id
      ? { id: node.id, base: node, edit: true, group: node } : null
    return {
      id: node.id,
      type: 'drama',
      position: positions[node.id] ?? defaultPositions[node.id],
      selected: selected.includes(node.id),
      className: 'drama-flow-node' + (editorFocus?.id === node.id ? ' is-editor-focused' : ''),
      draggable: !lockReason(node.id),
      dragHandle: '.drama-node-card',
      ariaLabel: nodeTitle(node) || nodeLabels[node.type],
      data: {
        node, compact: compact.includes(node.id), isFocused: editorFocus?.id === node.id,
        actions: node.deleted ? { preview: setPreview, locate } : { ...actions, mutationReason: lockReason(node.id) },
        draft, editor: draft && editorFor(draft), rename: rename?.id === node.id ? rename.token : undefined,
        referenceFocus: referenceFocus?.id === node.id ? referenceFocus.token : undefined,
        index, edges, resolvedMedia, mediaURL, generationProfiles, generationDefaults,
        tasks: taskIndex.get(node.id), selectedResult: selectedResultIds.has(node.id),
      },
    }
  })
  for (const draft of drafts) {
    const type = draft.preset?.type ?? draft.base?.type ?? 'shot'
    const node = { ...draft.group, ...draft.base, id: draft.id, type,
      content: {
        ...(draft.base?.type === type ? draft.base.content : {}),
        ...(draft.preset?.mode ? { mode: draft.preset.mode } : {}),
      } }
    const editor = editorFor(draft)
    graphNodes.push({ id: draft.id, type: 'drama', position: positions[draft.id] ?? draft.at, selected: selected.includes(draft.id),
      className: 'drama-flow-node', dragHandle: '.drama-node-card',
      ariaLabel: (draft.edit ? '编辑 ' : '未保存 ') + nodeLabels[type],
      data: { node, draft: selected.includes(draft.id) ? draft : null, editor, actions: {
        ...actions, edit: () => selectNode(draft.id), delete: () => closeDraft(draft.id),
        upload: undefined, chooseAsset: undefined,
      }, rename: rename?.id === draft.id ? rename.token : undefined,
      index, edges, resolvedMedia, mediaURL, generationProfiles, generationDefaults } })
  }

  const graphEdges = visibleReferences
    .map(edge => ({
      ...edge, id: edgeId(edge), sourceHandle: 'out', targetHandle: 'in', type: 'smoothstep',
      selected: selectedEdges.includes(edgeId(edge)), markerEnd: { type: MarkerType.ArrowClosed, width: 15, height: 15 },
      className: mediaTypes.has(index.get(edge.source)?.type) ? 'drama-edge-media' : 'drama-edge-reference',
      reconnectable: canChangeEdge(edge) ? 'source' : false,
      data: { revision: index.get(edge.target).revision },
    }))
  for (const { source, target } of visibleVersions) {
    graphEdges.push({ id: `version:${target}`, source, target,
      sourceHandle: 'out', targetHandle: 'lineage', label: '派生', type: 'smoothstep',
      className: 'drama-edge-version', selectable: false, reconnectable: false })
  }

  useEffect(() => {
    if (!focusId) return
    let frame
    let attempts = 0
    function fit() {
      const node = flow.current?.getNode(focusId)
      if (node?.measured?.width) {
        centerEditor(node.position, node.measured.width)
        setFocusId(null)
      } else if (++attempts < 32) frame = requestAnimationFrame(fit)
      else setFocusId(null)
    }
    frame = requestAnimationFrame(fit)
    return () => cancelAnimationFrame(frame)
  }, [focusId, index, drafts])

  useEffect(() => {
    if (!editorFocus) return
    let frame
    let attempts = 0
    function fitEditor() {
      const instance = flow.current
      const { card } = editorFocus
      const canvas = surface.current?.getBoundingClientRect()
      const box = card.getBoundingClientRect()
      if (!focusOrigin.current || !instance || !canvas?.width || !canvas.height || !box.width || !box.height) return
      const panel = card.querySelector('.drama-node-editor-panel')?.getBoundingClientRect()
      if (!panel?.height && ++attempts < 12) {
        frame = requestAnimationFrame(fitEditor)
        return
      }
      const zoom = instance.getZoom()
      const origin = instance.screenToFlowPosition({ x: box.left, y: box.top }, { snapToGrid: false })
      const content = {
        ...origin,
        width: Math.max(box.width, panel?.width ?? 0) / zoom,
        height: (box.height + (panel?.height ?? 0)) / zoom + (panel ? 7 : 0),
      }
      const next = getViewportForBounds(content, canvas.width, canvas.height, minZoom, 1.55, {
        x: '26px', top: '56px', bottom: '48px',
      })
      void instance.setViewport(next, { duration: focusDuration(), interpolate: 'linear' })
    }
    frame = requestAnimationFrame(fitEditor)
    return () => cancelAnimationFrame(frame)
  }, [editorFocus])

  function focusEditor(event, graph) {
    if (!flow.current || graph.id.startsWith('draft-') || graph.data.node.deleted || !(event.target instanceof Element)) return
    if (event.target.closest('button, input, textarea, select, a, video, audio, [contenteditable], [role="button"], .drama-node-editor-panel, .react-flow__handle')) return
    const card = event.target.closest('.drama-node-card')
    if (!card) return
    event.preventDefault()
    focusOrigin.current ??= flow.current.getViewport()
    setFocusId(null)
    selectNode(graph.id)
    setEditorFocus({ id: graph.id, card })
    surface.current?.focus({ preventScroll: true })
  }

  function exitEditorFocus() {
    const origin = focusOrigin.current
    if (!origin) return
    focusOrigin.current = null
    setEditorFocus(null)
    void flow.current?.setViewport(origin, { duration: focusDuration(), interpolate: 'linear' })
    surface.current?.focus({ preventScroll: true })
  }

  useEffect(() => {
    if (!editorFocus) return
    const canvas = surface.current
    const document = canvas.ownerDocument
    const composition = observeComposition(document)
    function escapeFromBody(event) {
      if (event.target !== document.body || event.key !== 'Escape' || event.defaultPrevented ||
          composition.guards(event) || isBehindModal(canvas) || picker || contextNode || contextEdge) return
      event.preventDefault()
      exitEditorFocus()
    }
    document.addEventListener('keydown', escapeFromBody)
    return () => {
      document.removeEventListener('keydown', escapeFromBody)
      composition.dispose()
    }
  }, [editorFocus, picker, contextNode, contextEdge])

  function applyNodeChanges(changes) {
    const moves = changes.filter(change => change.type === 'position' && change.position && !lockReason(change.id))
    if (moves.length) setPositions(current => ({
      ...current, ...Object.fromEntries(moves.map(change => [change.id, change.position])),
    }))
    const choices = changes.filter(change => change.type === 'select')
    if (choices.length) setSelected(current => {
      const ids = new Set(current)
      for (const { id, selected: chosen } of choices) chosen ? ids.add(id) : ids.delete(id)
      return [...ids]
    })
  }

  function selectNode(id) {
    setSelected([id])
    setSelectedEdges([])
  }

  function renameNode(id) {
    selectNode(id)
    setRename({ id, token: crypto.randomUUID() })
  }

  function pinLayout() {
    setPositions(current => ({
      ...Object.fromEntries(graphNodes.filter(graph => !graph.id.startsWith('draft-')).map(graph => [graph.id, graph.position])),
      ...current,
    }))
  }

  function record(command) {
    history.current.undo.push(command)
    if (history.current.undo.length > 60) history.current.undo.shift()
    history.current.redo.length = 0
  }

  async function runCanvas(work) {
    if (writing.current) return
    writing.current = true
    setEdgeError('')
    try {
      return await work()
    } catch (failure) {
      setEdgeError(failure.message)
    } finally {
      writing.current = false
    }
  }

  function trackRevisions(result) {
    if (result.id && result.revision) latestRevisions.current.set(result.id, result.revision)
    for (const node of result.nodes ?? []) latestRevisions.current.set(node.id, node.revision)
    for (const edge of result.edges ?? []) latestRevisions.current.set(edge.target, edge.revision)
    for (const id of result.ids ?? []) latestRevisions.current.set(id, 1)
    return result
  }

  async function changeGraph(action, graph, currentSnapshot = false) {
    const revision = (id, fallback) => currentSnapshot ? index.get(id)?.revision ?? fallback
      : latestRevisions.current.get(id) ?? fallback
    return trackRevisions(await mutate(action, {
      nodes: graph.nodes.map(item => ({ id: item.id, revision: revision(item.id, item.revision) })),
      edges: graph.edges.map(({ source, target, position, revision: previous }) => ({
        source, target, position, revision: revision(target, previous),
      })),
    }))
  }

  async function appendWithHistory(data) {
    pinLayout()
    const result = trackRevisions(await append(data))
    const added = new Set(result.ids)
    let graph = {
      nodes: result.ids.map(id => ({ id, revision: 1 })),
      edges: (data.edges ?? []).filter(edge => !added.has(edge.source) && !added.has(edge.target))
        .map(edge => ({ ...edge, revision: (index.get(edge.target)?.revision ?? 0) + 1 })),
    }
    for (const edge of graph.edges) latestRevisions.current.set(edge.target, edge.revision)
    record({
      undo: async () => { graph = await changeGraph('canvas_delete', graph) },
      redo: async () => { graph = await changeGraph('canvas_restore', graph) },
    })
    return result
  }

  async function editWithHistory(action, data, committed) {
    if (action !== 'update_node') return trackRevisions(await mutate(action, data))
    const base = committed ?? index.get(data.id)
    const previous = { id: base.id, ...groupOf(base), content: base.content,
      referenceSources: mutableSources(base) ? referenceIds(base) : undefined }
    const result = trackRevisions(await mutate(action, data))
    const restore = async patch => trackRevisions(await mutate(action, {
      ...patch, revision: latestRevisions.current.get(data.id),
    }))
    record({ undo: () => restore(previous), redo: () => restore(data) })
    return result
  }

  async function stepHistory(redo) {
    const from = redo ? history.current.redo : history.current.undo
    const to = redo ? history.current.undo : history.current.redo
    const command = from.at(-1)
    if (!command) return
    await runCanvas(async () => {
      await (redo ? command.redo() : command.undo())
      from.pop()
      to.push(command)
    })
  }

  function pointOnCanvas(event) {
    return flow.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY })
  }

  function nextPosition() {
    const bounds = surface.current?.getBoundingClientRect()
    return bounds && pointOnCanvas({
      clientX: bounds.left + Math.max(24, (bounds.width - 320) / 2),
      clientY: bounds.top + Math.min(100, bounds.height / 4),
    }) || { x: 34, y: 92 }
  }

  function centerEditor(at, cardWidth = 320) {
    const { width, height } = surface.current.getBoundingClientRect()
    if (width <= 36 || height <= 0) return
    const zoom = Math.min(1.02, (width - 36) / cardWidth, Math.max(.45, (height - 90) / 490))
    const top = Math.min(94, Math.max(44, height * .12))
    flow.current?.setCenter(at.x + cardWidth / 2, at.y + (height / 2 - top) / zoom, { zoom, duration: 0 })
  }

  function placeNew(id, at, focus) {
    const point = availablePosition(at ?? nextPosition(), { width: 320, height: 260 },
      graphNodes.map(graph => ({ ...dimensions(graph.data.node), ...graph.position })))
    setPositions(current => ({ ...current, [id]: point }))
    if (focus) {
      selectNode(id)
      setFocusId(id)
    }
  }

  function revealNew(items) {
    const { id, q, taskStatus, type, createdBySession, offset, ...view } = filters
    for (const [field] of groupFields) {
      if (view[field] && items.some(node => node[field] !== view[field])) delete view[field]
    }
    if (type && items.every(node => node.type === type)) view.type = type
    if (id || q || taskStatus || createdBySession || offset || view.type !== type ||
        groupFields.some(([field]) => view[field] !== filters[field])) setFilters(view)
    const groups = new Set(items.map(shotLabel))
    setCollapsed(current => current.filter(group => !groups.has(group)))
  }

  async function createMedia(file, at, focus = true) {
    const type = mediaKind(file)
    if (!mediaTypes.has(type)) throw new Error('请选择支持的图片、视频或音频文件')
    const content = await uploadFile(type, file)
    const node = { id: crypto.randomUUID(), type, content, ...groupFor(null, filters) }
    await appendWithHistory({ nodes: [node] })
    if (focus) revealNew([node])
    placeNew(node.id, at, focus)
    return { ...node, revision: 1 }
  }

  async function assignAsset(node, asset) {
    const { path, url } = asset
    const title = nodeTitle(node)
    const defaultTitle = presets.find(preset => preset.type === node.type && (preset.mode ?? '') === videoMode(node))?.label
    const content = { ...node.content, path, url, title: title && title !== defaultTitle ? title : asset.title || title }
    await editWithHistory('update_node', { id: node.id, revision: node.revision, ...groupOf(node), content })
  }

  async function createAssetNode(asset, at, focus = false) {
    const { path, url, title } = asset.content
    const node = { id: crypto.randomUUID(), type: asset.type, content: { path, url, title }, ...groupFor(null, filters) }
    await appendWithHistory({ nodes: [node] })
    if (focus) revealNew([node])
    placeNew(node.id, at, focus)
    return { ...node, revision: 1 }
  }

  async function pickAsset(asset) {
    await runCanvas(async () => {
      if (assetPicker.node) await assignAsset(assetPicker.node, asset.content)
      else await createAssetNode(asset, assetPicker.at, true)
      setAssetPicker(null)
    })
  }

  function openEditor(options = {}) {
    if (options.base?.deleted || options.seed?.deleted) return
    setContextNode(null)
    setContextEdge(null)
    setPicker(null)
    const id = 'draft-' + crypto.randomUUID()
    const source = options.base ?? options.seed
    const sourcePosition = source && graphNodes.find(node => node.id === source.id)?.position
    const point = options.at ?? (sourcePosition ? { x: sourcePosition.x + gapX, y: sourcePosition.y } : nextPosition())
    const at = availablePosition(point, { width: 320, height: 470 }, graphNodes.map(graph => {
      const measured = flow.current?.getNode(graph.id)?.measured
      return { ...graph.position, width: measured?.width ?? 320,
        height: measured?.height ?? (graph.data.draft ? 470 : dimensions(graph.data.node).height) }
    }))
    const group = options.group ?? { episodeId: filters.episodeId, sceneId: filters.sceneId, shotId: filters.shotId }
    setFocusId(null)
    centerEditor(at)
    setDrafts(current => current.some(draft => draft.id === id) ? current : [...current, { ...options, id, at, group }])
    selectNode(id)
  }

  function closeDraft(draftId) {
    setDrafts(current => current.filter(item => item.id !== draftId))
    setSelected(current => current.filter(id => id !== draftId))
    if (draftId.startsWith('draft-')) setPositions(current => {
      const { [draftId]: _local, ...rest } = current
      return rest
    })
  }

  function finishEdit(draftId, id) {
    const draft = drafts.find(item => item.id === draftId)
    const at = positions[draftId] ?? draft?.at
    closeDraft(draftId)
    if (at) setPositions(current => ({ ...current, [id]: at }))
    if (draft) {
      revealNew([{ ...groupFor(draft.base ?? draft.group, filters), type: draft.preset?.type ?? draft.base?.type }])
      selectNode(id)
      setFocusId(id)
    }
  }

  function openPicker(event, seed, rect) {
    if (seed?.deleted) return
    setContextNode(null)
    setContextEdge(null)
    const point = event && ('clientX' in event ? event : event.changedTouches[0])
    const at = point && flow.current?.screenToFlowPosition({ x: point.clientX, y: point.clientY })
    setPicker({ at, seed, anchor: point || rect ? null : addAnchor.current,
      rect: point ? new DOMRect(point.clientX, point.clientY, 1, 1) : rect })
  }

  function choosePreset(preset) {
    const { at, seed } = picker
    setPicker(null)
    void runCanvas(async () => {
      const id = crypto.randomUUID()
      const { type, mode } = preset
      const content = { title: preset.label }
      if (type === 'video') content.mode = seed && mode === '' ? defaultVideoInputMode(seed.type) : mode
      const node = { id, type, content, ...groupFor(seed, filters) }
      const edges = []
      if (seed && type !== 'audio') {
        edges.push({ source: seed.id, target: id })
        if (type === 'video' || type === 'shot' && seed.type === 'image') content.mixedListOrder = [seed.id]
      }
      await appendWithHistory({ nodes: [node], edges })
      revealNew([node])
      const source = seed && graphNodes.find(graph => graph.id === seed.id)?.position
      placeNew(id, at ?? (source && { x: source.x + gapX, y: source.y }), true)
    })
  }

  function defaultVideoInputMode(kind) {
    const preferred = { image: 'i2v', video: 'v2v', audio: 'r2v' }[kind]
    const configured = mode => profileCandidates(generationProfiles, mode).filter(profile => profile.configured)
    if (preferred !== 'r2v' && !configured(preferred).length &&
        configured('r2v').some(profile => referenceLimit('r2v', kind, profile) > 0)) return 'r2v'
    return preferred
  }

  function linkPlan({ source, target, targetHandle }) {
    if (targetHandle && targetHandle !== 'in') return { error: '请连接到节点输入端口' }
    const from = index.get(source)
    const to = index.get(target)
    if (!from || !to || from.deleted || to.deleted || source === target) return { error: '请选择另一个可用节点' }
    if (lockReason(target)) return { error: lockReason(target) }
    if (edges.some(edge => edge.source === source && edge.target === target) || referenceIds(to).includes(source)) {
      return { error: '此来源已连接' }
    }
    const original = reconnecting.current
    if (original && (original.target !== target || !canChangeEdge(original))) return { error: '此连线暂不可更改' }
    const ordered = original
      ? referenceIds(to).map(id => id === original.source ? source : id)
      : [...referenceIds(to), source]
    const content = { ...to.content }
    const kinds = ordered.map(id => index.get(id)?.type)
    if (to.type === 'video') {
      if (!mediaTypes.has(from.type)) return { error: '视频节点只接受图片、视频或音频输入' }
      const mode = videoMode(to)
      if (mode === 'asset') return { error: '请先为视频节点选择生成方式' }
      const nextMode = !mode || mode === 't2v' ? defaultVideoInputMode(from.type) : mode
      const profile = resolveProfile(profileCandidates(generationProfiles, nextMode), nextMode === mode ? content.profileId : undefined)
      const count = kind => kinds.filter(item => item === kind).length
      if (kinds.length > (profile?.limits?.maxReferences || 32) ||
          [...new Set(kinds)].some(kind => count(kind) > referenceLimit(nextMode, kind, profile))) {
        return { error: '当前生成方式或模型无法接收该素材，请检查参考类型与数量' }
      }
      if (nextMode !== mode) {
        content.mode = nextMode
        delete content.profileId
        delete content.params
      }
      delete content.textList
    } else if (to.type === 'image') {
      if (from.type !== 'image' && !textTypes.has(from.type)) return { error: '图片节点只接受图片与文本输入' }
      const profile = resolveProfile(profileCandidates(generationProfiles, 't2i'), content.profileId)
      const limit = profile ? profile.limits?.references?.image ?? 0 : 32
      if (kinds.filter(kind => kind === 'image').length > limit) return { error: '当前图片模型已达到参考图上限或不支持参考图' }
    } else if (to.type === 'shot' && from.type !== 'image' || to.type === 'audio') {
      return { error: '此节点不接受该来源' }
    }
    return { to, ordered, content }
  }

  const canLink = connection => !linkPlan(connection).error

  async function connect(connection) {
    const { source, target } = connection
    const { to, ordered, content, error } = linkPlan(connection)
    if (error) { setEdgeError(error); return }
    await runCanvas(async () => {
      pinLayout()
      if (mutableSources(to)) {
        await editWithHistory('update_node', { id: target, revision: to.revision, ...groupOf(to),
          content, referenceSources: ordered })
      } else {
        await appendWithHistory({ edges: [{ source, target }] })
      }
      selectNode(target)
    })
  }

  function connectEnd(event, connection) {
    if (reconnecting.current || connection.isValid || connection.fromHandle?.type !== 'source') return
    if (connection.toNode) {
      const { error } = linkPlan({ source: connection.fromNode?.id, target: connection.toNode.id,
        targetHandle: connection.toHandle?.id })
      if (error) setEdgeError(error)
      return
    }
    const element = event.target instanceof Element ? event.target : null
    const target = element?.closest('.react-flow__node')?.getAttribute('data-id')
    if (target) {
      const { error } = linkPlan({ source: connection.fromNode?.id, target })
      if (error) setEdgeError(error)
      return
    }
    if (!element?.classList.contains('react-flow__pane')) return
    const node = index.get(connection.fromNode?.id)
    if (node) openPicker(event, node)
  }

  function canChangeEdge(edge) {
    const source = index.get(edge.source)
    const target = index.get(edge.target)
    return !lockReason(edge.target) && source && target && !source.deleted && !target.deleted
  }

  async function reconnect(edge, connection) {
    if (edge.target !== connection.target || !canChangeEdge(edge)) return
    if (mutableSources(index.get(edge.target))) return connect(connection)
    await runCanvas(async () => {
      const { error } = linkPlan(connection)
      if (error) throw new Error(error)
      const swap = async (source, newSource, revision) => trackRevisions(await mutate('update_edge', {
        source, newSource, target: edge.target, revision,
      }))
      await swap(edge.source, connection.source, edge.data.revision)
      record({
        undo: () => swap(connection.source, edge.source, latestRevisions.current.get(edge.target)),
        redo: () => swap(edge.source, connection.source, latestRevisions.current.get(edge.target)),
      })
    })
  }

  function openRemoval(item) {
    const issue = removalLock(item)
    if (issue) { setEdgeError(issue); return }
    setContextNode(null)
    setContextEdge(null)
    setRemovalError('')
    setRemoval(item)
  }

  function removalLock(item) {
    const nodeIds = new Set(item.nodes.map(node => node.id))
    return [...nodeIds, ...item.edges.map(edge => edge.target),
      ...edges.filter(edge => nodeIds.has(edge.source)).map(edge => edge.target)]
      .map(lockReason).find(Boolean)
  }

  async function removeItems(item) {
    const issue = removalLock(item)
    if (issue) throw new Error(issue)
    const ids = new Set(item.nodes.map(node => node.id))
    const existing = item.nodes.filter(node => !node.id.startsWith('draft-'))
    if (existing.length || item.edges.length) {
      pinLayout()
      let graph = await changeGraph('canvas_delete', { nodes: existing, edges: item.edges }, true)
      record({
        undo: async () => { graph = await changeGraph('canvas_restore', graph) },
        redo: async () => { graph = await changeGraph('canvas_delete', graph) },
      })
    }
    for (const id of ids) if (id.startsWith('draft-')) closeDraft(id)
    setSelected(current => current.filter(id => !ids.has(id)))
    setSelectedEdges([])
    if (ids.has(filters.id)) setFilters({})
  }

  async function confirmRemoval() {
    if (writing.current || removing) return
    writing.current = true
    setRemoving(true)
    setRemovalError('')
    try {
      await removeItems(removal)
      setRemoval(null)
    } catch (failure) {
      setRemovalError(failure.message)
    } finally {
      writing.current = false
      setRemoving(false)
    }
  }

  function locate(id) {
    const node = index.get(id)
    if (!nodes.some(node => node.id === id)) setFilters({ id })
    else if (node) setCollapsed(current => current.filter(group => group !== shotLabel(node)))
    setSelected([id])
    setFocusId(id)
  }

  function filter(field, value) {
    const { id: _located, ...rest } = filters
    setFilters({ ...rest, [field]: value, offset: 0 })
  }

  function fitSelection() {
    setFocusId(null)
    const selection = graphNodes.filter(node => node.selected)
    flow.current?.fitView({ nodes: selection.length ? selection : undefined, maxZoom: 1.15, padding: .2, duration: 160 })
  }

  function fitCanvas() {
    setFocusId(null)
    flow.current?.fitView({ maxZoom: 1.08, padding: .23, duration: 160 })
  }

  function arrange() {
    if (!ordered.length) return
    const measured = ordered.map(node => {
      const size = flow.current?.getNode(node.id)?.measured
      const estimate = dimensions(node)
      return { id: node.id, width: size?.width ?? estimate.width, height: size?.height ?? estimate.height }
    })
    const before = Object.fromEntries(graphNodes.filter(node => !lockReason(node.id)).map(node => [node.id, node.position]))
    const after = Object.fromEntries(Object.entries(layoutCanvas(measured, relations)).filter(([id]) => !lockReason(id)))
    setPositions(current => ({ ...current, ...after }))
    recordMove(before, after)
  }

  function toggleCompact(ids) {
    if (!ids.length) return
    const collapse = ids.some(id => !compact.includes(id))
    setCompact(current => collapse ? [...new Set([...current, ...ids])] : current.filter(id => !ids.includes(id)))
  }

  function recordMove(before, after) {
    const apply = changes => {
      if (Object.keys(changes).some(id => latestLocks.current.has(id))) throw new Error('执行中使用的节点暂不可移动')
      setPositions(current => ({ ...current, ...changes }))
    }
    record({ undo: () => apply(before), redo: () => apply(after) })
  }

  function startMove(_event, node, moving) {
    setFocusId(null)
    gesture.current = Object.fromEntries((moving ?? [node]).filter(item => !lockReason(item.id)).map(item => [
      item.id, graphNodes.find(graph => graph.id === item.id)?.position ?? item.position,
    ]))
  }

  function finishMove(_event, node, moving) {
    const before = gesture.current
    gesture.current = null
    if (!before) return
    const after = Object.fromEntries((moving ?? [node]).filter(item => before[item.id]).map(item => [item.id, item.position]))
    if (Object.entries(after).some(([id, at]) => at.x !== before[id]?.x || at.y !== before[id]?.y)) recordMove(before, after)
  }

  function copyData(ids) {
    const list = graphNodes.filter(node => ids.includes(node.id) && !node.id.startsWith('draft-') && !node.data.node.deleted)
    if (!list.length) return
    const byId = new Set(list.map(graph => graph.id))
    return {
      canvasId: status.canvasId,
      nodes: list.map(({ data: { node }, position }) => {
        const content = { ...node.content }
        delete content.providerTaskId
        if (node.type === 'video') delete content.textList
        return { id: node.id, type: node.type, content, position, ...groupOf(node) }
      }),
      edges: edges.filter(edge => byId.has(edge.target) &&
        (index.get(edge.target)?.type !== 'video' || mediaTypes.has(index.get(edge.source)?.type))),
    }
  }

  function copyNodes(ids) {
    const data = copyData(ids)
    if (!data) return
    copied.current = data
    if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
      void navigator.clipboard.write([new ClipboardItem({
        [clipboardType]: new Blob([JSON.stringify(data)], { type: 'application/x-dsh-drama-nodes+json' }),
      })]).catch(() => {})
    }
  }

  async function pasteNodes(data) {
    if (data?.canvasId !== status.canvasId || !data.nodes?.length) return
    const ids = new Map(data.nodes.map(node => [node.id, crypto.randomUUID()]))
    const outgoing = id => ids.get(id) ?? id
    const nodesToAdd = data.nodes.map(({ id, position, ...node }) => {
      const content = { ...node.content }
      if (Array.isArray(content.mixedListOrder)) content.mixedListOrder = content.mixedListOrder.map(outgoing)
      return { ...node, id: ids.get(id), content }
    })
    await appendWithHistory({ nodes: nodesToAdd, edges: data.edges.map(edge => ({
      source: outgoing(edge.source), target: ids.get(edge.target),
    })) })
    revealNew(nodesToAdd)
    const nudge = 36
    let shift = nudge
    while (data.nodes.some(node => graphNodes.some(graph => graph.position.x === node.position.x + shift
      && graph.position.y === node.position.y + shift))) shift += nudge
    setPositions(current => ({ ...current, ...Object.fromEntries(data.nodes.map(node => [
      ids.get(node.id), { x: node.position.x + shift, y: node.position.y + shift },
    ])) }))
    setSelected([...ids.values()])
    setSelectedEdges([])
  }

  function importFiles(files, at) {
    void runCanvas(async () => {
      const items = []
      for (const file of files) {
        const type = mediaKind(file)
        if (!mediaTypes.has(type)) continue
        items.push({ id: crypto.randomUUID(), type, content: await uploadFile(type, file), ...groupFor(null, filters) })
      }
      if (!items.length) throw new Error('请选择支持的图片、视频或音频文件')
      await appendWithHistory({ nodes: items })
      revealNew(items)
      const start = at ?? nextPosition()
      items.forEach((node, index) => placeNew(node.id, { x: start.x + index * gapX, y: start.y }, items.length === 1))
      setSelected(items.map(node => node.id))
      setSelectedEdges([])
    })
  }

  function paste(event) {
    if (!event.currentTarget.contains(event.target)) return
    if (inEditor(event) || event.nativeEvent.isComposing) return
    const files = [...(event.clipboardData?.files ?? [])]
    if (files.length) {
      event.preventDefault()
      importFiles(files)
    } else if (!event.clipboardData?.getData('text/plain')) {
      event.preventDefault()
      void runCanvas(async () => {
        const data = await navigator.clipboard?.read?.().then(async items => {
          const item = items.find(candidate => candidate.types.includes(clipboardType))
          return item && JSON.parse(await (await item.getType(clipboardType)).text())
        }).catch(() => copied.current)
        await pasteNodes(data ?? copied.current)
      })
    }
  }

  function canvasKeys(event) {
    if (!event.currentTarget.contains(event.target)) return
    if (event.isDefaultPrevented() || event.isComposing || event.nativeEvent.isComposing ||
        event.keyCode === 229 || removal || assetPicker || preview) return
    if (event.key === 'Escape' && editorFocus && !picker && !contextNode && !contextEdge) {
      event.preventDefault()
      event.stopPropagation()
      exitEditorFocus()
      return
    }
    if (inEditor(event)) return
    const key = event.key.toLowerCase()
    const command = event.ctrlKey || event.metaKey
    if (command && ['a', 'c', 'd', 'z', 'y'].includes(key)) {
      event.preventDefault()
      event.stopPropagation()
      if (key === 'a') {
        setSelected(graphNodes.filter(node => !node.data.node.deleted).map(node => node.id))
        setSelectedEdges([])
      } else if (key === 'c') copyNodes(selected)
      else if (key === 'd') void runCanvas(() => pasteNodes(copyData(selected)))
      else void stepHistory(key === 'y' || event.shiftKey)
    } else if (key === 'delete' || key === 'backspace') {
      event.preventDefault()
      event.stopPropagation()
      const nodes = graphNodes.filter(graph => selected.includes(graph.id) && !graph.data.node.deleted).map(graph => graph.data.node)
      const edges = graphEdges.filter(edge => edge.data && selectedEdges.includes(edge.id))
      if (nodes.length || edges.length) void runCanvas(() => removeItems({ nodes, edges }))
    } else if (event.shiftKey && key === 'a') {
      event.preventDefault()
      openPicker()
    } else if (event.key === '.') {
      event.preventDefault()
      fitSelection()
    } else if (event.key === 'Escape') {
      setPicker(null)
      setContextNode(null)
      setContextEdge(null)
      setSelected([])
      setSelectedEdges([])
    }
  }

  return <div className="drama-canvas-content">
    <style>{flowStyle + '\n' + canvasStyle + '\n' + cardStyle}</style>
    <div ref={surface} className="drama-flow" role="region" aria-label="创作节点画布" tabIndex={0}
      data-focused-node={editorFocus?.id}
      onKeyDown={canvasKeys} onPaste={paste}
      onPointerDownCapture={event => {
        if (!event.currentTarget.contains(event.target)) return
        if (event.button === 0 && !inEditor(event) &&
            event.target instanceof Element && !event.target.closest('button, .nodrag')) surface.current?.focus({ preventScroll: true })
      }}
      onDragOver={event => {
        if (!event.currentTarget.contains(event.target)) return
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
        }
      }}
      onDrop={event => {
        if (!event.currentTarget.contains(event.target)) return
        if (!event.dataTransfer.files.length) return
        event.preventDefault()
        importFiles([...event.dataTransfer.files], pointOnCanvas(event))
      }}
      onDoubleClick={event => {
        if (event.target instanceof Element && event.target.classList.contains('react-flow__pane')) openPicker(event)
      }}>
      <ReactFlow nodes={graphNodes} edges={graphEdges} nodeTypes={nodeTypes}
        onInit={instance => { flow.current = instance }}
        onNodesChange={applyNodeChanges} onConnect={connect} onConnectEnd={connectEnd} isValidConnection={canLink}
        onNodeDoubleClick={focusEditor}
        onEdgesChange={changes => {
          const choices = changes.filter(change => change.type === 'select')
          if (choices.length) setSelectedEdges(current => {
            const ids = new Set(current)
            for (const change of choices) change.selected ? ids.add(change.id) : ids.delete(change.id)
            return [...ids]
          })
        }}
        onNodeDragStart={startMove} onNodeDragStop={finishMove}
        onEdgeClick={(event, edge) => {
          if (!edge.data) return
          surface.current?.focus({ preventScroll: true })
          if (!event.shiftKey && !event.ctrlKey && !event.metaKey) {
            setSelected([])
            setSelectedEdges([edge.id])
          }
        }}
        onSelectionDragStart={(event, nodes) => startMove(event, null, nodes)}
        onSelectionDragStop={(event, nodes) => finishMove(event, null, nodes)}
        onPaneClick={() => {
          setPicker(null); setContextNode(null); setContextEdge(null); setSelected([]); setSelectedEdges([])
        }}
        onPaneContextMenu={event => { event.preventDefault(); openPicker(event) }}
        onNodeContextMenu={(event, node) => {
          event.preventDefault()
          setPicker(null)
          setContextEdge(null)
          if (!selected.includes(node.id)) selectNode(node.id)
          if (node.id.startsWith('draft-') || node.data.node.deleted) {
            setContextNode(null)
            return
          }
          setContextNode({ id: node.id, rect: new DOMRect(event.clientX, event.clientY, 1, 1) })
        }}
        onEdgeContextMenu={(event, edge) => {
          event.preventDefault()
          setPicker(null)
          setContextNode(null)
          if (!edge.data) {
            setContextEdge(null)
            return
          }
          setContextEdge({ edge, rect: new DOMRect(event.clientX, event.clientY, 1, 1) })
        }}
        onReconnectStart={(_event, edge) => { reconnecting.current = edge }}
        onReconnect={reconnect}
        onReconnectEnd={() => { reconnecting.current = null }}
        deleteKeyCode={null} panActivationKeyCode="Space" minZoom={minZoom} maxZoom={maxZoom} zoomOnDoubleClick={false}
        autoPanOnNodeFocus={false}
        snapToGrid snapGrid={grid} multiSelectionKeyCode={['Shift', 'Control', 'Meta']} selectionOnDrag={boxSelect}
        selectionMode={SelectionMode.Partial} panOnDrag={!boxSelect}>
        <Background color="var(--dsw-alias-border-l2)" gap={20} size={1} />
        {showMap && <MiniMap pannable zoomable position="bottom-right" style={{ width: 108, height: 70 }}
          nodeClassName={node => `drama-map-${node.data.node.type}`} />}
      </ReactFlow>
      {!graphNodes.length && <div className="drama-v2-canvas-empty">
        <p>{nodes.length ? '所选分组已折叠' : '从一个创作节点开始'}</p>
        <Button type="button" size="sm" variant="outline" onClick={() => openPicker()}>新增节点</Button>
      </div>}
      <CanvasToolbar filters={filters} update={filter} filterGroup={setFilters} groups={groups} collapsed={collapsed}
        toggleGroup={group => setCollapsed(current => current.includes(group) ? current.filter(id => id !== group) : [...current, group])}
        fit={fitCanvas} arrange={arrange} add={() => openPicker()} setAddAnchor={addAnchor}
        chooseAsset={() => setAssetPicker({})}
        tasksOpen={tasksOpen} toggleTasks={() => setTasksOpen(value => !value)} activeTasks={tasks.filter(taskActive).length} />
      <CanvasCorners showMap={showMap} toggleMap={() => setShowMap(value => !value)} boxSelect={boxSelect}
        toggleBox={() => setBoxSelect(value => !value)} selected={selected}
        compact={selected.every(id => compact.includes(id))} toggleCompact={() => toggleCompact(selected)} />
      <div className="drama-v2-pager nodrag nopan nowheel">
        {editorFocus && <Button type="button" size="sm" variant="outline" title="退出聚焦 · Esc"
          onClick={exitEditorFocus}>退出聚焦</Button>}
        {filters.id && <Button type="button" size="sm" variant="ghost" onClick={() => setFilters({})}>清除定位</Button>}
        <span>{visible.length} 个节点{selected.length ? ` · 已选 ${selected.length}` : ''}</span>
        {offset > 0 && <Button type="button" size="sm" variant="ghost"
          onClick={() => setFilters({ ...filters, offset: Math.max(0, offset - pageSize) })}>上一页</Button>}
        {hasMore && <Button type="button" size="sm" variant="ghost"
          onClick={() => setFilters({ ...filters, offset: offset + pageSize })}>下一页</Button>}
        <Button type="button" size="sm" variant="ghost" aria-label="缩小" title="缩小" onClick={() => flow.current?.zoomOut({ duration: 130 })}>−</Button>
        <IconButton label="放大" icon={IconPlusOutlineRegular} onClick={() => flow.current?.zoomIn({ duration: 130 })} />
      </div>
      {edgeError && <p className="drama-v2-canvas-error" role="alert">{edgeError}</p>}
      {picker && <CanvasPicker key={picker.seed?.id ?? 'all'} picker={picker} choose={choosePreset}
        presets={presets.filter(item => {
          if (!picker.seed) return true
          if (item.type !== 'video') return item.type !== 'image' || picker.seed.type === 'image' || textTypes.has(picker.seed.type)
          if (item.mode === 'asset' || !mediaTypes.has(picker.seed.type)) return false
          const mode = defaultVideoInputMode(picker.seed.type)
          return referenceLimit(mode, picker.seed.type, resolveProfile(profileCandidates(generationProfiles, mode))) > 0
        })}
        close={() => setPicker(null)} />}
      {contextNode && index.has(contextNode.id) && <Menu open portal compact
        anchor={<span className="drama-v2-picker-anchor" />} getAnchorRect={() => contextNode.rect} onClose={() => setContextNode(null)}
        items={[
          ...(lockReason(contextNode.id) ? [{ id: 'activity', type: 'label', text: lockReason(contextNode.id) }] : []),
          { id: 'rename', label: '重命名', disabled: Boolean(lockReason(contextNode.id)) },
          { id: 'edit', label: '编辑节点' },
          { id: 'delete', label: '删除节点 · Delete', disabled: Boolean(lockReason(contextNode.id)), danger: true },
          { id: 'copy', label: '复制 · Ctrl+C' }, { id: 'duplicate', label: '复制为新节点 · Ctrl+D' },
          { id: 'references', label: '添加参考素材', disabled: Boolean(lockReason(contextNode.id)) ||
            !mutableSources(index.get(contextNode.id)) },
          { id: 'view', label: '查看素材', disabled: !isMedia(index.get(contextNode.id)) && !resolvedMedia.has(contextNode.id) },
          { id: 'revise', label: '派生版本' },
          { id: 'compact', label: '折叠或展开' }, { id: 'next', label: '新增后继节点' },
        ]} onSelect={id => {
          const node = index.get(contextNode.id)
          if (id === 'compact') { toggleCompact([node.id]); setContextNode(null) }
          else if (id === 'next') openPicker(undefined, node, contextNode.rect)
          else if (id === 'delete') openRemoval({ nodes: [node], edges: [] })
          else {
            setContextNode(null)
            if (id === 'edit') selectNode(node.id)
            else if (id === 'rename') renameNode(node.id)
            else if (id === 'references') {
              selectNode(node.id)
              setReferenceFocus({ id: node.id, token: crypto.randomUUID() })
            }
            else if (id === 'view') setPreview(isMedia(node) ? node : resolvedMedia.get(node.id))
            else if (id === 'copy') copyNodes(selected.includes(node.id) ? selected : [node.id])
            else if (id === 'duplicate') actions.duplicate(node)
            else openEditor({ base: node })
          }
        }} />}
      {contextEdge && <Menu open portal compact
        anchor={<span className="drama-v2-picker-anchor" />} getAnchorRect={() => contextEdge.rect}
        onClose={() => setContextEdge(null)}
        items={[
          { id: 'hint', type: 'label', text: lockReason(contextEdge.edge.target) || '拖动连线起点可更换来源' },
          { id: 'delete', label: '删除连线', danger: true, disabled: !canChangeEdge(contextEdge.edge) },
        ]}
        onSelect={() => openRemoval({ nodes: [], edges: [contextEdge.edge] })} />}
      {tasksOpen && <TaskDrawer tasks={tasks} nodes={nodes} onLocate={id => { locate(id); setTasksOpen(false) }}
        changeTask={changeTask}
        onClose={() => setTasksOpen(false)} />}
    </div>
    {removal && <Modal open onClose={() => { if (!removing) setRemoval(null) }}
      title={removal.nodes.length ? '删除节点' : '删除连线'} closeLabel="关闭删除确认"
      footer={<>
        <Button size="sm" disabled={removing} onClick={() => setRemoval(null)}>取消</Button>
        <Button size="sm" variant="primary" disabled={removing || Boolean(removalLock(removal))}
          onClick={confirmRemoval}>{removing ? '正在删除' : '确认删除'}</Button>
      </>}>
      <div className="drama-v2-delete-content">
        <p>{removal.nodes.length ? '删除节点及其连线，保留项目素材文件和历史任务。' : '删除此连线并取消目标节点的对应引用。'}</p>
        {(removalLock(removal) || removalError) && <p role="alert">{removalError || removalLock(removal)}</p>}
      </div>
    </Modal>}
    {assetPicker && <AssetPicker type={assetPicker.type} queryCanvas={queryCanvas} mediaURL={mediaURL}
      close={() => setAssetPicker(null)} choose={pickAsset} />}
    {preview && <Modal open onClose={() => setPreview(null)} title={nodeTitle(preview) || nodeLabels[preview.type]}
      closeLabel="关闭预览" contentClassName="drama-v2-preview-modal">
      <div className="drama-v2-preview">
        {preview.type === 'image' && <img src={mediaURL(preview)} alt={nodeTitle(preview) || '图片预览'} />}
        {preview.type === 'video' && <video controls playsInline preload="metadata" src={mediaURL(preview)} aria-label="视频预览" />}
        {preview.type === 'audio' && <audio controls preload="metadata" src={mediaURL(preview)} aria-label="音频预览" />}
      </div>
    </Modal>}
  </div>
}

function AssetPicker({ type, queryCanvas, mediaURL, close, choose }) {
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [page, setPage] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      queryCanvas({ type, q: query, offset, limit: 32, mediaOnly: true }, controller.signal)
        .then(result => { if (!controller.signal.aborted) { setPage(result); setError('') } })
        .catch(failure => { if (!controller.signal.aborted) setError(failure.message) })
    }, 120)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [query, offset, type, queryCanvas])
  return <Modal open title="项目资产" closeLabel="关闭项目资产" onClose={close}>
    <div className="drama-v2-asset-picker">
      <Input autoFocus aria-label="搜索项目资产" placeholder="按名称或路径查找" value={query}
        onChange={event => { setQuery(event.target.value); setOffset(0); setPage(null) }} />
      {error && <p role="alert">{error}</p>}
      {page ? <div className="drama-v2-asset-list">{page.nodes.filter(isMedia).map(node => <button type="button"
        key={node.id} className="drama-v2-asset-option" onClick={() => choose(node)}>
        {node.type === 'image' && <img alt="" src={mediaURL(node)} loading="lazy" />}
        {node.type === 'video' && <video src={mediaURL(node)} muted playsInline preload="metadata" aria-hidden="true" />}
        <span>{nodeTitle(node) || node.content.path || nodeLabels[node.type]}</span>
      </button>)}</div> : !error && <p>正在读取项目素材…</p>}
      {page && !page.nodes.some(isMedia) && <p>没有找到可用的项目素材</p>}
      {offset > 0 && <Button size="sm" onClick={() => setOffset(value => value - 32)}>上一页</Button>}
      {page?.hasMore && <Button size="sm" onClick={() => setOffset(value => value + 32)}>下一页</Button>}
    </div>
  </Modal>
}
