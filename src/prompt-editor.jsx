import React, {
  createContext, forwardRef, useContext, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState,
} from 'react'
import { createPortal } from 'react-dom'
import { Button, FileTypeIcon, IconPlayOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { Node } from '@tiptap/core'
import { Slice } from '@tiptap/pm/model'
import { PluginKey, TextSelection } from '@tiptap/pm/state'
import {
  EditorContent, NodeViewWrapper, ReactNodeViewRenderer, ReactRenderer, useEditor,
} from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Suggestion, { exitSuggestion } from '@tiptap/suggestion'
import promptEditorStyle from './prompt-editor.css'

export { promptEditorStyle }

const mediaLabels = { image: '图片', video: '视频', audio: '音频' }
const categories = { all: '全部', ...mediaLabels, character: '角色', scene: '场景' }
const mentionType = 'assetMention'
const mentionKey = new PluginKey('dramaAssetMention')
const assetIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.[a-zA-Z0-9]+)?$/u
const Assets = createContext(null)
const emptyAssets = []
const kit = StarterKit.configure({
  blockquote: false, bold: false, bulletList: false, code: false, codeBlock: false, dropcursor: false,
  gapcursor: false, heading: false, horizontalRule: false, italic: false, link: false, listItem: false,
  listItemKeymap: false, orderedList: false, strike: false, trailingNode: false, underline: false,
})

export function promptDocument(prompt = '') {
  return { type: 'doc', content: prompt.split(/\r\n|[\r\n]/u).map(line =>
    line ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph' }) }
}

export function promptDocumentText(doc, renderMention = asset => '@' + (asset.label || mediaLabels[asset.assetType])) {
  return (doc?.content ?? []).map(paragraph => (paragraph.content ?? []).map(part => {
    if (part.type === 'text') return part.text
    if (part.type === 'hardBreak') return '\n'
    if (part.type === mentionType && part.attrs) return renderMention(part.attrs)
    return ''
  }).join('')).join('\n')
}

export function promptDocumentMentions(doc) {
  return (doc?.content ?? []).flatMap(paragraph => (paragraph.content ?? [])
    .filter(part => part.type === mentionType && part.attrs).map(part => part.attrs))
}

function atomAttrs(item) {
  if (!item || !assetIdPattern.test(item.assetId) || !Object.hasOwn(mediaLabels, item.assetType)) return null
  const label = Array.from(String(item.label || mediaLabels[item.assetType]).replace(/[\r\n]+/gu, ' ')).slice(0, 160).join('')
  return { assetId: item.assetId, assetType: item.assetType, label }
}

function assetSummary(item, duration) {
  const seconds = item.duration ?? duration
  return [mediaLabels[item.assetType], item.sourceLabel,
    Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 10) / 10 + ' 秒' : '', item.status].filter(Boolean).join(' · ')
}

function Thumbnail({ item, className = '', video = false, onDuration }) {
  const [error, setError] = useState(false)
  const url = item.disabled ? null : item.thumbnailUrl
  const measure = onDuration && !item.duration
  const metadata = measure ? event => onDuration(event.currentTarget.duration) : undefined
  return <span className={'drama-prompt-thumbnail ' + className} aria-hidden="true">
    {url && !error ? <img draggable={false} src={url} alt="" onError={() => setError(true)} />
      : video && item.assetType === 'video' && item.mediaUrl && !item.disabled && !error
        ? <video src={item.mediaUrl} preload="metadata" muted playsInline tabIndex={-1}
          onLoadedMetadata={metadata} onError={() => setError(true)} />
        : item.assetType === 'audio' ? <IconPlayOutlineRegular size={15} />
          : <FileTypeIcon kind={item.assetType} size={15} />}
    {measure && item.assetType === 'audio' && item.mediaUrl && !item.disabled &&
      <audio hidden src={item.mediaUrl} preload="metadata" onLoadedMetadata={metadata} />}
  </span>
}

function AssetDetails({ anchor, item, close, onPreview, onLocate }) {
  const surface = useRef(null)
  const [duration, setDuration] = useState(null)
  useLayoutEffect(() => {
    const layer = surface.current
    const owner = layer.ownerDocument
    const view = owner.defaultView
    let frame
    function position() {
      if (!anchor.isConnected) return
      const rect = anchor.getBoundingClientRect()
      const width = layer.offsetWidth
      const height = layer.offsetHeight
      const margin = 8
      const x = Math.max(margin, Math.min(rect.left, view.innerWidth - width - margin))
      const below = rect.bottom + 5
      const y = below + height <= view.innerHeight - margin
        ? below
        : Math.max(margin, rect.top - height - 5)
      layer.style.left = x + 'px'
      layer.style.top = y + 'px'
      frame = view.requestAnimationFrame(position)
    }
    function outside(event) {
      if (!layer.contains(event.target) && !anchor.contains(event.target)) close()
    }
    function escape(event) {
      if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229) return
      event.preventDefault()
      event.stopPropagation()
      close()
      anchor.focus({ preventScroll: true })
    }
    position()
    const initial = layer.querySelector('button') ?? layer
    initial.focus({ preventScroll: true })
    owner.addEventListener('pointerdown', outside, true)
    owner.addEventListener('keydown', escape, true)
    return () => {
      view.cancelAnimationFrame(frame)
      owner.removeEventListener('pointerdown', outside, true)
      owner.removeEventListener('keydown', escape, true)
    }
  }, [anchor, close])

  return createPortal(<div ref={surface} className="drama-prompt-asset-details nodrag nopan nowheel"
    role="dialog" aria-label="引用素材详情" tabIndex={-1} onPointerDown={event => event.stopPropagation()}
    onKeyDown={event => event.stopPropagation()}>
    <Thumbnail key={item.thumbnailUrl || item.mediaUrl || item.assetId} item={item} video onDuration={setDuration} className="is-large" />
    <div className="drama-prompt-asset-info">
      <strong>{item.label}</strong>
      <span>{assetSummary(item, duration)}</span>
    </div>
    {(onPreview && !item.disabled || onLocate && item.nodeId) && <div className="drama-prompt-asset-actions">
      {onPreview && !item.disabled && <Button type="button" size="sm" onClick={() => { close(); onPreview(item) }}>
        预览素材
      </Button>}
      {onLocate && item.nodeId && <Button type="button" size="sm" onClick={() => { close(); onLocate(item.nodeId) }}>
        定位节点
      </Button>}
    </div>}
  </div>, anchor.ownerDocument.body)
}

