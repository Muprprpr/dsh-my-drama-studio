import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Background, MiniMap, ReactFlow, SelectionMode } from '@xyflow/react'
import { Button, Menu, Modal, IconPlusOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { CanvasCorners, CanvasPicker, CanvasToolbar, IconButton } from './canvas-tools.jsx'
import flowStyle from '@xyflow/react/dist/style.css'
import canvasStyle from './canvas.css'
import { GraphNode, cardStyle } from './node-card.jsx'
import { TaskDrawer, taskActive } from './task-drawer.jsx'
import { availablePosition, layoutCanvas } from './canvas-layout.js'
import {
  isMedia, mediaTypes,
  nodeLabels, nodeTitle, presets, profileCandidates, referenceIds, referenceLimit, resolveProfile, shotLabel, videoMode,
} from './canvas-node.jsx'

const nodeTypes = { drama: GraphNode }
const emptyPositions = {}
const grid = [12, 12]
const gapX = 412

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
  snapshot, filters, setFilters, append, mutate, mutationReason, mediaURL,
  submitGeneration, changeTask, queryCanvas, generationProfiles = [], generationDefaults,
}) {
  const { nodes, edges, hasMore, status, tasks = [] } = snapshot
  const [positions, setPositions] = usePositions(`drama-layout:${status.canvasId}:${status.sessionId}`)
  const [selected, setSelected] = useState([])
  const [collapsed, setCollapsed] = useState([])
  const [compact, setCompact] = useState([])
  const [boxSelect, setBoxSelect] = useState(false)
  const [showMap, setShowMap] = useState(false)
  const [drafts, setDrafts] = useState([])
  const [preview, setPreview] = useState(null)
  const [tasksOpen, setTasksOpen] = useState(false)
  const [selectedResults, setSelectedResults] = usePositions(`drama-results:${status.canvasId}:${status.sessionId}`)
  const [picker, setPicker] = useState(null)
  const [contextNode, setContextNode] = useState(null)
  const [contextEdge, setContextEdge] = useState(null)
  const [removal, setRemoval] = useState(null)
  const [removing, setRemoving] = useState(false)
  const [removalError, setRemovalError] = useState('')
  const [focusId, setFocusId] = useState(null)
  const [edgeError, setEdgeError] = useState('')
  const flow = useRef(null)
  const addAnchor = useRef(null)
  const surface = useRef(null)
  const reconnecting = useRef(null)

  const index = useMemo(() => new Map(nodes.map(node => [node.id, node])), [nodes])
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
  const media = useMemo(() => nodes.filter(node => !node.deleted && isMedia(node)), [nodes])
  const editingIds = new Set(drafts.filter(draft => draft.edit).map(draft => draft.id))

  const visibleReferences = edges.filter(edge => visibleIds.has(edge.source) && visibleIds.has(edge.target) &&
    (index.get(edge.target).type !== 'video' || isMedia(index.get(edge.source))))
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
    edit: node => openEditor({ base: node, edit: true }),
    delete: node => openRemoval({ kind: 'node', node }),
    removeReference: (source, target) => openRemoval({
      kind: 'edge', edge: { source, target: target.id, data: { revision: target.revision } },
    }),
    revise: node => openEditor({ base: node }),
    duplicate: node => openEditor({ base: node, duplicate: true }),
    collapse: node => toggleCompact([node.id]),
    addAfter: (node, rect) => openPicker(undefined, node, rect),
    preview: setPreview,
    locate,
    selectResult: node => setSelectedResults(current => ({ ...current, [node.basedOn || node.id]: node.id })),
    submitGeneration,
    mutationReason,
  }
  const graphNodes = visible.filter(node => !editingIds.has(node.id)).map(node => ({
    id: node.id,
    type: 'drama',
    position: positions[node.id] ?? defaultPositions[node.id],
    selected: selected.includes(node.id),
    className: 'drama-flow-node',
    dragHandle: '.drama-node-titlebar',
    ariaLabel: nodeTitle(node) || nodeLabels[node.type],
    data: { node, compact: compact.includes(node.id), actions: node.deleted ? { preview: setPreview, locate } : actions,
      index, edges, mediaURL, generationProfiles, generationDefaults,
      tasks: taskIndex.get(node.id), selectedResult: selectedResultIds.has(node.id) },
  }))
  for (const draft of drafts) {
    const type = draft.preset?.type ?? draft.base?.type ?? 'shot'
    const node = { ...draft.group, ...draft.base, id: draft.id, type,
      content: draft.base?.type === type ? draft.base.content : {} }
    const editor = {
      append, mutate, mutationReason, media, queryCanvas,
      finish: id => finishEdit(draft.id, id),
      close: () => closeDraft(draft.id),
    }
    graphNodes.push({ id: draft.id, type: 'drama', position: positions[draft.id] ?? draft.at, selected: selected.includes(draft.id),
      className: 'drama-flow-node', dragHandle: '.drama-node-titlebar',
      ariaLabel: (draft.edit ? '编辑 ' : '未保存 ') + nodeLabels[type],
      data: { node, draft, editor, mediaURL, generationProfiles, generationDefaults } })
  }

  const graphEdges = visibleReferences
    .map(edge => ({
      ...edge, id: `${edge.source}:${edge.target}`, sourceHandle: 'out', targetHandle: 'in', type: 'smoothstep',
      className: isMedia(index.get(edge.source)) ? 'drama-edge-media' : 'drama-edge-reference',
      reconnectable: canChangeEdge(edge) ? 'source' : false,
      data: { revision: index.get(edge.target).revision },
    }))
  for (const { source, target } of visibleVersions) {
    graphEdges.push({ id: `version:${target}`, source, target,
      sourceHandle: 'out', targetHandle: 'lineage', label: '派生', type: 'smoothstep',
      className: 'drama-edge-version', reconnectable: false })
  }

  useEffect(() => {
    if (!focusId) return
    let frame
    let attempts = 0
    function fit() {
      const node = flow.current?.getNode(focusId)
      if (node?.measured?.width) {
        flow.current.fitView({ nodes: [{ id: focusId }], maxZoom: 1.02, padding: .17, duration: 0 })
        setFocusId(null)
      } else if (++attempts < 32) {
        if (node && attempts === 1) flow.current.setCenter(node.position.x + 160, node.position.y + 170, { zoom: .92, duration: 0 })
        frame = requestAnimationFrame(fit)
      }
    }
    frame = requestAnimationFrame(fit)
    return () => cancelAnimationFrame(frame)
  }, [focusId, index, drafts])

  function applyNodeChanges(changes) {
    const moves = changes.filter(change => change.type === 'position' && change.position)
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

  function openEditor(options = {}) {
    if (options.base?.deleted || options.seed?.deleted || options.edit && mutationReason) return
    setContextNode(null)
    setContextEdge(null)
    setPicker(null)
    const id = options.edit ? options.base.id : 'draft-' + crypto.randomUUID()
    if (options.edit && editingIds.has(id)) {
      setSelected([id])
      setFocusId(id)
      return
    }
    const source = options.base ?? options.seed
    const sourcePosition = source && graphNodes.find(node => node.id === source.id)?.position
    const bounds = surface.current?.getBoundingClientRect()
    const centered = bounds && flow.current?.screenToFlowPosition({
      x: bounds.left + Math.max(24, (bounds.width - 320) / 2),
      y: bounds.top + Math.min(100, bounds.height / 4),
    })
    const point = options.at ?? (sourcePosition ? { x: sourcePosition.x + gapX, y: sourcePosition.y } : centered)
      ?? { x: 34, y: 92 }
    const at = options.edit && sourcePosition ? sourcePosition : availablePosition(point, { width: 320, height: 470 }, graphNodes.map(graph => {
      const measured = flow.current?.getNode(graph.id)?.measured
      return { ...graph.position, width: measured?.width ?? 320,
        height: measured?.height ?? (graph.data.draft ? 470 : dimensions(graph.data.node).height) }
    }))
    const group = options.group ?? { episodeId: filters.episodeId, sceneId: filters.sceneId, shotId: filters.shotId }
    setDrafts(current => current.some(draft => draft.id === id) ? current : [...current, { ...options, id, at, group }])
    setSelected([id])
    setFocusId(id)
  }

  function closeDraft(draftId) {
    setDrafts(current => current.filter(item => item.id !== draftId))
    setSelected(current => current.filter(id => id !== draftId))
    if (!editingIds.has(draftId)) setPositions(current => {
      const { [draftId]: _local, ...rest } = current
      return rest
    })
  }

  function finishEdit(draftId, id) {
    const draft = drafts.find(item => item.id === draftId)
    const at = positions[draftId] ?? draft?.at
    closeDraft(draftId)
    if (at) setPositions(current => ({ ...current, [id]: at }))
    if (filters.id || filters.q || filters.taskStatus) {
      const { id: _located, q: _query, taskStatus: _state, ...rest } = filters
      setFilters({ ...rest, offset: 0 })
    }
    setSelected([id])
    setFocusId(id)
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
    openEditor({ at, seed, preset, group: seed })
  }

  function canLink({ source, target, targetHandle }) {
    if (targetHandle && targetHandle !== 'in') return false
    const from = index.get(source)
    const to = index.get(target)
    if (!from || !to || from.deleted || to.deleted || source === target || editingIds.has(target)
        || edges.some(edge => edge.source === source && edge.target === target)
        || referenceIds(to).includes(source)) return false
    const original = reconnecting.current
    if (original && (original.target !== target || !canChangeEdge(original))) return false
    if (to.type !== 'video') return true
    const mode = videoMode(to)
    if (mutationReason || mode === 'asset' || !isMedia(from)) return false
    if (original) return mode !== 'i2v' && mode !== 'v2v' || from.type === index.get(original.source)?.type
    return mode !== 'v2v' || from.type === 'video' && referenceIds(to).length === 0
  }

  async function connect({ source, target, targetHandle }) {
    if (!canLink({ source, target, targetHandle })) return
    const to = index.get(target)
    if (to.type === 'video') {
      const mode = videoMode(to)
      const seed = index.get(source)
      const profile = resolveProfile(profileCandidates(generationProfiles, mode), to.content.profileId)
      let nextMode = mode
      if (mode === 't2v') nextMode = seed.type === 'video' ? 'v2v' : 'r2v'
      if (mode === 'i2v' && referenceIds(to).length >= referenceLimit(mode, seed.type, profile)) nextMode = 'r2v'
      const preset = nextMode === mode ? undefined : presets.find(item => item.mode === nextMode)
      openEditor({ base: to, seed, preset, edit: true })
      return
    }
    setEdgeError('')
    try {
      await append({ edges: [{ source, target }] })
    } catch (failure) {
      setEdgeError(failure.message)
    }
  }

  function connectEnd(event, connection) {
    if (reconnecting.current) return
    if (connection.isValid || connection.toNode || connection.fromHandle?.type !== 'source') return
    const element = event.target instanceof Element ? event.target : null
    if (!element?.classList.contains('react-flow__pane')) return
    const node = index.get(connection.fromNode?.id)
    if (node) openPicker(event, node)
  }

  function canChangeEdge(edge) {
    const source = index.get(edge.source)
    const target = index.get(edge.target)
    return !mutationReason && !editingIds.has(edge.target) && source && target && !source.deleted && !target.deleted
  }

  async function reconnect(edge, connection) {
    if (edge.target !== connection.target || !canChangeEdge(edge) || !canLink(connection)) return
    setEdgeError('')
    try {
      await mutate('update_edge', {
        source: edge.source, target: edge.target, newSource: connection.source,
        revision: reconnecting.current?.data?.revision ?? edge.data.revision,
      })
    } catch (failure) {
      setEdgeError(failure.message)
    }
  }

  function openRemoval(item) {
    if (mutationReason) return
    setContextNode(null)
    setContextEdge(null)
    setRemovalError('')
    setRemoval(item)
  }

  async function confirmRemoval() {
    if (mutationReason || removing) return
    setRemoving(true)
    setRemovalError('')
    try {
      if (removal.kind === 'node') {
        const { id, revision } = removal.node
        await mutate('delete_node', { id, revision })
        setSelected(current => current.filter(selectedId => selectedId !== id))
        if (filters.id === id) setFilters({})
      } else {
        const { source, target, data } = removal.edge
        await mutate('delete_edge', { source, target, revision: data.revision })
      }
      setRemoval(null)
    } catch (failure) {
      setRemovalError(failure.message)
    } finally {
      setRemoving(false)
    }
  }

  function locate(id) {
    const node = index.get(id)
    if (!node) setFilters({ id })
    else setCollapsed(current => current.filter(group => group !== shotLabel(node)))
    setSelected([id])
    setFocusId(id)
  }

  function filter(field, value) {
    const { id: _located, ...rest } = filters
    setFilters({ ...rest, [field]: value, offset: 0 })
  }

  function fitSelection() {
    const selection = graphNodes.filter(node => node.selected)
    flow.current?.fitView({ nodes: selection.length ? selection : undefined, maxZoom: 1.15, padding: .2, duration: 160 })
  }

  function fitCanvas() {
    flow.current?.fitView({ maxZoom: 1.08, padding: .23, duration: 160 })
  }

  function arrange() {
    if (!ordered.length) return
    const measured = ordered.map(node => {
      const size = flow.current?.getNode(node.id)?.measured
      const estimate = dimensions(node)
      return { id: node.id, width: size?.width ?? estimate.width, height: size?.height ?? estimate.height }
    })
    setPositions(current => ({ ...current, ...layoutCanvas(measured, relations) }))
  }

  function toggleCompact(ids) {
    if (!ids.length) return
    const collapse = ids.some(id => !compact.includes(id))
    setCompact(current => collapse ? [...new Set([...current, ...ids])] : current.filter(id => !ids.includes(id)))
  }

  function canvasKeys(event) {
    if (event.target instanceof HTMLElement && event.target.matches('input, textarea, select, button, [contenteditable]')) return
    if (event.shiftKey && event.key.toLowerCase() === 'a') {
      event.preventDefault()
      openPicker()
    } else if (event.key === '.') {
      event.preventDefault()
      fitSelection()
    } else if (event.key === 'Escape') {
      setPicker(null)
      setContextNode(null)
      setContextEdge(null)
    }
  }

  return <div className="drama-canvas-content">
    <style>{flowStyle + '\n' + canvasStyle + '\n' + cardStyle}</style>
    <div ref={surface} className="drama-flow" role="region" aria-label="创作节点画布" tabIndex={0} onKeyDown={canvasKeys}
      onDoubleClick={event => {
        if (event.target instanceof Element && event.target.classList.contains('react-flow__pane')) openPicker(event)
      }}>
      <ReactFlow nodes={graphNodes} edges={graphEdges} nodeTypes={nodeTypes}
        onInit={instance => { flow.current = instance }}
        onNodesChange={applyNodeChanges} onConnect={connect} onConnectEnd={connectEnd} isValidConnection={canLink}
        onPaneClick={() => { setPicker(null); setContextNode(null); setContextEdge(null) }}
        onPaneContextMenu={event => { event.preventDefault(); openPicker(event) }}
        onNodeDoubleClick={(_event, node) => {
          if (node.data.draft) return
          if (isMedia(node.data.node)) setPreview(node.data.node)
          else openEditor({ base: node.data.node, edit: true })
        }}
        onNodeContextMenu={(event, node) => {
          event.preventDefault()
          setPicker(null)
          setContextEdge(null)
          setSelected([node.id])
          if (node.data.draft || node.data.node.deleted) {
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
        deleteKeyCode={null} edgesReconnectable={!mutationReason} minZoom={0.15} maxZoom={2} zoomOnDoubleClick={false}
        snapToGrid snapGrid={grid} multiSelectionKeyCode="Shift" selectionOnDrag={boxSelect} selectionMode={SelectionMode.Partial}
        panOnDrag={!boxSelect} onlyRenderVisibleElements={drafts.length === 0}>
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
        tasksOpen={tasksOpen} toggleTasks={() => setTasksOpen(value => !value)} activeTasks={tasks.filter(taskActive).length} />
      <CanvasCorners showMap={showMap} toggleMap={() => setShowMap(value => !value)} boxSelect={boxSelect}
        toggleBox={() => setBoxSelect(value => !value)} selected={selected}
        compact={selected.every(id => compact.includes(id))} toggleCompact={() => toggleCompact(selected)} />
      <div className="drama-v2-pager nodrag nopan nowheel">
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
          if (item.type !== 'video') return true
          if (isMedia(picker.seed)) return item.mode === 'r2v' ||
            (picker.seed.type === 'image' && item.mode === 'i2v') ||
            (picker.seed.type === 'video' && item.mode === 'v2v')
          return item.mode === 't2v' && ['script', 'shot', 'prompt', 'note'].includes(picker.seed.type)
        })}
        close={() => setPicker(null)} />}
      {contextNode && index.has(contextNode.id) && <Menu open portal compact
        anchor={<span className="drama-v2-picker-anchor" />} getAnchorRect={() => contextNode.rect} onClose={() => setContextNode(null)}
        items={[
          ...(mutationReason ? [{ id: 'activity', type: 'label', text: mutationReason }] : []),
          { id: 'edit', label: '编辑节点', disabled: Boolean(mutationReason) },
          { id: 'delete', label: '删除节点', disabled: Boolean(mutationReason), danger: true },
          { id: 'revise', label: '派生版本' }, { id: 'copy', label: '复制为新节点' },
          { id: 'compact', label: '折叠或展开' }, { id: 'next', label: '新增后继节点' },
        ]} onSelect={id => {
          const node = index.get(contextNode.id)
          if (id === 'compact') { toggleCompact([node.id]); setContextNode(null) }
          else if (id === 'next') openPicker(undefined, node, contextNode.rect)
          else if (id === 'delete') openRemoval({ kind: 'node', node })
          else openEditor({ base: node, edit: id === 'edit', duplicate: id === 'copy' })
        }} />}
      {contextEdge && <Menu open portal compact
        anchor={<span className="drama-v2-picker-anchor" />} getAnchorRect={() => contextEdge.rect}
        onClose={() => setContextEdge(null)}
        items={[
          { id: 'hint', type: 'label', text: mutationReason || (editingIds.has(contextEdge.edge.target)
            ? '先保存或取消目标节点的编辑' : '拖动连线起点可更换来源') },
          { id: 'delete', label: '删除连线', danger: true, disabled: !canChangeEdge(contextEdge.edge) },
        ]}
        onSelect={() => openRemoval({ kind: 'edge', edge: contextEdge.edge })} />}
      {tasksOpen && <TaskDrawer tasks={tasks} nodes={nodes} onLocate={id => { locate(id); setTasksOpen(false) }}
        changeTask={changeTask}
        onClose={() => setTasksOpen(false)} />}
    </div>
    {removal && <Modal open onClose={() => { if (!removing) setRemoval(null) }}
      title={removal.kind === 'node' ? '删除节点' : '删除连线'} closeLabel="关闭删除确认"
      footer={<>
        <Button size="sm" disabled={removing} onClick={() => setRemoval(null)}>取消</Button>
        <Button size="sm" variant="primary" disabled={removing || Boolean(mutationReason)}
          onClick={confirmRemoval}>{removing ? '正在删除' : '确认删除'}</Button>
      </>}>
      <div className="drama-v2-delete-content">
        {removal.kind === 'node' ? <>
          <strong>{nodeTitle(removal.node) || nodeLabels[removal.node.type]}</strong>
          <p>节点会从画布移除。若其他节点或生成任务引用了它，来源关系和任务记录会保留。</p>
        </> : <>
          <strong>{nodeTitle(index.get(removal.edge.source)) || '来源节点'} → {nodeTitle(index.get(removal.edge.target)) || '目标节点'}</strong>
          <p>删除此引用连线。生成节点的输入仍须满足当前生成方式的素材要求。</p>
        </>}
        {(mutationReason || removalError) && <p role="alert">{removalError || mutationReason}</p>}
      </div>
    </Modal>}
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
