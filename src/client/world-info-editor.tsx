/** Resource-center editor for one stored World Info source. */

import { useEffect, useState } from 'react'
import type { WorldInfoEditableEntry } from '../world-info-configuration-types.ts'
import type { WorldInfoLibraryUpload } from '../world-info-library-protocol.ts'

/** One row in the editor: where it came from, or nothing when newly added. */
export interface WorldInfoEditorRow {
  readonly sourceIndex?: number
  readonly entry: WorldInfoEditableEntry
}

/** Load one world's editable entries. */
export type LoadWorldInfoEntries = (id: string) => Promise<{
  readonly name: string
  readonly entries: readonly WorldInfoEditableEntry[]
}>

/** Store the complete edited entry list, returning the world's new identity. */
export type SaveWorldInfoEntries = (
  id: string,
  entries: readonly WorldInfoEditorRow[],
) => Promise<WorldInfoLibraryUpload>

/**
 * A blank row for a newly added entry. Every field the form does not show still
 * has to be present: the Host merges the whole value onto the stored entry, so
 * a partial one is rejected rather than silently defaulted.
 */
function blankWorldInfoEntry(): WorldInfoEditableEntry {
  return {
    keys: [],
    secondaryKeys: [],
    content: '',
    enabled: true,
    insertionOrder: 100,
    selective: false,
    constant: false,
    caseSensitive: false,
    matchWholeWords: false,
    secondaryLogic: 'and-any',
    position: 'after_char',
    ignoreBudget: false,
  }
}

function rowTitle(entry: WorldInfoEditableEntry, index: number): string {
  return entry.name?.trim() || entry.comment?.trim() || entry.keys[0] || `条目 ${index + 1}`
}

