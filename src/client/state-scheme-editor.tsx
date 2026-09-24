/** Authoring surface for native state schemes and their panel templates. */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { BASIC_ROLEPLAY_STATE_PANEL_TEMPLATE } from '../roleplay-state-scheme-ids.ts'
import { compileStatePanelDocument } from './state-panel.tsx'
import {
  renderRoleplayStateTemplate,
  ROLEPLAY_STATE_TEMPLATE_FORMATS,
  type RoleplayStateTemplateFormat,
} from '../roleplay-state-template.ts'
import type {
  StateSchemeLibraryEntry,
  StateSchemeLibrarySummary,
} from '../state-scheme-library-protocol.ts'
import {
  deleteStateScheme,
  listStateSchemes,
  readStateScheme,
  saveStateScheme,
} from './state-scheme-client.ts'

interface SchemeDraft {
  readonly id?: string
  readonly expectedRevision: number
  readonly name: string
  readonly stateId: string
  readonly initialText: string
  readonly rules: string
  readonly templateFormat: RoleplayStateTemplateFormat
  readonly templateSource: string
}

const EMPTY_DRAFT: SchemeDraft = {
  expectedRevision: 0,
  name: '新状态方案',
  stateId: 'state:custom',
  initialText: JSON.stringify({ 场景: { 地点: '未定' }, 角色: { 状态: '正常' } }, undefined, 2),
  rules: '只在正文明确写出变化时更新对应字段，不要凭推测改写。',
  templateFormat: 'html',
  templateSource: BASIC_ROLEPLAY_STATE_PANEL_TEMPLATE,
}

