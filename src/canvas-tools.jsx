import React, { useEffect, useRef, useState } from 'react'
import {
  Button, Checkbox, Input, Menu, MenuItemButton, MenuSurface, Tooltip,
  IconChecklistOutlineRegular, IconCloseOutlineRegular, IconCompactOutlineRegular,
  IconFullscreenOutlineRegular, IconPlusOutlineRegular, IconSearchOutlineRegular,
  IconSlidersTwoOutlineRegular, IconWorkspaceTreeOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { groupFields, nodeLabels } from './canvas-node.jsx'

const statuses = {
  queued: '排队中', processing: '处理中', completed: '已完成', failed: '失败', cancelled: '已取消',
}

export function IconButton({ icon: Icon, label, children, ...props }) {
  return <Tooltip label={label} portal>
    <Button type="button" size="sm" variant="ghost" aria-label={label} icon={<Icon size={16} />} {...props}>{children}</Button>
  </Tooltip>
}

export function CanvasToolbar({ filters, update, filterGroup, groups, collapsed, toggleGroup,
  fit, arrange, add, setAddAnchor, chooseAsset, tasksOpen, toggleTasks, activeTasks = 0,
}) {
  const [popover, setPopover] = useState('')
  const root = useRef(null)
  const open = name => setPopover(current => current === name ? '' : name)
  useEffect(() => {
    if (!popover) return
    function dismiss(event) {
      if (event.key === 'Escape' || event.type === 'pointerdown' && !root.current?.contains(event.target)
          && !event.target.closest?.('.drama-v2-choice-list')) setPopover('')
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', dismiss)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', dismiss)
    }
  }, [popover])

  return <div className="drama-v2-tools nodrag nopan nowheel" ref={root}>
    <div className="drama-v2-toolbar" role="toolbar" aria-label="画布工具">
      <Button ref={setAddAnchor} type="button" variant="primary" size="sm" aria-label="新增节点"
        title="新增节点 · Shift+A" icon={<IconPlusOutlineRegular size={16} />}
        onClick={() => { setPopover(''); add() }}><span className="drama-v2-tool-text">新增</span></Button>
      <IconButton label="项目资产" icon={IconWorkspaceTreeOutlineRegular}
        onClick={() => { setPopover(''); chooseAsset() }} />
      <IconButton label="搜索" icon={IconSearchOutlineRegular} onClick={() => open('search')} aria-expanded={popover === 'search'} />
      <IconButton label="筛选" icon={IconSlidersTwoOutlineRegular} onClick={() => open('filters')} aria-expanded={popover === 'filters'} />
      <div className="drama-v2-tool-divider" aria-hidden="true" />
      <IconButton label="适配视图" icon={IconFullscreenOutlineRegular} onClick={fit} />
      <IconButton label="整理节点" icon={IconWorkspaceTreeOutlineRegular} onClick={arrange} />
      {toggleTasks && <IconButton label="任务" icon={IconChecklistOutlineRegular} aria-expanded={tasksOpen}
        onClick={() => { setPopover(''); toggleTasks() }}>{activeTasks > 0 && <span className="drama-v2-task-count">{activeTasks}</span>}</IconButton>}
    </div>
    {popover === 'search' && <MenuSurface className="drama-v2-tool-popover">
      <Input autoFocus value={filters.q ?? ''} aria-label="搜索节点" placeholder="名称、镜头、ID、提示词"
        onChange={event => update('q', event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Escape' || event.key === 'Enter') setPopover('')
        }} />
      {filters.q && <IconButton label="清除搜索" icon={IconCloseOutlineRegular} onClick={() => update('q', '')} />}
    </MenuSurface>}
    {popover === 'filters' && <MenuSurface className="drama-v2-tool-popover drama-v2-filters">
      <div className="drama-v2-filters-title"><strong>筛选节点</strong>
        <Button type="button" size="sm" variant="ghost" onClick={() => filterGroup({})}>清除筛选</Button></div>
      <div className="drama-v2-filter-fields">
        {groupFields.map(([field, name]) => <label key={field}>{name}
          <Input aria-label={name} value={filters[field] ?? ''} onChange={event => update(field, event.target.value)} />
        </label>)}
      </div>
      <label>来源 Session<Input aria-label="来源 Session" value={filters.createdBySession ?? ''}
        onChange={event => update('createdBySession', event.target.value)} /></label>
      <Choice label="节点类型" options={nodeLabels} value={filters.type} change={value => update('type', value)} />
      <Choice label="任务状态" options={statuses} value={filters.taskStatus} change={value => update('taskStatus', value)} />
      {groups.length > 0 && <div className="drama-v2-group-list" aria-label="镜头组">
        {groups.map(group => <Checkbox key={group} checked={!collapsed.includes(group)}
          onChange={() => toggleGroup(group)} label={group} />)}
      </div>}
    </MenuSurface>}
  </div>
}

function Choice({ label, options, value, change }) {
  const [open, setOpen] = useState(false)
  return <Menu open={open} onClose={() => setOpen(false)} portal compact
    listClassName="drama-v2-choice-list" selectedId={value || 'all'}
    items={[{ id: 'all', label: '全部' }, ...Object.entries(options).map(([id, name]) => ({ id, label: name }))]}
    onSelect={id => { change(id === 'all' ? '' : id); setOpen(false) }}
    anchor={<Button type="button" variant="outline" size="sm" aria-label={label} aria-haspopup="menu" aria-expanded={open}
      onClick={() => setOpen(value => !value)}>{label} · {options[value] ?? '全部'}</Button>} />
}

export function CanvasCorners({ showMap, toggleMap, boxSelect, toggleBox, selected, toggleCompact, compact }) {
  return <div className="drama-v2-corners nodrag nopan nowheel">
    <IconButton label="框选" icon={IconFullscreenOutlineRegular} aria-pressed={boxSelect} onClick={toggleBox} />
    <IconButton label="缩略图" icon={IconWorkspaceTreeOutlineRegular} aria-pressed={showMap} onClick={toggleMap} />
    {selected.length > 0 && <IconButton label={compact ? '展开节点' : '折叠节点'} icon={IconCompactOutlineRegular} onClick={toggleCompact} />}
  </div>
}

export function CanvasPicker({ presets, picker, choose, close }) {
  const [query, setQuery] = useState('')
  const key = query.trim().toLowerCase()
  const choices = presets.filter(item => [item.type, item.mode, item.label, item.detail]
    .filter(Boolean).join(' ').toLowerCase().includes(key))
  const ref = useRef(null)
  useEffect(() => {
    const frame = requestAnimationFrame(() => ref.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [])
  return <Menu open portal compact getAnchorRect={() => picker.anchor?.getBoundingClientRect() ?? picker.rect}
    listClassName="drama-v2-picker-list" anchor={<span className="drama-v2-picker-anchor" />} onClose={close}>
    <div className="drama-v2-picker-search" role="group" aria-label="节点库"
      onKeyDown={event => {
        if (event.key === 'Enter' && choices.length) {
          event.preventDefault()
          event.stopPropagation()
          choose(choices[0])
        }
      }}>
      <Input ref={ref} aria-label="查找节点类型" placeholder="查找节点类型"
        value={query} onChange={event => setQuery(event.target.value)} />
    </div>
    {choices.map(item => <MenuItemButton key={item.mode ?? item.type} onSelect={() => choose(item)}>
      <span className="drama-v2-picker-label"><strong>{item.label}</strong><small>{item.detail}</small></span>
    </MenuItemButton>)}
    {!choices.length && <p className="drama-v2-picker-empty">没有匹配的节点类型</p>}
  </Menu>
}