/** Split a comma-separated key field, dropping the blanks a user leaves behind. */
function splitKeys(value: string): readonly string[] {
  return value.split(/[,，]/u).map(item => item.trim()).filter(item => item !== '')
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
 * Edit one stored world in place.
 *
 * The in-session World Info panel is an overlay on an immutable imported book,
 * so its "delete" is a reversible toggle and it cannot add entries at all. This
 * writes the source itself, so adding and removing are real. Saving mints the
 * world a new id — ids are the sha256 of their content — and the Host moves
 * every character binding across. Sessions already under way keep their own
 * frozen snapshot and are untouched.
 */
export function WorldInfoEditorDialog({ entry, load, save, onSaved, onClose }: {
  readonly entry: WorldInfoLibraryUpload
  readonly load: LoadWorldInfoEntries
  readonly save: SaveWorldInfoEntries
  readonly onSaved: (previousId: string, upload: WorldInfoLibraryUpload) => void
  readonly onClose: () => void
}) {
  const [rows, setRows] = useState<readonly WorldInfoEditorRow[]>()
  const [selected, setSelected] = useState(0)
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    let current = true
    void load(entry.id).then(value => {
      if (!current) return
      setRows(value.entries.map((item, index) => ({ sourceIndex: index, entry: item })))
    }, reason => {
      if (current) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => { current = false }
  }, [entry.id])

  const patch = (index: number, value: Partial<WorldInfoEditableEntry>): void => {
    setRows(current => current?.map((row, position) => position === index
      ? { ...row, entry: { ...row.entry, ...value } }
      : row))
    setDirty(true)
  }
  const addRow = (): void => {
    setRows(current => {
      const next = [...(current ?? []), { entry: blankWorldInfoEntry() }]
      setSelected(next.length - 1)
      return next
    })
    setDirty(true)
  }
  const removeRow = (index: number): void => {
    setRows(current => {
      const next = (current ?? []).filter((_row, position) => position !== index)
      setSelected(position => Math.max(0, Math.min(position, next.length - 1)))
      return next
    })
    setDirty(true)
  }
  const commit = (): void => {
    if (rows === undefined || busy) return
    setBusy(true)
    setError(undefined)
    void save(entry.id, rows).then(upload => {
      onSaved(entry.id, upload)
      onClose()
    }, reason => {
      setBusy(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }

  const current = rows === undefined ? undefined : rows[selected]
  return <div data-agent-rp-dialog data-agent-rp-world-info-editor role="dialog" aria-modal="true"
    aria-label={`编辑世界书 ${entry.name}`} style={{
      alignItems: 'center', background: 'rgba(0,0,0,.62)', display: 'flex', inset: 0,
      justifyContent: 'center', padding: '18px', position: 'fixed', zIndex: 1400,
    }} onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <section style={{
      background: 'var(--dsw-alias-bg-base, #171719)', border: '1px solid var(--dsw-alias-border-l2, #3e3e43)',
      borderRadius: '14px', boxShadow: '0 18px 58px rgba(0,0,0,.44)', display: 'flex', flexDirection: 'column',
      maxHeight: 'min(760px, 88vh)', maxWidth: '820px', padding: '18px', width: '100%',
    }}>
      <header style={{ alignItems: 'start', display: 'flex', gap: '14px', justifyContent: 'space-between' }}>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ fontSize: '16px', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            编辑「{entry.name}」
          </h2>
          <p style={{ fontSize: '11px', lineHeight: 1.55, margin: '5px 0 0', opacity: .55 }}>
            保存会改写这本世界书本身，绑定它的角色卡会一起跟上；已经开始的会话保留自己的快照，不受影响。
          </p>
        </div>
        <button type="button" disabled={busy} onClick={onClose} style={{
          background: 'transparent', border: 0, color: 'inherit', cursor: busy ? 'default' : 'pointer',
          font: 'inherit', fontSize: '18px', opacity: .6, padding: '0 3px',
        }} aria-label="关闭世界书编辑">×</button>
      </header>

      {rows === undefined && error === undefined && <p role="status" style={{
        fontSize: '13px', margin: '22px 0 4px', opacity: .58,
      }}>正在读取条目…</p>}

      {rows !== undefined && <div style={{
        display: 'grid', gap: '12px', gridTemplateColumns: 'minmax(0, 220px) minmax(0, 1fr)',
        marginTop: '14px', minHeight: 0,
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', minHeight: 0 }}>
          <div style={{ display: 'flex', gap: '6px' }}>
            <button type="button" data-agent-rp-action="add-world-info-entry" disabled={busy} onClick={addRow}
              style={{ ...buttonStyle, flex: 1 }}>新增条目</button>
            <button type="button" data-agent-rp-action="delete-world-info-entry"
              disabled={busy || current === undefined} onClick={() => { removeRow(selected) }}
              style={{ ...buttonStyle, color: 'var(--dsw-alias-state-danger, #e06470)' }}>删除</button>
          </div>
          <div style={{
            border: '1px solid var(--dsw-alias-border-l2, #3b3b41)', borderRadius: '9px',
            flex: 1, minHeight: 0, overflowY: 'auto',
          }}>
            {rows.length === 0 && <p style={{ fontSize: '11px', margin: '12px 10px', opacity: .5 }}>这本世界书没有条目</p>}
            {rows.map((row, index) => <button key={index} type="button" onClick={() => { setSelected(index) }}
              style={{
                background: index === selected ? 'color-mix(in srgb, currentColor 9%, transparent)' : 'transparent',
                border: 0, color: 'inherit', cursor: 'pointer', display: 'block', font: 'inherit', fontSize: '12px',
                opacity: row.entry.enabled ? 1 : .5, overflow: 'hidden', padding: '7px 9px', textAlign: 'left',
                textOverflow: 'ellipsis', whiteSpace: 'nowrap', width: '100%',
              }}>
              {rowTitle(row.entry, index)}{row.sourceIndex === undefined ? ' · 新增' : ''}
            </button>)}
          </div>
        </div>

        <div style={{ display: 'grid', gap: '8px', minHeight: 0, overflowY: 'auto' }}>
          {current === undefined && <p style={{ fontSize: '12px', margin: 0, opacity: .5 }}>选择左侧的条目开始编辑</p>}
          {current !== undefined && <>
            <label style={{ display: 'grid', fontSize: '11px', gap: '4px', opacity: .8 }}>标题
              <input value={current.entry.name ?? ''} disabled={busy} style={fieldStyle}
                onChange={event => { patch(selected, { name: event.target.value }) }} />
            </label>
            <label style={{ display: 'grid', fontSize: '11px', gap: '4px', opacity: .8 }}>备注
              <input value={current.entry.comment ?? ''} disabled={busy} style={fieldStyle}
                onChange={event => { patch(selected, { comment: event.target.value }) }} />
            </label>
            <label style={{ display: 'grid', fontSize: '11px', gap: '4px', opacity: .8 }}>主关键词（逗号分隔）
              <input value={current.entry.keys.join(', ')} disabled={busy} style={fieldStyle}
                onChange={event => { patch(selected, { keys: splitKeys(event.target.value) }) }} />
            </label>
            <label style={{ display: 'grid', fontSize: '11px', gap: '4px', opacity: .8 }}>次要关键词（逗号分隔）
              <input value={current.entry.secondaryKeys.join(', ')} disabled={busy} style={fieldStyle}
                onChange={event => { patch(selected, { secondaryKeys: splitKeys(event.target.value) }) }} />
            </label>
            <label style={{ display: 'grid', fontSize: '11px', gap: '4px', opacity: .8 }}>正文
              <textarea value={current.entry.content} rows={9} disabled={busy}
                style={{ ...fieldStyle, lineHeight: 1.55, resize: 'vertical' }}
                onChange={event => { patch(selected, { content: event.target.value }) }} />
            </label>
            <div style={{ display: 'flex', flexWrap: 'wrap', fontSize: '11px', gap: '12px', opacity: .8 }}>
              <label style={{ alignItems: 'center', display: 'flex', gap: '5px' }}>
                <input type="checkbox" checked={current.entry.enabled} disabled={busy}
                  onChange={event => { patch(selected, { enabled: event.target.checked }) }} />启用
              </label>
              <label style={{ alignItems: 'center', display: 'flex', gap: '5px' }}>
                <input type="checkbox" checked={current.entry.constant} disabled={busy}
                  onChange={event => { patch(selected, { constant: event.target.checked }) }} />常驻
              </label>
              <label style={{ alignItems: 'center', display: 'flex', gap: '5px' }}>插入顺序
                <input type="number" value={current.entry.insertionOrder} disabled={busy}
                  style={{ ...fieldStyle, width: '84px' }}
                  onChange={event => { patch(selected, { insertionOrder: Number(event.target.value) || 0 }) }} />
              </label>
            </div>
          </>}
        </div>
      </div>}

      {error !== undefined && <p role="alert" style={{
        color: 'var(--dsw-alias-state-danger, #e06470)', fontSize: '12px', lineHeight: 1.5, margin: '12px 0 0',
      }}>{error}</p>}

      <div style={{ alignItems: 'center', display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '14px' }}>
        <span style={{ fontSize: '11px', marginRight: 'auto', opacity: .5 }}>
          {rows === undefined ? '' : `${rows.length} 条目${dirty ? ' · 有未保存的修改' : ''}`}
        </span>
        <button type="button" disabled={busy} onClick={onClose} style={buttonStyle}>取消</button>
        <button type="button" data-agent-rp-action="save-world-info" disabled={busy || rows === undefined || !dirty}
          onClick={commit} style={{
            ...buttonStyle,
            background: 'color-mix(in srgb, currentColor 14%, transparent)',
            opacity: busy || !dirty ? .5 : 1,
          }}>{busy ? '保存中…' : '保存'}</button>
      </div>
    </section>
  </div>
}
