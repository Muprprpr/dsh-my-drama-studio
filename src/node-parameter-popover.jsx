import React, { useEffect, useId, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import {
  Button, MenuSurface, focusWithoutRing, isBehindModal, observeComposition, useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'

const gap = 6
const margin = 12

export function NodeParameterPopover({ label, value, open, onToggle, onClose, disabled, children }) {
  const id = useId()
  const triggerRef = useRef(null)
  const popupRef = useRef(null)
  useDismissOnOutsidePointer(triggerRef, open, onClose, popupRef)

  useLayoutEffect(() => {
    if (!open) return
    const trigger = triggerRef.current
    const popup = popupRef.current
    const doc = trigger.ownerDocument
    const view = doc.defaultView
    let frame
    let previousX
    let previousY
    const track = () => {
      const { left, top, bottom } = trigger.getBoundingClientRect()
      const { offsetWidth: width, offsetHeight: height } = popup
      const maxLeft = Math.max(margin, view.innerWidth - width - margin)
      const maxTop = Math.max(margin, view.innerHeight - height - margin)
      const below = view.innerHeight - bottom - gap - margin
      const above = top - gap - margin
      const preferredTop = below < height && above > below ? top - gap - height : bottom + gap
      const x = Math.min(maxLeft, Math.max(margin, left))
      const y = Math.min(maxTop, Math.max(margin, preferredTop))
      if (x !== previousX) popup.style.left = x + 'px'
      if (y !== previousY) popup.style.top = y + 'px'
      previousX = x
      previousY = y
      frame = view.requestAnimationFrame(track)
    }
    track()
    const firstInput = popup.querySelector(
      '[data-param-autofocus], select:not(:disabled), input:not(:disabled), button:not(:disabled)',
    )
    focusWithoutRing(firstInput ?? popup, { preventScroll: true })
    return () => {
      view.cancelAnimationFrame(frame)
      if (popup.contains(doc.activeElement)) {
        view.requestAnimationFrame(() => {
          if (trigger.isConnected && !trigger.disabled && doc.activeElement === doc.body) {
            focusWithoutRing(trigger, { preventScroll: true })
          }
        })
      }
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const trigger = triggerRef.current
    const doc = trigger.ownerDocument
    const composition = observeComposition(doc)
    function dismiss(event) {
      if (composition.guards(event) || event.key !== 'Escape' || event.defaultPrevented ||
          event.ctrlKey || event.altKey || event.metaKey || isBehindModal(trigger)) return
      event.preventDefault()
      event.stopPropagation()
      if (event.repeat) return
      onClose()
      if (!trigger.disabled) focusWithoutRing(trigger, { preventScroll: true })
    }
    doc.addEventListener('keydown', dismiss, true)
    return () => {
      doc.removeEventListener('keydown', dismiss, true)
      composition.dispose()
    }
  }, [open, onClose])

  return <>
    <Button ref={triggerRef} size="sm" className="drama-focus-param-chip" aria-label={label}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      disabled={disabled} onClick={onToggle}>{value}</Button>
    {open && createPortal(
      <MenuSurface ref={popupRef} compact id={id} tabIndex={-1} role="dialog" aria-label={label}
        className="drama-focus-param-popover nodrag nopan nowheel" style={{ position: 'fixed' }}
        onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
        onWheel={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
        <strong>{label}</strong>
        {children}
      </MenuSurface>,
      document.body,
    )}
  </>
}