function AssetMentionView({ node, selected }) {
  const { assets, showThumbnails, onPreview, onLocate } = useContext(Assets)
  const { assetId, assetType, label } = node.attrs
  const current = assets.get(assetId)
  const asset = current?.assetType === assetType ? current : null
  const item = { ...node.attrs, ...(asset ?? { disabled: true, status: '素材已失效' }),
    label: asset?.label || label || mediaLabels[assetType] }
  const [anchor, setAnchor] = useState(null)
  const close = React.useCallback(() => setAnchor(null), [])
  return <NodeViewWrapper as="span" data-asset-mention="" data-asset-id={assetId} data-asset-type={assetType}
    className={'drama-prompt-mention' + (selected ? ' is-selected' : '') + (item.disabled ? ' is-unavailable' : '')}>
    <button type="button" tabIndex={0} aria-haspopup="dialog" aria-expanded={Boolean(anchor)}
      title={item.label + ' · ' + assetSummary(item)} onMouseDown={event => event.preventDefault()}
      onClick={event => {
        event.stopPropagation()
        const button = event.currentTarget
        setAnchor(current => current ? null : button)
      }}>
      {showThumbnails && <Thumbnail item={item} video key={item.thumbnailUrl || item.mediaUrl || assetId} />}
      <span className="drama-prompt-token-label">@{item.label}</span>
      {item.disabled && <small>失效</small>}
    </button>
    {anchor && <AssetDetails anchor={anchor} item={item} close={close} onPreview={onPreview} onLocate={onLocate} />}
  </NodeViewWrapper>
}

function matchesCategory(item, category) {
  return category === 'all' || (category === 'character' || category === 'scene'
    ? item.category === category : item.assetType === category)
}

function SuggestionAsset({ item }) {
  const [duration, setDuration] = useState(null)
  return <>
    <Thumbnail item={item} video onDuration={setDuration} />
    <span className="drama-prompt-asset-info">
      <strong>{item.label}</strong>
      <small>{assetSummary(item, duration)}</small>
    </span>
  </>
}

