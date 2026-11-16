import React, { useEffect, useId, useState } from 'react'
import { Button, Input, Modal, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { skillRequest } from './studio-api.js'
import style from './skill-settings.css'

const sources = {
  'built-in': 'Built-in',
  'user-imported': 'User Imported',
  'user-managed': 'User Managed',
  external: 'External',
}
const sourceOrder = Object.keys(sources)
const statuses = {
  ready: '可用',
  'user-modified': '用户已修改',
  'update-available': '有可用更新',
  'user-owned': '用户维护',
  custom: '自定义',
  missing: '缺失',
  invalid: '无效',
  blocked: '不可用',
  conflict: '冲突',
}

function useSkillSettings(query) {
  const [data, setData] = useState(null)
  const [revision, setRevision] = useState(0)
  const [readRevision, setReadRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    const action = query === 'list' && revision ? 'refresh' : query
    skillRequest(action, {}, controller.signal).then(result => {
      if (!controller.signal.aborted) {
        setData(result)
        setReadRevision(revision)
      }
    }).catch(failure => {
      if (!controller.signal.aborted) setError(failure.message)
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => controller.abort()
  }, [query, revision])

  function refresh() {
    setError('')
    setRevision(value => value + 1)
  }

  async function run(work) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await work()
    } catch (failure) {
      setError(failure.message)
    } finally {
      setBusy(false)
    }
  }

  return { data, setData, readRevision, refresh, run, loading, busy, error, notice, setNotice }
}