function draftOf(entry: StateSchemeLibraryEntry): SchemeDraft {
  return {
    id: entry.id,
    expectedRevision: entry.revision,
    name: entry.name,
    stateId: entry.stateId,
    initialText: JSON.stringify(entry.initial, undefined, 2),
    rules: entry.rules,
    templateFormat: entry.template.format,
    templateSource: entry.template.source,
  }
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function formatName(format: RoleplayStateTemplateFormat): string {
  return format === 'html' ? 'HTML' : format === 'markdown' ? 'Markdown' : '纯文本'
}

const fieldStyle = {
  background: 'var(--dsw-alias-bg-elevated, #202126)', border: '1px solid var(--dsw-alias-border-l2, #3d3d43)',
  borderRadius: '8px', color: 'inherit', font: 'inherit', fontSize: '12px', padding: '7px 9px', width: '100%',
} as const

const buttonStyle = {
  background: 'transparent', border: '1px solid var(--dsw-alias-border-l2, #444)', borderRadius: '8px',
  color: 'inherit', cursor: 'pointer', font: 'inherit', fontSize: '11px', padding: '6px 9px',
  whiteSpace: 'nowrap',
} as const

/** List, create, edit and remove authored state schemes without touching any Session. */
export function StateSchemeEditor({ onError }: { readonly onError?: (reason: string) => void }) {
  const [entries, setEntries] = useState<readonly StateSchemeLibrarySummary[]>()
  const [draft, setDraft] = useState<SchemeDraft>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const refresh = useCallback((): void => {
    void listStateSchemes().then(setEntries, (reason: unknown) => {
      setEntries([])
      const text = message(reason)
      setError(text)
      onError?.(text)
    })
  }, [onError])
  useEffect(refresh, [refresh])
  const initialValue = useMemo(() => {
    if (draft === undefined) return { value: undefined, failure: undefined }
    try {
      const parsed: unknown = JSON.parse(draft.initialText)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { value: undefined, failure: '初始值必须是 JSON 对象' }
      }
      return { value: parsed as JsonValue, failure: undefined }
    } catch (reason: unknown) {
      return { value: undefined, failure: `初始值不是有效 JSON：${message(reason)}` }
    }
  }, [draft])
  // The same renderer the panel uses, so the preview cannot disagree with it.
  const preview = useMemo(() => {
    if (draft === undefined || initialValue.value === undefined) return undefined
    try {
      return {
        text: renderRoleplayStateTemplate(
          { format: draft.templateFormat, source: draft.templateSource },
          initialValue.value,
        ),
        failure: undefined as string | undefined,
      }
    } catch (reason: unknown) {
      return { text: '', failure: message(reason) }
    }
  }, [draft, initialValue.value])
  const save = (): void => {
    if (draft === undefined || initialValue.value === undefined || busy) return
    setBusy(true)
    setError(undefined)
    void saveStateScheme({
      format: 0,
      ...(draft.id === undefined ? {} : { id: draft.id }),
      expectedRevision: draft.expectedRevision,
      name: draft.name,
      stateId: draft.stateId,
      initial: initialValue.value,
      rules: draft.rules,
      template: { format: draft.templateFormat, source: draft.templateSource },
    }).then((entry) => {
      setDraft(draftOf(entry))
      refresh()
    }, (reason: unknown) => { setError(message(reason)) }).finally(() => { setBusy(false) })
  }
  const remove = (id: string): void => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    void deleteStateScheme(id).then(() => {
      setDraft(current => current?.id === id ? undefined : current)
      refresh()
    }, (reason: unknown) => { setError(message(reason)) }).finally(() => { setBusy(false) })
  }
  const open = (id: string): void => {
    setError(undefined)
    void readStateScheme(id).then(entry => { setDraft(draftOf(entry)) }, (reason: unknown) => {
      setError(message(reason))
    })
  }
  const blocking = initialValue.failure ?? preview?.failure
  // Regenerated per render so a stale frame cannot linger with old markup.
  const previewNonce = useMemo(
    () => crypto.randomUUID().replaceAll('-', ''),
    [draft?.templateFormat, preview?.text],
  )
  const previewDocument = useMemo(
    () => preview?.text === undefined || draft === undefined
      ? ''
      : compileStatePanelDocument(preview.text, draft.templateFormat, previewNonce, previewNonce),
    [draft?.templateFormat, draft, preview?.text, previewNonce],
  )
  return <div style={{ display: 'grid', gap: '12px', padding: '12px' }}>
    <div style={{ alignItems: 'center', display: 'flex', gap: '10px', justifyContent: 'space-between' }}>
      <p style={{ fontSize: '11px', lineHeight: 1.55, margin: 0, opacity: .58 }}>
        状态方案决定会话保存哪些 JSON 字段、如何结算，以及状态栏怎么呈现。
        初始值与结算规则会在会话启动时冻结；模板随时可改，旧会话重开即生效。
      </p>
      <button type="button" disabled={busy} onClick={() => { setDraft(EMPTY_DRAFT) }} style={buttonStyle}>新建方案</button>
    </div>
    {(error !== undefined) && <p role="alert" style={{
      color: 'var(--dsw-alias-state-danger, #d64d5f)', fontSize: '12px', margin: 0,
    }}>{error}</p>}
    {entries !== undefined && entries.length === 0 && draft === undefined && <p style={{
      border: '1px dashed var(--dsw-alias-border-l2, #3d3d43)', borderRadius: '9px', fontSize: '11px',
      margin: 0, opacity: .5, padding: '16px', textAlign: 'center',
    }}>还没有自定义状态方案；会话仍可使用内置的「Agent RP · 基础状态」</p>}
    {entries?.map(entry => <div key={entry.id} style={{
      alignItems: 'center', border: '1px solid var(--dsw-alias-border-l2, #39393c)', borderRadius: '10px',
      display: 'flex', gap: '12px', padding: '10px 12px',
    }}>
      <div style={{ flex: '1 1 auto', minWidth: 0 }}>
        <strong style={{ display: 'block', fontSize: '12px' }}>{entry.name}</strong>
        <span style={{ display: 'block', fontSize: '11px', marginTop: '2px', opacity: .52 }}>
          {entry.stateId} · {String(entry.fieldCount)} 个顶层字段 · {formatName(entry.templateFormat)} 模板 · v{String(entry.revision)}
        </span>
      </div>
      <button type="button" disabled={busy} onClick={() => { open(entry.id) }} style={buttonStyle}>编辑</button>
      <button type="button" disabled={busy} onClick={() => { remove(entry.id) }} style={buttonStyle}>删除</button>
    </div>)}
    {draft !== undefined && <section style={{
      border: '1px solid var(--dsw-alias-border-l2, #39393c)', borderRadius: '12px',
      display: 'grid', gap: '10px', padding: '12px',
    }}>
      <div style={{ display: 'grid', gap: '8px', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)' }}>
        <label style={{ display: 'grid', fontSize: '11px', gap: '4px', opacity: .8 }}>方案名称
          <input value={draft.name} maxLength={120} onChange={event => {
            setDraft(current => current && { ...current, name: event.target.value })
          }} style={fieldStyle} />
        </label>
        <label style={{ display: 'grid', fontSize: '11px', gap: '4px', opacity: .8 }}>状态命名空间
          <input value={draft.stateId} maxLength={128} placeholder="state:custom" onChange={event => {
            setDraft(current => current && { ...current, stateId: event.target.value })
          }} style={fieldStyle} />
        </label>
      </div>
      <label style={{ display: 'grid', fontSize: '11px', gap: '4px', opacity: .8 }}>初始状态（JSON 对象）
        <textarea value={draft.initialText} rows={8} spellCheck={false} onChange={event => {
          setDraft(current => current && { ...current, initialText: event.target.value })
        }} style={{ ...fieldStyle, font: '12px/1.5 ui-monospace, monospace', resize: 'vertical' }} />
      </label>
      <label style={{ display: 'grid', fontSize: '11px', gap: '4px', opacity: .8 }}>结算规则（发给状态 Worker，不进角色正文）
        <textarea value={draft.rules} rows={5} maxLength={24_000} onChange={event => {
          setDraft(current => current && { ...current, rules: event.target.value })
        }} style={{ ...fieldStyle, lineHeight: 1.5, resize: 'vertical' }} />
      </label>
      <div style={{ alignItems: 'center', display: 'flex', gap: '8px' }}>
        <span style={{ fontSize: '11px', opacity: .8 }}>模板格式</span>
        {ROLEPLAY_STATE_TEMPLATE_FORMATS.map(format => <button key={format} type="button" onClick={() => {
          setDraft(current => current && { ...current, templateFormat: format })
        }} style={{
          ...buttonStyle,
          background: draft.templateFormat === format
            ? 'color-mix(in srgb, var(--dsw-alias-accent, #6ea8fe) 14%, transparent)' : 'transparent',
        }}>{formatName(format)}</button>)}
      </div>
      <label style={{ display: 'grid', fontSize: '11px', gap: '4px', opacity: .8 }}>
        状态栏模板 · <code>{'{{/路径}}'}</code> 取值，<code>{'{{#/路径}}…{{/}}'}</code> 遍历，
        <code>{'{{@}}'}</code> 当前键，<code>{'{{?/路径}}…{{/}}'}</code> 条件
        <textarea value={draft.templateSource} rows={10} spellCheck={false} onChange={event => {
          setDraft(current => current && { ...current, templateSource: event.target.value })
        }} style={{ ...fieldStyle, font: '12px/1.5 ui-monospace, monospace', resize: 'vertical' }} />
      </label>
      {blocking !== undefined && <p role="alert" style={{
        color: 'var(--dsw-alias-state-danger, #d64d5f)', fontSize: '11px', margin: 0,
      }}>{blocking}</p>}
      {preview?.text !== undefined && preview.text !== '' && <details open>
        <summary style={{ cursor: 'pointer', fontSize: '11px', opacity: .7 }}>预览渲染结果（按初始值填充）</summary>
        {/*
          The preview goes through the same document the panel frame uses, so a
          template can never look one way here and another way in the dock.
          Showing the renderer's raw output instead would only be readable for
          the text format.
        */}
        <iframe title="状态栏预览" sandbox="allow-scripts" srcDoc={previewDocument} style={{
          background: 'var(--dsw-alias-bg-base, #15161a)', border: '1px solid var(--dsw-alias-border-l2, #3d3d43)',
          borderRadius: '8px', colorScheme: 'dark', display: 'block', height: '280px',
          marginTop: '8px', width: '100%',
        }} />
      </details>}
      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
        <button type="button" disabled={busy} onClick={() => { setDraft(undefined) }} style={buttonStyle}>取消</button>
        <button type="button" disabled={busy || blocking !== undefined} onClick={save} style={{
          ...buttonStyle,
          background: 'color-mix(in srgb, var(--dsw-alias-accent, #6ea8fe) 16%, transparent)',
        }}>{busy ? '保存中…' : '保存方案'}</button>
      </div>
    </section>}
  </div>
}