const SuggestionList = forwardRef(function SuggestionList({ command, query, bridge }, ref) {
  const { assets, search } = useContext(Assets)
  const [category, setCategory] = useState('all')
  const [active, setActive] = useState(0)
  const [remote, setRemote] = useState(null)
  const id = useId()
  const list = useRef(null)
  const searchTerm = query.trim().toLocaleLowerCase()
  const matches = useMemo(() => {
    const current = remote?.query === query && remote?.category === category ? remote.items : []
    const combined = new Map()
    for (const item of assets.values()) {
      if (!searchTerm || item.label?.toLocaleLowerCase().includes(searchTerm)) combined.set(item.assetId, item)
    }
    for (const item of current ?? []) {
      if (!combined.has(item.assetId)) combined.set(item.assetId, assets.get(item.assetId) ?? item)
    }
    return [...combined.values()].filter(item => atomAttrs(item) && matchesCategory(item, category)).slice(0, 50)
  }, [remote, query, category, assets, searchTerm])
  const available = matches.filter(item => !item.disabled)
  const activeItem = available[active] ?? available[0]
  const optionId = activeItem && id + '-' + activeItem.assetId
  const loading = search && (!remote || remote.query !== query || remote.category !== category)
  const error = !loading && remote?.error

  useEffect(() => {
    if (!search) return
    const request = new AbortController()
    const timer = setTimeout(async () => {
      try {
        const items = await search(query, category, request.signal)
        if (!request.signal.aborted) setRemote({ query, category, items })
      } catch (failure) {
        if (!request.signal.aborted) setRemote({ query, category, items: [], error: failure.message })
      }
    }, 120)
    return () => { clearTimeout(timer); request.abort() }
  }, [category, query, search])

  useLayoutEffect(() => {
    const element = bridge.current.element
    if (!element) return
    element.setAttribute('aria-controls', id)
    if (optionId) element.setAttribute('aria-activedescendant', optionId)
    return () => {
      element.removeAttribute('aria-controls')
      element.removeAttribute('aria-activedescendant')
    }
  }, [bridge, id, optionId])

  useEffect(() => {
    const container = list.current
    const row = optionId && container?.ownerDocument.getElementById(optionId)
    if (row && container) {
      const bounds = container.getBoundingClientRect()
      const rect = row.getBoundingClientRect()
      if (rect.top < bounds.top) container.scrollTop -= bounds.top - rect.top
      else if (rect.bottom > bounds.bottom) container.scrollTop += rect.bottom - bounds.bottom
    }
  }, [optionId])

  useImperativeHandle(ref, () => ({
    onKeyDown(event) {
      if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        const options = Object.keys(categories)
        const offset = event.key === 'ArrowLeft' ? -1 : 1
        setCategory(options[(options.indexOf(category) + offset + options.length) % options.length])
        setActive(0)
        return true
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (available.length) {
          const step = event.key === 'ArrowDown' ? 1 : -1
          setActive((Math.max(0, available.indexOf(activeItem)) + step + available.length) % available.length)
        }
        return true
      }
      if (event.key === 'Enter' || event.key === 'Tab' && !event.shiftKey && activeItem) {
        if (activeItem) command(activeItem)
        return true
      }
      return false
    },
  }), [available, activeItem, category, command])

  return <section className="drama-prompt-suggestions nodrag nopan nowheel" aria-label="素材搜索"
    onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.preventDefault()}
    onClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
    <div className="drama-prompt-suggestion-filters" role="group" aria-label="素材类别">
      {Object.entries(categories).map(([key, label]) => <button type="button" key={key} tabIndex={-1}
        aria-pressed={category === key} onClick={() => { setCategory(key); setActive(0) }}>{label}</button>)}
    </div>
    <div className="drama-prompt-suggestion-list" ref={list} id={id} role="listbox" aria-label="引用资产">
      {matches.map(item => <button key={item.assetId} id={id + '-' + item.assetId} type="button" tabIndex={-1}
        role="option" aria-selected={item === activeItem} disabled={item.disabled}
        onMouseEnter={() => { if (!item.disabled) setActive(available.indexOf(item)) }}
        onClick={() => command(item)}>
        <SuggestionAsset key={item.thumbnailUrl || item.mediaUrl || item.assetId} item={item} />
      </button>)}
      {!matches.length && <p role="status">{loading ? '正在查找素材…' : error ? '无法读取项目素材。'
        : category === 'character' || category === 'scene' ? '当前项目没有匹配的' + categories[category] + '资产。'
          : '暂无匹配素材。'}</p>}
    </div>
  </section>
})

function insertAsset(editor, bridge, item, range) {
  const attrs = atomAttrs(item)
  if (!attrs || item.disabled || !editor.isEditable || bridge.current.composing) return false
  bridge.current.onAssetSelect?.(item)
  const target = range ?? { from: editor.state.selection.from, to: editor.state.selection.to }
  return editor.chain().focus().insertContentAt(target, { type: mentionType, attrs }).run()
}