function Feedback({ error, notice, loading }) {
  return <>
    {error && <p className="drama-skill-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {loading && <p role="status">正在读取全局 Skill…</p>}
  </>
}

function Status({ skill }) {
  return <span className="drama-skill-tags">
    <Tag tone={skill.source === 'built-in' ? 'info' : 'neutral'}>{sources[skill.source] ?? skill.source}</Tag>
    <Tag tone={skill.bindable ? 'success' : 'warning'}>{skill.bindable ? '可绑定' : '不可绑定'}</Tag>
    {skill.status && !['ready', 'custom'].includes(skill.status) && <Tag>{statuses[skill.status] ?? skill.status}</Tag>}
    {skill.userModified && skill.status !== 'user-modified' && <Tag tone="warning">用户已修改</Tag>}
  </span>
}

function Usage({ skill }) {
  const usage = skill.usedBy ?? []
  return <small className="drama-skill-usage">
    {usage.length ? usage.map(item => (item.profileName ?? item.profileId) + ' / ' + (item.stageName ?? item.stageId)).join(' · ') : '暂无阶段绑定'}
  </small>
}

function Hash({ value }) {
  return value ? <code className="drama-skill-hash" title={value}>{value.slice(0, 12)}</code> : null
}

function matchesSkill(skill, filter) {
  return !filter || [skill.id, skill.description].some(value => value?.toLocaleLowerCase().includes(filter))
}

function SkillDetail({ row, revision, refresh, refreshing, refreshError, onClose, onImported }) {
  const [detail, setDetail] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [pending, setPending] = useState(false)
  const [name, setName] = useState('')
  const [cloning, setCloning] = useState(false)
  const cloneId = useId()
  const skill = detail ?? row

  useEffect(() => {
    const controller = new AbortController()
    skillRequest('detail', { skillId: row.id }, controller.signal).then(result => {
      if (!controller.signal.aborted) setDetail(result.skill)
    }).catch(failure => {
      if (!controller.signal.aborted) setError(failure.message)
    })
    return () => controller.abort()
  }, [row.id, revision])

  async function run(work) {
    setPending(true)
    setError('')
    setNotice('')
    try {
      await work()
    } catch (failure) {
      setError(failure.message)
    } finally {
      setPending(false)
    }
  }

  function open(action) {
    return run(async () => {
      await skillRequest(action, { skillId: row.id })
      setNotice(action === 'open_file' ? '已打开 SKILL.md' : '已打开 Skill 文件夹')
    })
  }

  return <Modal open title={row.id} closeLabel="关闭 Skill 详情" onClose={onClose}
    className="drama-skill-dialog" contentClassName="drama-skill-dialog-scroll">
    <div className="drama-skill-settings" data-testid="drama-skill-detail">
      <Status skill={skill} />
      {skill.description && <p>{skill.description}</p>}
      <code className="drama-skill-path">{skill.path}</code>
      <Usage skill={skill} />
      <div className="drama-skill-actions">
        {skill.canOpen && <Button size="sm" disabled={pending} onClick={() => void open('open_directory')}>打开文件夹</Button>}
        {skill.canOpen && <Button size="sm" disabled={pending} onClick={() => void open('open_file')}>打开 SKILL.md</Button>}
        <Button size="sm" disabled={!skill.path || pending} onClick={() => void run(async () => {
          await navigator.clipboard.writeText(skill.path)
          setNotice('路径已复制')
        })}>复制路径</Button>
        <Button size="sm" disabled={pending || refreshing} onClick={() => { setError(''); refresh() }}>刷新 Skill</Button>
        {skill.builtIn && skill.bindable && <Button size="sm" disabled={pending}
          onClick={() => setCloning(value => !value)} aria-expanded={cloning}>复制为自定义 Skill</Button>}
      </div>
      {cloning && <form className="drama-skill-form" onSubmit={event => {
        event.preventDefault()
        void run(async () => {
          const result = await skillRequest('clone', { skillId: row.id, name: name.trim() })
          onImported(result)
        })
      }}>
        <label htmlFor={cloneId}>新的 Skill 名称</label>
        <div className="drama-skill-actions">
          <Input id={cloneId} value={name} onChange={event => setName(event.target.value)}
            placeholder="my-storyboard" disabled={pending} required />
          <Button type="submit" size="sm" variant="primary" disabled={pending || !name.trim()}>复制 Skill</Button>
        </div>
      </form>}
      <Feedback error={error || refreshError || skill.error} notice={notice} loading={refreshing || (!detail && !error)} />
      {detail && <>
        <h3>SKILL.md <Hash value={skill.hash} /></h3>
        {typeof skill.content === 'string' && <pre className="drama-skill-source">{skill.content}</pre>}
        <h3>附属资源</h3>
        <small>Session 快照固定 Skill 指令及 Harness。附属资源状态反映实际路径下的当前文件。</small>
        {skill.resources?.length ? <ul className="drama-skill-resources">
          {skill.resources.map(resource => <li key={resource.path}>
            <code title={resource.path}>{resource.relativePath ?? resource.path}</code>
            <span>{statuses[resource.status] ?? resource.status} <Hash value={resource.hash} /></span>
            {resource.error && <span className="drama-skill-error">{resource.error}</span>}
          </li>)}
        </ul> : <p>暂无附属资源。</p>}
      </>}
    </div>
  </Modal>
}

export function SkillsLibrary({ pickDirectory }) {
  const state = useSkillSettings('list')
  const { data, refresh, run, busy, loading, setNotice } = state
  const [search, setSearch] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [path, setPath] = useState('')
  const [selected, setSelected] = useState(null)
  const searchId = useId()
  const pathId = useId()
  const filter = search.trim().toLocaleLowerCase()
  const skills = data?.skills ?? []
  const row = skills.find(skill => skill.id === selected?.id) ?? selected
  const visible = skills.filter(skill => matchesSkill(skill, filter)).sort((left, right) =>
    sourceOrder.indexOf(left.source) - sourceOrder.indexOf(right.source))
  const disabled = busy || loading

  function imported(result) {
    const exists = result.status === 'already-exists'
    setNotice(exists ? '相同的 Skill 已存在' : 'Skill 已导入')
    setSearch('')
    setSelected(exists ? null : result.skill)
    setImportOpen(false)
    setPath('')
    refresh()
  }

  return <section className="drama-skill-settings" aria-label="Skills Library" data-testid="drama-skill-library">
    <style>{style}</style>
    <div className="drama-skill-toolbar">
      <label className="drama-skill-search" htmlFor={searchId}>
        <span>搜索 Skill</span>
        <Input id={searchId} type="search" placeholder="名称或描述" value={search}
          onChange={event => setSearch(event.target.value)} />
      </label>
      <div className="drama-skill-actions">
        <Button size="sm" variant="primary" aria-expanded={importOpen}
          disabled={busy} onClick={() => setImportOpen(value => !value)}>导入 Skill</Button>
        <Button size="sm" disabled={disabled} onClick={refresh}>刷新列表</Button>
      </div>
    </div>
    {data?.directory && <div className="drama-skill-location">
      <code className="drama-skill-path" aria-label="全局 Skills 目录">{data.directory}</code>
      <div className="drama-skill-actions">
        {data.canOpen && <Button size="sm" disabled={disabled} onClick={() => void run(async () => {
          await skillRequest('open_directory')
          setNotice('已打开全局 Skills 目录')
        })}>打开全局目录</Button>}
        <Button size="sm" disabled={disabled} onClick={() => void run(async () => {
          await navigator.clipboard.writeText(data.directory)
          setNotice('路径已复制')
        })}>复制路径</Button>
      </div>
    </div>}
    {importOpen && <form className="drama-skill-form" onSubmit={event => {
      event.preventDefault()
      void run(async () => imported(await skillRequest('import', { path: path.trim() })))
    }}>
      <label htmlFor={pathId}>包含 SKILL.md 的文件夹路径</label>
      <div className="drama-skill-actions">
        <Input id={pathId} value={path} onChange={event => setPath(event.target.value)}
          placeholder="C:\Skills\my-storyboard" disabled={busy} required />
        {pickDirectory && <Button type="button" size="sm" disabled={busy} onClick={() => void run(async () => {
          const chosen = await pickDirectory()
          if (chosen) setPath(chosen)
        })}>选择文件夹</Button>}
        <Button type="submit" size="sm" variant="primary" disabled={busy || !path.trim()}>导入文件夹</Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy}
          onClick={() => setImportOpen(false)}>取消</Button>
      </div>
    </form>}
    <Feedback {...state} />
    {data && (visible.length ? <ul className="drama-skill-list" aria-label="已安装的 Skills">
      {visible.map(skill => <li key={skill.id} data-testid="drama-skill-row">
        <div className="drama-skill-row">
          <strong>{skill.id}</strong>
          <Status skill={skill} />
          <Button size="sm" onClick={() => setSelected(skill)} aria-label={'查看 ' + skill.id}>查看详情</Button>
        </div>
        {skill.description && <p>{skill.description}</p>}
        {skill.path && <code className="drama-skill-path">{skill.path}</code>}
        <Usage skill={skill} />
        {skill.error && <p className="drama-skill-error">{skill.error}</p>}
      </li>)}
    </ul> : <p>{filter ? '没有匹配的 Skill。' : '当前没有可显示的 Skill。'}</p>)}
    {row && <SkillDetail key={row.id} row={row} revision={state.readRevision} refresh={refresh}
      refreshing={loading} refreshError={state.error} onClose={() => setSelected(null)} onImported={imported} />}
  </section>
}

