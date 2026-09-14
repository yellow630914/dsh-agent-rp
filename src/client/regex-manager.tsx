/** Session-owned regex manager: one editable overlay over every imported collection. */

import { useEffect, useState } from 'react'
import type { AgentRpProjection } from '../projection-types.ts'
import type {
  RegexConfigurationRequest,
  RegexEditableScript,
} from '../regex-configuration-types.ts'

/** Persist one manager mutation and wait for the Session to record it. */
export type SaveRegexConfiguration = (request: RegexConfigurationRequest) => Promise<void>

type ProjectedScript = AgentRpProjection['regex']['scripts'][number]

const OWNER_LABELS: Readonly<Record<ProjectedScript['owner'], string>> = {
  regex: '正则包',
  'prompt-policy': '预设',
  actor: '角色卡',
  session: '本会话新增',
}

/** Order the groups are presented in, which is also the order they execute. */
const OWNER_ORDER: readonly ProjectedScript['owner'][] = ['regex', 'prompt-policy', 'actor', 'session']

/**
 * A blank rule for a newly added entry. Every field the Host validates has to be
 * present: the whole value replaces the stored one, so a partial value is
 * rejected rather than silently defaulted.
 */
function blankScript(): RegexEditableScript {
  return {
    scriptName: '',
    findRegex: '',
    replaceString: '',
    trimStrings: [],
    placement: [2],
    disabled: false,
    markdownOnly: true,
    promptOnly: false,
    runOnEdit: false,
    substituteRegex: 0,
    minDepth: null,
    maxDepth: null,
  }
}

function editableFrom(script: ProjectedScript['script']): RegexEditableScript {
  return {
    scriptName: script.scriptName,
    findRegex: script.findRegex,
    replaceString: script.replaceString,
    trimStrings: [...script.trimStrings],
    placement: [...script.placement],
    disabled: script.disabled,
    markdownOnly: script.markdownOnly,
    promptOnly: script.promptOnly,
    runOnEdit: script.runOnEdit,
    substituteRegex: script.substituteRegex,
    minDepth: script.minDepth,
    maxDepth: script.maxDepth,
  }
}

function scriptTitle(entry: ProjectedScript): string {
  return entry.script.scriptName.trim() || `未命名规则 ${String(entry.index + 1)}`
}

/** Which views a rule runs in, phrased the way the panel's own switches read. */
function viewLabel(script: RegexEditableScript): string {
  if (script.markdownOnly && !script.promptOnly) return '仅界面显示'
  if (script.promptOnly && !script.markdownOnly) return '仅生成提示'
  if (script.markdownOnly && script.promptOnly) return '两处都不作用'
  return '显示与生成'
}

function depthLabel(script: RegexEditableScript): string {
  if (script.minDepth === null && script.maxDepth === null) return '不限深度'
  const low = script.minDepth === null ? '最早' : String(script.minDepth)
  const high = script.maxDepth === null ? '最新' : String(script.maxDepth)
  return `深度 ${low}–${high}`
}

const fieldStyle = {
  background: 'var(--dsw-alias-bg-base, #151518)',
  border: '1px solid var(--dsw-alias-border-l2, #3b3b41)',
  borderRadius: '7px',
  boxSizing: 'border-box' as const,
  color: 'inherit',
  font: 'inherit',
  fontSize: '12px',
  padding: '6px 8px',
  width: '100%',
}

const buttonStyle = {
  background: 'transparent',
  border: '1px solid color-mix(in srgb, currentColor 20%, transparent)',
  borderRadius: '6px',
  color: 'inherit',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: '11px',
  padding: '4px 9px',
}

/**
 * Edit this Session's regex rules.
 *
 * Imported collections stay immutable — the card, the preset and every pack were
 * frozen into the Session when it started, and a branch inherits them. What this
 * writes is an overlay addressed by `(owner, index)`, which is the same address
 * the prompt view and the display view both resolve, so one edit reaches both.
 * Nothing here touches the resource library, so another Session is unaffected.
 */