function mentionExtension(bridge) {
  return Node.create({
    name: mentionType,
    group: 'inline',
    inline: true,
    atom: true,
    selectable: true,
    addAttributes() {
      return Object.fromEntries(['assetId', 'assetType', 'label'].map(key => [key, {
        default: '', rendered: false, parseHTML: () => null,
      }]))
    },
    parseHTML() {
      return [{ tag: 'span[data-asset-mention]', getAttrs: element => atomAttrs({
        assetId: element.getAttribute('data-asset-id'),
        assetType: element.getAttribute('data-asset-type'),
        label: element.getAttribute('data-asset-label'),
      }) ?? false }]
    },
    renderHTML({ node }) {
      const { assetId, assetType, label } = node.attrs
      return ['span', {
        'data-asset-mention': '', 'data-asset-id': assetId, 'data-asset-type': assetType, 'data-asset-label': label,
      }, '@' + (label || mediaLabels[assetType])]
    },
    renderText({ node }) {
      return '@' + (node.attrs.label || mediaLabels[node.attrs.assetType])
    },
    addNodeView() {
      return ReactNodeViewRenderer(AssetMentionView, { as: 'span', className: 'drama-prompt-mention-node' })
    },
    addProseMirrorPlugins() {
      return [Suggestion({
        editor: this.editor,
        pluginKey: mentionKey,
        allowedPrefixes: null,
        offset: { mainAxis: 6 },
        floatingUi: { strategy: 'fixed' },
        decorationClass: 'drama-prompt-query',
        allow: ({ editor }) => editor.isFocused && !bridge.current.composing,
        findSuggestionMatch({ $position }) {
          const before = $position.nodeBefore
          const text = before?.isText && before.text.match(/[@＠]([^\s@＠，。；：！？、,.!?;:]*)$/u)
          if (!text || /^(?:图片|视频|音频|image|video|audio)[0-9]+$/iu.test(text[1])) return null
          return { query: text[1], text: text[0], range: { from: $position.pos - text[0].length, to: $position.pos } }
        },
        command: ({ editor, range, props }) => insertAsset(editor, bridge, props, range),
        render: () => {
          let renderer
          let unmount
          return {
            onStart(props) {
              renderer = new ReactRenderer(SuggestionList, {
                editor: props.editor, props: { ...props, bridge }, className: 'drama-prompt-suggestion-layer',
              })
              bridge.current.suggesting = true
              unmount = props.mount(renderer.element, { autoUpdate: { animationFrame: true } })
            },
            onUpdate(props) {
              renderer?.updateProps(props)
            },
            onKeyDown({ event, view }) {
              if (event.isComposing || event.keyCode === 229 || view.composing || bridge.current.composing) return false
              if (event.key !== 'Escape' && !renderer?.ref?.onKeyDown(event)) return false
              event.preventDefault()
              event.stopPropagation()
              return true
            },
            onExit() {
              bridge.current.suggesting = false
              unmount?.()
              renderer?.destroy()
              renderer = null
              unmount = null
            },
          }
        },
      })]
    },
  })
}

