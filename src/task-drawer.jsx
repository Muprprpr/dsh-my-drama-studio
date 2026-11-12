import React, { useState } from 'react'
import { Button, IconCloseOutlineRegular, Pill, StateDot, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'

const states = {
  queued: ['排队', 'idle'], processing: ['生成中', 'ongoing'], completed: ['完成', 'done'],
  failed: ['失败', 'error'], cancelled: ['已取消', 'idle'],
}
const phases = {
  submitting: ['提交中', 'ongoing'], polling: ['生成中', 'ongoing'],
  paused: ['查询暂停', 'warning'], submission_unknown: ['提交状态未知', 'warning'],
}
const dateLabel = new Intl.DateTimeFormat('zh-CN', {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
})

export function taskActive(task) {
  return task.status === 'queued' || task.status === 'processing' && task.phase !== 'paused'
}

export function TaskStatus({ status, phase, taskId }) {
  const [label, state] = phases[phase] ?? states[status] ?? [status, 'idle']
  return <span className="drama-task-status" data-task-status={status} data-task-phase={phase} title={taskId}>
    <StateDot state={state} size={8} />{label}
  </span>
}

export function TaskDrawer({ tasks, nodes, onLocate, onClose, changeTask }) {
  const [activeOnly, setActiveOnly] = useState(false)
  const [pending, setPending] = useState('')
  const [error, setError] = useState('')
  const visibleTasks = activeOnly ? tasks.filter(taskActive) : tasks
  const nodeById = new Map(nodes.map(node => [node.id, node]))

  async function update(action, taskId) {
    setPending(taskId)
    setError('')
    try {
      await changeTask(action, taskId)
    } catch (failure) {
      setError(failure.message)
    } finally {
      setPending('')
    }
  }

  return <aside className="drama-task-drawer nodrag nopan nowheel" aria-label="生成任务" role="region"
    onKeyDown={event => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }}>
    <header className="drama-task-header">
      <strong>生成任务</strong>
      <Tooltip portal side="left" label="收起任务">
        <Button size="sm" aria-label="收起任务" onClick={onClose}><IconCloseOutlineRegular size={14} /></Button>
      </Tooltip>
    </header>
    {error && <p role="alert" className="drama-node-form-error">{error}</p>}
    {tasks.length > 0 && <div className="drama-task-filters">
      <Pill active={!activeOnly} aria-pressed={!activeOnly} onClick={() => setActiveOnly(false)}>全部</Pill>
      <Pill active={activeOnly} aria-pressed={activeOnly} onClick={() => setActiveOnly(true)}>进行中</Pill>
    </div>}
    {visibleTasks.length === 0 ? <p className="drama-task-empty">{activeOnly ? '暂无进行中的任务' : '暂无生成任务'}</p>
      : <ul>{visibleTasks.map(task => {
        const node = nodeById.get(task.nodeId)
        const title = node?.content?.title || node?.shotId || task.nodeId
        const created = Date.parse(task.createdAt)
        const kind = task.mode?.toUpperCase() || (task.type === 'image' ? '图片' : '视频')
        return <li key={task.id}>
          <div className="drama-task-row">
            <span className="drama-task-node-title" title={title}>{title}</span>
            <TaskStatus status={task.status} phase={task.phase} taskId={task.id} />
          </div>
          <p className="drama-task-meta">{kind}{task.model ? ' · ' + task.model : ''}{Number.isFinite(created) ? ' · ' + dateLabel.format(created) : ''}</p>
          <div className="drama-task-actions">
            <Button size="sm" onClick={() => onLocate(task.nodeId)}>定位节点</Button>
            {task.resultNodeId && <Button size="sm" onClick={() => onLocate(task.resultNodeId)}>查看结果</Button>}
            {changeTask && task.status === 'queued' &&
              <Button size="sm" disabled={Boolean(pending)} onClick={() => void update('cancel_task', task.id)}>取消排队</Button>}
            {changeTask && task.phase === 'paused' && task.providerTaskId &&
              <Button size="sm" disabled={Boolean(pending)} onClick={() => void update('resume_task', task.id)}>继续查询</Button>}
          </div>
          <details>
            <summary>{task.error ? '错误与任务信息' : '任务信息'}</summary>
            <p>任务 ID {task.id}</p>
            <p>发起会话 {task.createdBySession}</p>
            {task.providerTaskId && <p>供应商任务 ID {task.providerTaskId}</p>}
            {task.outputPath && <p>本地结果 {task.outputPath}</p>}
            {task.completedAt && <p>完成于 {dateLabel.format(Date.parse(task.completedAt))}</p>}
            {task.error && <p role="status">{task.error}</p>}
          </details>
        </li>
      })}</ul>}
  </aside>
}