function BindingPicker({ stage, skills, busy, onSave, onClose }) {
  const [skillId, setSkillId] = useState('')
  const [search, setSearch] = useState('')
  const id = useId()
  const filter = search.trim().toLocaleLowerCase()
  const visible = skills.filter(skill => skill.bindable && matchesSkill(skill, filter))
  const valid = visible.some(skill => skill.id === skillId)
  return <form className="drama-skill-form" onSubmit={event => {
    event.preventDefault()
    if (valid) onSave(skillId)
  }}>
    <label htmlFor={id + '-search'}>搜索可绑定 Skill</label>
    <Input id={id + '-search'} type="search" value={search} onChange={event => setSearch(event.target.value)}
      placeholder="名称或描述" disabled={busy} />
    <label htmlFor={id + '-skill'}>{stage.name}的 Skill</label>
    <div className="drama-skill-actions">
      <select className="drama-skill-select" id={id + '-skill'} value={valid ? skillId : ''}
        onChange={event => setSkillId(event.target.value)} disabled={busy} required>
        <option value="" disabled>{visible.length ? '选择 Skill' : '没有匹配的可绑定 Skill'}</option>
        {visible.map(skill => <option key={skill.id} value={skill.id}>{skill.id} · {sources[skill.source] ?? skill.source}</option>)}
      </select>
      <Button type="submit" size="sm" variant="primary" disabled={busy || !valid}>保存绑定</Button>
      <Button type="button" size="sm" disabled={busy} onClick={onClose}>取消</Button>
    </div>
  </form>
}