export const PromptEditor = forwardRef(function PromptEditor({
  value, prompt = '', onChange, assets = emptyAssets, search, onPreview, onLocate, onAssetSelect,
  onCompositionChange, disabled = false, ariaLabel = '提示词', placeholder = '', autoFocus = false,
  showThumbnails = true, className = '', name = 'prompt',
}, ref) {
  const bridge = useRef({ composing: false, compositionClosedAt: 0, lastDoc: null })
  bridge.current.onAssetSelect = onAssetSelect
  bridge.current.onChange = onChange
  bridge.current.onCompositionChange = onCompositionChange
  const extensions = useMemo(() => [kit, mentionExtension(bridge)], [])
  const doc = useMemo(() => value ?? promptDocument(prompt), [value, prompt])
  const editor = useEditor({
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    content: doc,
    extensions,
    editable: !disabled,
    coreExtensionOptions: { clipboardTextSerializer: { blockSeparator: '\n' } },
    editorProps: {
      handleDOMEvents: {
        keydown(view, event) {
          const state = bridge.current
          const lateComposition = state.compositionClosedAt && Date.now() - state.compositionClosedAt < 120
          state.compositionClosedAt = 0
          if (lateComposition && !view.composing && !event.isComposing && event.keyCode !== 229 &&
              (event.key === 'Escape' || event.key === 'Enter')) {
            event.preventDefault()
            event.stopPropagation()
            return true
          }
          // ProseMirror otherwise consumes Escape even when the editor has no popup.
          return event.key === 'Escape' && !mentionKey.getState(view.state)?.active
        },
      },
      clipboardTextParser(text, context) {
        return Slice.maxOpen(context.doc.type.schema.nodeFromJSON(promptDocument(text)).content)
      },
      attributes: {
        class: 'drama-prompt-input nodrag nopan nowheel', role: 'textbox', 'aria-label': ariaLabel,
        'aria-multiline': 'true', 'aria-autocomplete': 'list', 'data-placeholder': placeholder, tabindex: '0',
        name, ...(autoFocus ? { 'data-modal-autofocus': 'true' } : {}),
      },
    },
    onUpdate({ editor: current }) {
      if (bridge.current.composing || current.view.composing) return
      const next = current.getJSON()
      bridge.current.lastDoc = next
      bridge.current.onChange?.(next)
    },
  })
  useLayoutEffect(() => {
    if (!editor || editor.isDestroyed) return
    bridge.current.element = editor.view.dom
    return () => { bridge.current.element = null }
  }, [editor])

  useLayoutEffect(() => {
    if (!editor || editor.isDestroyed || editor.isEditable === !disabled) return
    editor.setEditable(!disabled, false)
    if (disabled) exitSuggestion(editor.view, mentionKey)
  }, [disabled, editor])

  useLayoutEffect(() => {
    if (!editor || editor.isDestroyed || bridge.current.composing || editor.view.composing || doc === bridge.current.lastDoc) return
    const next = editor.schema.nodeFromJSON(doc)
    if (editor.state.doc.eq(next)) return
    const { from, to } = editor.state.selection
    const tr = editor.state.tr.replaceWith(0, editor.state.doc.content.size, next.content)
    const limit = tr.doc.content.size - 1
    tr.setSelection(TextSelection.between(tr.doc.resolve(Math.min(from, limit)), tr.doc.resolve(Math.min(to, limit))))
      .setMeta('addToHistory', false).setMeta('preventUpdate', true)
    editor.view.dispatch(tr)
  }, [doc, editor])

  useImperativeHandle(ref, () => ({
    get element() { return bridge.current.element },
    removeMentions(assetIds, assetType) {
      if (!editor || !editor.isEditable || bridge.current.composing || editor.view.composing) return
      const ranges = []
      editor.state.doc.descendants((node, position) => {
        if (node.type.name === mentionType && node.attrs.assetType === assetType && assetIds.includes(node.attrs.assetId)) {
          ranges.push([position, position + node.nodeSize])
        }
      })
      if (!ranges.length) return
      editor.commands.command(({ tr }) => {
        for (const [from, to] of ranges.reverse()) tr.delete(from, to)
        return true
      })
    },
  }), [editor])

  useEffect(() => {
    if (autoFocus && editor?.isEditable) editor.commands.focus('end', { scrollIntoView: false })
  }, [autoFocus, editor])

  function endComposition() {
    const state = bridge.current
    state.compositionClosedAt = Date.now()
    queueMicrotask(() => {
      if (!state.composing || !editor || editor.isDestroyed) return
      state.composing = false
      state.onCompositionChange?.(false)
      const next = editor.getJSON()
      if (JSON.stringify(next) !== JSON.stringify(state.lastDoc ?? doc)) {
        state.lastDoc = next
        state.onChange?.(next)
      }
      editor.view.dispatch(editor.state.tr.setMeta('addToHistory', false))
    })
  }

  const assetContext = useMemo(() => ({
    assets: new Map(assets.map(item => [item.assetId, item])), search, onPreview, onLocate, showThumbnails,
  }), [assets, search, onPreview, onLocate, showThumbnails])
  return <Assets.Provider value={assetContext}>
    <div className={'drama-prompt-editor nodrag nopan nowheel ' + className}
      onKeyDown={event => {
        if (event.key === 'Tab' || event.key === 'Escape' && !event.defaultPrevented &&
            !bridge.current.composing && !bridge.current.suggesting && !event.nativeEvent.isComposing && event.keyCode !== 229) return
        event.stopPropagation()
      }}
      onKeyUp={() => { bridge.current.compositionClosedAt = 0 }}
      onCompositionStart={() => {
        bridge.current.compositionClosedAt = 0
        bridge.current.composing = true
        bridge.current.onCompositionChange?.(true)
      }}
      onCompositionEnd={endComposition}
      onBlur={event => {
        if (event.currentTarget.contains(event.relatedTarget)) return
        bridge.current.compositionClosedAt = 0
        if (editor && bridge.current.suggesting) exitSuggestion(editor.view, mentionKey)
      }}
      onPaste={event => event.stopPropagation()} onDrop={event => event.stopPropagation()}>
      <EditorContent editor={editor} />
    </div>
  </Assets.Provider>
})