export function RegexManagerDialog({ regex, onSave, onClose }: {
  readonly regex: AgentRpProjection['regex']
  readonly onSave: SaveRegexConfiguration
  readonly onClose: () => void
}) {
  const [selected, setSelected] = useState<string>()
  const [draft, setDraft] = useState<RegexEditableScript>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const key = (entry: ProjectedScript): string => `${entry.owner}:${String(entry.index)}`
  const current = regex.scripts.find(entry => key(entry) === selected)
  // Narrowed once so the imported branches can address the overlay; the
  // Session's own rules use their own index-addressed operations instead.
  const importedOwner = current === undefined || current.owner === 'session' ? undefined : current.owner

  // A committed change re-projects, so the draft has to follow the new value
  // rather than keep showing what was typed against the previous revision.
  useEffect(() => { setDraft(current === undefined ? undefined : editableFrom(current.script)) },
    [selected, regex.revision])

  const run = (request: RegexConfigurationRequest, after?: () => void): void => {
    setBusy(true)
    setError(undefined)
    void onSave(request).then(() => {
      setBusy(false)
      after?.()
    }, (reason: unknown) => {
      setBusy(false)
      setError(reason instanceof Error ? reason.message : '无法保存正则改动')
    })
  }

  const patch = (value: Partial<RegexEditableScript>): void => {
    setDraft(previous => previous === undefined ? previous : { ...previous, ...value })
  }
  const dirty = draft !== undefined && current !== undefined
    && JSON.stringify(draft) !== JSON.stringify(editableFrom(current.script))

  const save = (): void => {
    if (draft === undefined || current === undefined) return
    run(current.owner === 'session'
      ? { operation: 'edit-added', revision: regex.revision, index: current.index, script: draft }
      : { operation: 'edit', revision: regex.revision, owner: importedOwner!, index: current.index, script: draft })
  }

  const grouped = OWNER_ORDER.map(owner => ({
    owner,
    entries: regex.scripts.filter(entry => entry.owner === owner),
  })).filter(group => group.entries.length > 0 || group.owner === 'session')

  return <div data-agent-rp-dialog data-agent-rp-regex-panel role="dialog" aria-modal="true" aria-label="正则" style={{
    alignItems: 'center', background: 'rgba(0,0,0,.62)', display: 'flex', inset: 0,
    justifyContent: 'center', padding: '18px', position: 'fixed', zIndex: 1200,
  }} onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <section style={{
      background: 'var(--dsw-alias-bg-base, #171719)', border: '1px solid var(--dsw-alias-border-l2, #3e3e43)',
      borderRadius: '14px', boxShadow: '0 18px 58px rgba(0,0,0,.44)', display: 'flex', flexDirection: 'column',
      maxHeight: 'min(760px, 88vh)', maxWidth: '880px', padding: '18px', width: '100%',
    }}>
      <header style={{ alignItems: 'start', display: 'flex', gap: '14px', justifyContent: 'space-between' }}>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ fontSize: '16px', margin: 0 }}>正则</h2>
          <p style={{ fontSize: '11px', lineHeight: 1.55, margin: '5px 0 0', opacity: .55 }}>
            改动只属于这段会话，不会影响角色库、预设或正则包，分支时会一起带走。
          </p>
        </div>
        <button type="button" disabled={busy} onClick={onClose} style={{
          background: 'transparent', border: 0, color: 'inherit', cursor: busy ? 'default' : 'pointer',
          font: 'inherit', fontSize: '18px', opacity: .6, padding: '0 3px',
        }} aria-label="关闭正则面板">×</button>
      </header>

      <div style={{
        display: 'grid', gap: '12px', gridTemplateColumns: 'minmax(0, 260px) minmax(0, 1fr)',
        marginTop: '14px', minHeight: 0,
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', minHeight: 0 }}>
          <button type="button" data-agent-rp-action="add-session-regex" disabled={busy} style={buttonStyle}
            onClick={() => {
              run({ operation: 'add', revision: regex.revision, script: blankScript() }, () => {
                setSelected(`session:${String(regex.scripts.filter(entry => entry.owner === 'session').length)}`)
              })
            }}>新增本会话规则</button>
          <div style={{
            border: '1px solid var(--dsw-alias-border-l2, #3b3b41)', borderRadius: '9px',
            flex: 1, minHeight: 0, overflowY: 'auto',
          }}>
            {grouped.map(group => <section key={group.owner} data-agent-rp-regex-group={group.owner}>
              <div style={{ fontSize: '10px', opacity: .5, padding: '8px 9px 4px' }}>
                {OWNER_LABELS[group.owner]}{group.entries.length === 0 ? ' · 无' : ` · ${String(group.entries.length)}`}
              </div>
              {group.entries.map(entry => <button key={key(entry)} type="button"
                aria-current={key(entry) === selected}
                onClick={() => { setSelected(key(entry)); setError(undefined) }}
                style={{
                  background: key(entry) === selected ? 'color-mix(in srgb, currentColor 9%, transparent)' : 'transparent',
                  border: 0, color: 'inherit', cursor: 'pointer', display: 'block', font: 'inherit', fontSize: '12px',
                  opacity: entry.deleted || entry.script.disabled ? .45 : 1, overflow: 'hidden',
                  padding: '6px 9px', textAlign: 'left', textOverflow: 'ellipsis', whiteSpace: 'nowrap', width: '100%',
                }}>
                {scriptTitle(entry)}
                <span style={{ fontSize: '10px', opacity: .55 }}>
                  {entry.deleted ? ' · 已删除' : entry.script.disabled ? ' · 已停用' : ''}
                  {entry.modified && !entry.deleted ? ' · 已改' : ''}
                </span>
              </button>)}
            </section>)}
          </div>
          {regex.scripts.some(entry => entry.modified || entry.deleted) && <button type="button" disabled={busy}
            onClick={() => { run({ operation: 'reset-all', revision: regex.revision }, () => { setSelected(undefined) }) }}
            style={buttonStyle}>全部恢复导入状态</button>}
        </div>

        <div style={{ display: 'grid', gap: '8px', minHeight: 0, overflowY: 'auto' }}>
          {current === undefined && <p style={{ fontSize: '12px', margin: 0, opacity: .5 }}>选择左侧的规则开始编辑</p>}
          {current !== undefined && draft !== undefined && <>
            <div style={{ alignItems: 'center', display: 'flex', flexWrap: 'wrap', fontSize: '11px', gap: '8px' }}>
              <span style={{ opacity: .55 }}>{OWNER_LABELS[current.owner]} · {viewLabel(draft)} · {depthLabel(draft)}</span>
              <span style={{ marginLeft: 'auto', display: 'flex', gap: '6px' }}>
                <button type="button" disabled={busy || current.deleted} style={buttonStyle} onClick={() => {
                  run(current.owner === 'session'
                    ? { operation: 'edit-added', revision: regex.revision, index: current.index, script: { ...draft, disabled: !draft.disabled } }
                    : { operation: 'toggle', revision: regex.revision, owner: importedOwner!, index: current.index, disabled: !draft.disabled })
                }}>{draft.disabled ? '启用' : '停用'}</button>
                {current.owner === 'session'
                  ? <button type="button" disabled={busy} style={{ ...buttonStyle, color: 'var(--dsw-alias-state-danger, #e06470)' }}
                    onClick={() => {
                      run({ operation: 'remove-added', revision: regex.revision, index: current.index },
                        () => { setSelected(undefined) })
                    }}>删除</button>
                  : <button type="button" disabled={busy} style={{ ...buttonStyle, color: current.deleted ? 'inherit' : 'var(--dsw-alias-state-danger, #e06470)' }}
                    onClick={() => {
                      run({
                        operation: 'delete', revision: regex.revision, owner: importedOwner!,
                        index: current.index, deleted: !current.deleted,
                      })
                    }}>{current.deleted ? '恢复' : '删除'}</button>}
                {current.owner !== 'session' && (current.modified || current.deleted) && <button type="button"
                  disabled={busy} style={buttonStyle} onClick={() => {
                    run({ operation: 'reset-script', revision: regex.revision, owner: importedOwner!, index: current.index })
                  }}>恢复导入值</button>}
              </span>
            </div>

            <label style={{ display: 'grid', fontSize: '11px', gap: '4px', opacity: .8 }}>名称
              <input value={draft.scriptName} disabled={busy} style={fieldStyle}
                onChange={event => { patch({ scriptName: event.target.value }) }} />
            </label>
            <label style={{ display: 'grid', fontSize: '11px', gap: '4px', opacity: .8 }}>查找（正则或 /表达式/标志）
              <textarea value={draft.findRegex} rows={2} disabled={busy}
                style={{ ...fieldStyle, fontFamily: 'ui-monospace, monospace', resize: 'vertical' }}
                onChange={event => { patch({ findRegex: event.target.value }) }} />
            </label>
            <label style={{ display: 'grid', fontSize: '11px', gap: '4px', opacity: .8 }}>替换为
              <textarea value={draft.replaceString} rows={3} disabled={busy}
                style={{ ...fieldStyle, fontFamily: 'ui-monospace, monospace', resize: 'vertical' }}
                onChange={event => { patch({ replaceString: event.target.value }) }} />
            </label>
            <label style={{ display: 'grid', fontSize: '11px', gap: '4px', opacity: .8 }}>从匹配中剔除（每行一条）
              <textarea value={draft.trimStrings.join('\n')} rows={2} disabled={busy}
                style={{ ...fieldStyle, resize: 'vertical' }}
                onChange={event => {
                  patch({ trimStrings: event.target.value.split('\n').map(item => item.trim()).filter(item => item !== '') })
                }} />
            </label>

            <fieldset style={{ border: '1px solid var(--dsw-alias-border-l2, #3b3b41)', borderRadius: '8px', margin: 0, padding: '8px 10px' }}>
              <legend style={{ fontSize: '10px', opacity: .6, padding: '0 4px' }}>扫描对象</legend>
              <div style={{ display: 'flex', flexWrap: 'wrap', fontSize: '11px', gap: '12px' }}>
                {[[1, '玩家消息'], [2, '角色消息']].map(([value, label]) => <label key={String(value)}
                  style={{ alignItems: 'center', display: 'flex', gap: '5px' }}>
                  <input type="checkbox" disabled={busy} checked={draft.placement.includes(value as number)}
                    onChange={event => {
                      const next = event.target.checked
                        ? [...new Set([...draft.placement, value as number])].sort()
                        : draft.placement.filter(item => item !== value)
                      // The Host refuses a rule with no target; keeping the last
                      // one checked says so before the save round trip does.
                      if (next.length === 0) return
                      patch({ placement: next })
                    }} />{label as string}
                </label>)}
              </div>
            </fieldset>

            <fieldset style={{ border: '1px solid var(--dsw-alias-border-l2, #3b3b41)', borderRadius: '8px', margin: 0, padding: '8px 10px' }}>
              <legend style={{ fontSize: '10px', opacity: .6, padding: '0 4px' }}>作用阶段</legend>
              <div style={{ display: 'flex', flexWrap: 'wrap', fontSize: '11px', gap: '12px' }}>
                <label style={{ alignItems: 'center', display: 'flex', gap: '5px' }}>
                  <input type="checkbox" disabled={busy} checked={draft.markdownOnly}
                    onChange={event => { patch({ markdownOnly: event.target.checked }) }} />仅界面显示
                </label>
                <label style={{ alignItems: 'center', display: 'flex', gap: '5px' }}>
                  <input type="checkbox" disabled={busy} checked={draft.promptOnly}
                    onChange={event => { patch({ promptOnly: event.target.checked }) }} />仅生成提示
                </label>
                <span style={{ opacity: .5 }}>两个都不勾＝显示与生成都作用</span>
              </div>
            </fieldset>

            <fieldset style={{ border: '1px solid var(--dsw-alias-border-l2, #3b3b41)', borderRadius: '8px', margin: 0, padding: '8px 10px' }}>
              <legend style={{ fontSize: '10px', opacity: .6, padding: '0 4px' }}>扫描深度（楼层，留空为不限）</legend>
              <div style={{ alignItems: 'center', display: 'flex', flexWrap: 'wrap', fontSize: '11px', gap: '10px' }}>
                <label style={{ alignItems: 'center', display: 'flex', gap: '5px' }}>最浅
                  <input type="number" min={-1} disabled={busy} value={draft.minDepth ?? ''}
                    style={{ ...fieldStyle, width: '84px' }}
                    onChange={event => {
                      const value = event.target.value.trim()
                      patch({ minDepth: value === '' ? null : Math.trunc(Number(value)) || 0 })
                    }} />
                </label>
                <label style={{ alignItems: 'center', display: 'flex', gap: '5px' }}>最深
                  <input type="number" min={-1} disabled={busy} value={draft.maxDepth ?? ''}
                    style={{ ...fieldStyle, width: '84px' }}
                    onChange={event => {
                      const value = event.target.value.trim()
                      patch({ maxDepth: value === '' ? null : Math.trunc(Number(value)) || 0 })
                    }} />
                </label>
                <span style={{ opacity: .5 }}>0 是最新一层</span>
              </div>
            </fieldset>
          </>}
        </div>
      </div>

      {error !== undefined && <p role="alert" style={{
        color: 'var(--dsw-alias-state-danger, #e06470)', fontSize: '12px', lineHeight: 1.5, margin: '12px 0 0',
      }}>{error}</p>}

      <div style={{ alignItems: 'center', display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '14px' }}>
        <span style={{ fontSize: '11px', marginRight: 'auto', opacity: .5 }}>
          {regex.scripts.length} 条规则{dirty ? ' · 有未保存的修改' : ''}
        </span>
        <button type="button" disabled={busy} onClick={onClose} style={buttonStyle}>关闭</button>
        <button type="button" data-agent-rp-action="save-regex" disabled={busy || !dirty} onClick={save} style={{
          ...buttonStyle,
          background: 'color-mix(in srgb, currentColor 14%, transparent)',
          opacity: busy || !dirty ? .5 : 1,
        }}>{busy ? '保存中…' : '保存'}</button>
      </div>
    </section>
  </div>
}