export function WorkflowSkillBindings() {
  const state = useSkillSettings('bindings')
  const { data, refresh, run, busy, loading, setData, setNotice } = state
  const [profileId, setProfileId] = useState('short-drama')
  const [editing, setEditing] = useState('')
  const id = useId()
  const profiles = data?.profiles ?? []
  const profile = profiles.find(item => item.id === profileId) ?? profiles[0]
  const ready = profile && !data.failure && profile.stages.every(stage => !stage.issues?.length)

  function save(stageId, skillId) {
    void run(async () => {
      const result = await skillRequest('bind', { profileId: profile.id, stageId, skillId })
      setData(result)
      setEditing('')
      setNotice(skillId ? '绑定已保存，下次激活时生效。' : '已恢复官方默认，下次激活时生效。')
    })
  }

  return <section className="drama-skill-settings" aria-label="Workflow Skill Bindings" data-testid="drama-skill-bindings">
    <style>{style}</style>
    <h2>Workflow Skill Bindings</h2>
    <div className="drama-skill-toolbar">
      <div className="drama-skill-search">
        <label htmlFor={id}>生产模式</label>
        <select className="drama-skill-select" id={id} disabled={!profile || busy || loading} value={profile?.id ?? ''}
          onChange={event => { setProfileId(event.target.value); setEditing(''); setNotice('') }}>
          {profiles.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </div>
      <div className="drama-skill-actions">
        {profile && <Tag tone={ready ? 'success' : 'warning'}>{ready ? '配置完整' : '配置需要修复'}</Tag>}
        <Button size="sm" disabled={busy || loading} onClick={refresh}>重新检查配置</Button>
      </div>
    </div>
    <Feedback {...state} />
    {data?.failure && <p role="alert" className="drama-skill-error">
      {data.failure.error} {data.failure.path && <code>{data.failure.path}</code>}
    </p>}
    {profile && <>
      <small>{profile.stages.length} 个固定阶段 · 定义版本 {profile.version}</small>
      <ol className="drama-skill-list" aria-label={profile.name + '的阶段绑定'}>
        {profile.stages.map(stage => <li key={stage.id} data-testid="drama-binding-row" data-stage-id={stage.id}>
          <div className="drama-skill-row">
            <strong>{stage.name}</strong>
            <Tag tone={stage.overridden ? 'info' : 'neutral'}>{stage.overridden ? '自定义覆盖' : '官方默认'}</Tag>
            <div className="drama-skill-actions">
              <Button size="sm" disabled={busy || loading || Boolean(data.failure)}
                aria-expanded={editing === stage.id}
                onClick={() => setEditing(value => value === stage.id ? '' : stage.id)}>更换 Skill</Button>
              {stage.overridden && <Button size="sm" disabled={busy || loading || Boolean(data.failure)}
                onClick={() => save(stage.id, null)}>恢复官方默认</Button>}
            </div>
          </div>
          <div className="drama-skill-stage-meta">
            <code>{stage.skillId}</code>
            {stage.skill && <Tag>{sources[stage.skill.source] ?? stage.skill.source}</Tag>}
            <Hash value={stage.skill?.hash} />
            {stage.overridden && <small>默认 Skill · {stage.defaultSkill}</small>}
          </div>
          {stage.harness && <small title={stage.harness.path}>Harness · {statuses[stage.harness.status] ?? stage.harness.status} <Hash value={stage.harness.hash} /></small>}
          {stage.issues?.map((issue, index) => <p className="drama-skill-error" key={index}>{issue}</p>)}
          {editing === stage.id && !data.failure && <BindingPicker stage={stage} skills={data.skills ?? []}
            busy={busy || loading} onSave={skillId => save(stage.id, skillId)} onClose={() => setEditing('')} />}
        </li>)}
      </ol>
    </>}
  </section>
}
