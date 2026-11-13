import { useLayoutEffect, useRef } from 'react'
import { useStoreApi } from '@xyflow/react'

const gap = 7
const margin = 8

export function useNodeEditorPlacement(nodeId, enabled, focused = false) {
  const panelRef = useRef(null)
  const flow = useStoreApi()

  useLayoutEffect(() => {
    const panel = panelRef.current
    const card = panel?.parentElement
    const canvas = card?.closest('.drama-flow')
    if (!enabled || !canvas) return

    let frame = 0
    const state = flow.getState()
    let position = state.nodeLookup.get(nodeId)?.internals.positionAbsolute
    function place() {
      frame = 0
      const bounds = canvas.getBoundingClientRect()
      const anchor = card.getBoundingClientRect()
      if (!bounds.width || !bounds.height) return

      const zoom = flow.getState().transform[2]
      const maxWidth = Math.max(1, (bounds.width - 2 * margin) / zoom)
      panel.style.setProperty('--drama-editor-max-width', `${maxWidth}px`)
      const editor = panel.getBoundingClientRect()
      const above = anchor.top - bounds.top - margin
      const below = bounds.bottom - anchor.bottom - margin
      const height = editor.height + gap * zoom
      panel.dataset.placement = !focused && below < height && above > below ? 'above' : 'below'

      const left = bounds.left + margin
      const right = bounds.right - margin - editor.width
      const anchorVisible = anchor.right > bounds.left && anchor.left < bounds.right
      const centered = anchor.left + (anchor.width - editor.width) / 2
      const target = anchorVisible ? Math.max(left, Math.min(right, centered)) : centered
      panel.style.setProperty('--drama-editor-shift', `${(target - centered) / zoom}px`)
    }
    function schedule() {
      if (!frame) frame = requestAnimationFrame(place)
    }

    place()
    const resize = new ResizeObserver(schedule)
    resize.observe(canvas)
    resize.observe(card)
    resize.observe(panel)
    const unsubscribe = flow.subscribe((current, previous) => {
      const next = current.nodeLookup.get(nodeId)?.internals.positionAbsolute
      if (current.transform !== previous.transform || position?.x !== next?.x || position?.y !== next?.y) schedule()
      position = next
    })
    return () => {
      cancelAnimationFrame(frame)
      resize.disconnect()
      unsubscribe()
      delete panel.dataset.placement
      panel.style.removeProperty('--drama-editor-shift')
      panel.style.removeProperty('--drama-editor-max-width')
    }
  }, [flow, nodeId, enabled, focused])

  return panelRef
}
