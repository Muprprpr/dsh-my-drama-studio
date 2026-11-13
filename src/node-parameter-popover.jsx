import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Button, Input, focusWithoutRing, isBehindModal, observeComposition, useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'

const gap = 6
const margin = 12

export function NodeParameterPopover({ label, value, open, onToggle, onClose, disabled, children }) {
  const id = useId()
  const titleId = id + '-title'
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
      <div ref={popupRef} id={id} tabIndex={-1} role="dialog" aria-labelledby={titleId}
        className="drama-focus-param-popover nodrag nopan nowheel" style={{ position: 'fixed' }}
        onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
        onWheel={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
        <strong id={titleId}>{label}</strong>
        {children}
      </div>,
      document.body,
    )}
  </>
}

export function DurationControl({ param, update }) {
  const [draft, setDraft] = useState(null)
  const [error, setError] = useState('')
  const errorId = useId()
  const stops = param.durationStops
  const sliderMin = stops.length ? 0 : Math.max(1, param.min)
  const sliderMax = stops.length ? stops.length - 1 : param.max
  const current = Number(param.selected || param.inherited)
  const index = stops.indexOf(current)
  const sliderValue = stops.length ? Math.max(0, index) :
    Number.isInteger(current) ? Math.min(sliderMax, Math.max(sliderMin, current)) : sliderMin
  const canSlide = param.hasDurationStops ? stops.length > 1 : sliderMax > sliderMin
  const bounds = stops.length
    ? (stops.length <= 8 ? stops.join('、') : stops[0] + '–' + stops.at(-1) + ' 的指定档位') + ' 秒'
    : sliderMin + '–' + sliderMax + ' 秒'
  const numberText = draft ?? param.selected

  function apply(value) {
    setDraft(null)
    setError('')
    if (value !== param.selected) update(value)
  }

  function commit() {
    if (draft === null) return
    if (draft === '') { apply(''); return }
    const seconds = Number(draft)
    if (!Number.isInteger(seconds) || !param.acceptDuration(seconds)) {
      setError('可选时长：' + bounds + (param.acceptDuration(-1) ? '，-1 为自动时长' : ''))
      return
    }
    apply(String(seconds))
  }

  return <div className="drama-param-duration">
    <div className="drama-param-duration-entry">
      <Input type="number" inputMode="numeric" step="1" value={numberText} aria-label={param.label}
        aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined}
        data-param-autofocus placeholder={param.inherited == null ? '默认' : String(param.inherited)}
        onChange={event => {
          if (event.target.validity.badInput) return
          setDraft(event.target.value)
          setError('')
        }} onBlur={commit} onKeyDown={event => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) return
          event.preventDefault()
          commit()
        }} />
      <Button size="sm" disabled={!param.selected && draft === null} onClick={() => apply('')}>恢复默认</Button>
    </div>
    {canSlide && <div className="drama-param-slider">
      <input type="range" min={sliderMin} max={sliderMax} step="1" value={sliderValue}
        aria-label="滑动调整时长"
        aria-valuetext={(stops.length ? stops[sliderValue] : sliderValue) + ' 秒'}
        onChange={event => {
          const position = Number(event.target.value)
          apply(String(stops.length ? stops[position] : position))
        }} />
      <div className="drama-param-slider-bounds" aria-hidden="true">
        <span>{stops[0] ?? sliderMin} 秒</span><span>{stops.at(-1) ?? sliderMax} 秒</span>
      </div>
    </div>}
    {error && <small id={errorId} className="drama-param-error" role="alert">{error}</small>}
  </div>
}
