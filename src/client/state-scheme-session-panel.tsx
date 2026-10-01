/** The state contract this Session runs under, shown and edited in the state dialog. */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { AgentRpProjection } from '../projection-types.ts'
import { BASIC_ROLEPLAY_STATE_PANEL_TEMPLATE } from '../roleplay-state-scheme-ids.ts'
import {
  renderRoleplayStateTemplate,
  type RoleplayStateTemplate,
} from '../roleplay-state-template.ts'
import { compileStatePanelDocument } from './state-panel.tsx'
import {
  changeSessionStateScheme,
  listStateSchemeSources,
  readSessionStateScheme,
} from './state-scheme-client.ts'

const DEFAULT_TEMPLATE: RoleplayStateTemplate = {
  format: 'html',
  source: BASIC_ROLEPLAY_STATE_PANEL_TEMPLATE,
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
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

const monoStyle = {
  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: '12px', lineHeight: 1.55,
} as const

/**
 * Adopt a contract into a Session that launched without one.
 *
 * Only the character and experience launches ever seeded a state scheme; a chat
 * migration, a branch, or a Session started before the scheme existed all land
 * here with nothing. The Host has always accepted a late adoption — it mints
 * the Session's own identity then instead of at launch — but the dialog only
 * rendered the contract section when a contract already existed, so there was
 * no way in to reach it.
 */
export function RoleplayStateSchemeAdoptSection({ sessionId, onChanged }: {
  readonly sessionId: string
  readonly onChanged: () => void
}) {
  const [sources, setSources] = useState<readonly { readonly id: string; readonly name: string }[]>()
  const [selected, setSelected] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    void listStateSchemeSources().then((entries) => {
      setSources(entries)
      setSelected(current => current === '' ? entries[0]?.id ?? '' : current)
    }, () => { setSources([]) })
  }, [])

  const adopt = useCallback((): void => {
    if (busy || selected === '') return
    setBusy(true)
    setError(undefined)
    void changeSessionStateScheme(sessionId, { resourceId: selected })
      .then(onChanged, (reason: unknown) => { setError(message(reason)) })
      .finally(() => { setBusy(false) })
  }, [busy, onChanged, selected, sessionId])

  return <section style={{
    background: 'var(--dsw-alias-bg-layer-1, #222226)', border: '1px solid var(--dsw-alias-border-l2, #3e3e43)',
    borderRadius: '11px', display: 'grid', gap: '11px', marginTop: '18px', padding: '13px',
  }}>
    <div style={{ alignItems: 'baseline', display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
      <strong style={{ fontSize: '13px' }}>状态方案</strong>
      <span style={{ fontSize: '10px', marginLeft: 'auto', opacity: .46 }}>本会话尚未采用</span>
    </div>
    <p style={{ fontSize: '11px', lineHeight: 1.55, margin: 0, opacity: .58 }}>
      采用之后，这一轮正文结束就会按方案结算状态，状态栏也会出现。会话已有的对话不受影响；
      方案的初始值会成为第一次结算的基线
    </p>
    <label style={{ display: 'grid', fontSize: '11px', gap: '5px', opacity: .8 }}>
      来源方案
      <select value={selected} disabled={busy || sources === undefined}
        onChange={event => { setSelected(event.target.value) }} style={fieldStyle}>
        {sources === undefined && <option value="">载入中…</option>}
        {sources?.length === 0 && <option value="">（没有可用的状态方案）</option>}
        {(sources ?? []).map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
      </select>
    </label>
    <div style={{ display: 'flex', gap: '8px' }}>
      <button type="button" disabled={busy || selected === ''} onClick={adopt} style={buttonStyle}>
        {busy ? '采用中…' : '采用这个方案'}
      </button>
    </div>
    {error !== undefined && <p role="status" style={{
      color: 'var(--dsw-alias-state-warning, #d6a955)', fontSize: '11px', lineHeight: 1.5, margin: 0,
    }}>{error}</p>}
  </section>
}

/** Show and edit the Session-owned contract: source, namespace, opening value, rules and panel. */
export function RoleplayStateSchemeSection({ scheme, sessionId, settledRevision, onManage, onChanged }: {
  readonly scheme: NonNullable<AgentRpProjection['stateScheme']>
  readonly sessionId: string
  /** Revision already settled for this namespace; zero means the opening value is still live. */
  readonly settledRevision: number
  /** Player write through the same `rp-state` channel the state list uses. */
  readonly onManage: (request: {
    readonly format: 0
    readonly operation: 'set'
    readonly id: string
    readonly expectedRevision: number
    readonly value: JsonValue
  }) => Promise<void>
  readonly onChanged: () => void
}) {
  const [sources, setSources] = useState<readonly { readonly id: string; readonly name: string }[]>()
  const [template, setTemplate] = useState<RoleplayStateTemplate>(DEFAULT_TEMPLATE)
  const [templateDraft, setTemplateDraft] = useState<string>()
  const [templateOrigin, setTemplateOrigin] = useState<'session' | 'source' | 'builtin'>('builtin')
  const [valueText, setValueText] = useState(() => JSON.stringify(scheme.value, undefined, 2))
  const [name, setName] = useState(scheme.name)
  const [rules, setRules] = useState(scheme.rules)
  const [budgetText, setBudgetText] = useState(
    scheme.verificationMaxTokens === undefined ? '' : String(scheme.verificationMaxTokens),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()

  useEffect(() => {
    void listStateSchemeSources().then(setSources, () => { setSources([]) })
  }, [])

  // The Host resolves which template wins — this Session's own copy, the source
  // entry's, or the built-in — so the dialog and the dock panel can never
  // disagree about it.
  useEffect(() => {
    let cancelled = false
    void readSessionStateScheme(sessionId).then((entry) => {
      if (cancelled) return
      setTemplate(entry.template)
      setTemplateOrigin(entry.templateOrigin)
      setTemplateDraft(undefined)
    }, (reason: unknown) => {
      if (cancelled) return
      setTemplate(DEFAULT_TEMPLATE)
      setTemplateOrigin('builtin')
      setError(message(reason))
    })
    return () => { cancelled = true }
  }, [scheme.id, scheme.revision, sessionId])

  useEffect(() => { setName(scheme.name) }, [scheme.name])
  useEffect(() => { setRules(scheme.rules) }, [scheme.rules])
  useEffect(() => {
    setBudgetText(scheme.verificationMaxTokens === undefined ? '' : String(scheme.verificationMaxTokens))
  }, [scheme.verificationMaxTokens])
  // The live value is authoritative: a settlement, a switch or another edit all
  // arrive through the projection, so the editor follows it instead of holding
  // a stale draft.
  useEffect(() => { setValueText(JSON.stringify(scheme.value, undefined, 2)) }, [scheme.revision, scheme.value])

  const parsedValue = useMemo(() => {
    try {
      const value: unknown = JSON.parse(valueText)
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { value: undefined, failure: '状态值必须是 JSON 对象' }
      }
      return { value: value as JsonValue, failure: undefined }
    } catch (reason: unknown) {
      return { value: undefined, failure: `状态值不是有效 JSON：${message(reason)}` }
    }
  }, [valueText])

  const previewDocument = useMemo(() => {
    try {
      const rendered = renderRoleplayStateTemplate(
        templateDraft === undefined ? template : { format: template.format, source: templateDraft },
        scheme.value as JsonValue,
      )
      const nonce = 'statescheme'
      return compileStatePanelDocument(rendered, template.format, nonce, nonce)
    } catch (reason: unknown) {
      return `<!doctype html><meta charset="utf-8"><pre style="color:#e08">${message(reason)}</pre>`
    }
  }, [scheme.value, template, templateDraft])

  const apply = useCallback((change: Parameters<typeof changeSessionStateScheme>[1], done: string): void => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    void changeSessionStateScheme(sessionId, change).then(() => {
      setNotice(done)
      onChanged()
    }, (reason: unknown) => { setError(message(reason)) }).finally(() => { setBusy(false) })
  }, [busy, onChanged, sessionId])

  const valueDirty = parsedValue.value !== undefined
    && JSON.stringify(parsedValue.value) !== JSON.stringify(scheme.value)
  // Rules are edited far more often than the name, so the check has to cover
  // both or the button sits disabled while the player types.
  const budgetValue = budgetText.trim() === '' ? undefined : Number(budgetText.trim())
  const budgetInvalid = budgetValue !== undefined
    && (!Number.isSafeInteger(budgetValue) || budgetValue < 1024 || budgetValue > 200_000)
  const contractDirty = name.trim() !== scheme.name || rules !== scheme.rules
    || budgetValue !== scheme.verificationMaxTokens
  const saveValue = useCallback((): void => {
    if (busy || parsedValue.value === undefined) return
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    void onManage({
      format: 0,
      operation: 'set',
      id: scheme.stateId,
      expectedRevision: settledRevision,
      value: parsedValue.value,
    }).then(() => {
      setNotice('已写入当前值')
      onChanged()
    }, (reason: unknown) => { setError(message(reason)) }).finally(() => { setBusy(false) })
  }, [busy, onChanged, onManage, parsedValue.value, scheme.stateId, settledRevision])
  return <section style={{
    background: 'var(--dsw-alias-bg-layer-1, #222226)', border: '1px solid var(--dsw-alias-border-l2, #3e3e43)',
    borderRadius: '11px', display: 'grid', gap: '11px', marginTop: '18px', padding: '13px',
  }}>
    <div style={{ alignItems: 'baseline', display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
      <strong style={{ fontSize: '13px' }}>状态方案</strong>
      <span style={{ ...monoStyle, fontSize: '10px', opacity: .42 }}>{scheme.id}</span>
      <span style={{ fontSize: '10px', marginLeft: 'auto', opacity: .46 }}>
        {settledRevision === 0 ? '尚未结算，显示的是方案初始值' : `已结算 v${String(settledRevision)}`}
      </span>
    </div>

    <div style={{ display: 'grid', gap: '8px', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)' }}>
      <label style={{ display: 'grid', fontSize: '11px', gap: '5px', opacity: .8 }}>方案名称
        <input value={name} maxLength={120} disabled={busy} onChange={event => { setName(event.target.value) }}
          style={fieldStyle} />
      </label>
      <label style={{ display: 'grid', fontSize: '11px', gap: '5px', opacity: .8 }}>状态命名空间（不可变）
        <input value={scheme.stateId} readOnly style={{ ...fieldStyle, ...monoStyle, opacity: .62 }} />
      </label>
    </div>

    <label style={{ display: 'grid', fontSize: '11px', gap: '5px', opacity: .8 }}>
      来源方案（切换会保留本会话的标识与命名空间，已结算的值不会被清空）
      <select value={scheme.libraryId === undefined ? '' : `state-scheme:library:${scheme.libraryId}`}
        disabled={busy || sources === undefined} onChange={event => {
          apply({ resourceId: event.target.value }, '已切换来源方案')
        }} style={fieldStyle}>
        {scheme.libraryId === undefined && <option value="">（内置或已删除的来源）</option>}
        {(sources ?? []).map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
      </select>
    </label>

    <label style={{ display: 'grid', fontSize: '11px', gap: '5px', opacity: .8 }}>
      当前值（下一轮模型会读到的事实{settledRevision === 0 ? '；尚未结算，所以这就是方案的初始值' : ''}）
      <textarea value={valueText} rows={9} spellCheck={false} disabled={busy}
        onChange={event => { setValueText(event.target.value) }}
        style={{ ...fieldStyle, ...monoStyle, resize: 'vertical' }} />
    </label>

    <label style={{ display: 'grid', fontSize: '11px', gap: '5px', opacity: .8 }}>
      核验补全上限（留空用预设；推理与答案共用这份额度，状态越大需要越多）
      <input value={budgetText} inputMode="numeric" disabled={busy} placeholder="例如 16384"
        onChange={event => { setBudgetText(event.target.value) }}
        style={{ ...fieldStyle, ...monoStyle, ...(budgetInvalid
          ? { borderColor: 'var(--dsw-alias-state-danger, #d64d5f)' } : {}) }} />
    </label>

    <label style={{ display: 'grid', fontSize: '11px', gap: '5px', opacity: .8 }}>结算规则（发给状态 Worker）
      <textarea value={rules} rows={5} maxLength={24_000} disabled={busy}
        onChange={event => { setRules(event.target.value) }}
        style={{ ...fieldStyle, lineHeight: 1.5, resize: 'vertical' }} />
    </label>

    <div>
      <div style={{ alignItems: 'baseline', display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
        <span style={{ fontSize: '11px', opacity: .8 }}>状态栏模板</span>
        <span style={{ fontSize: '10px', opacity: .46 }}>
          {template.format.toUpperCase()} · {templateOrigin === 'session' ? '本会话副本'
            : templateOrigin === 'source' ? '跟随来源方案，在资源中心改了这里也会变'
              : '内置模板'}
        </span>
        {templateOrigin === 'session' && <button type="button" disabled={busy} onClick={() => {
          apply({ edit: { template: null } }, '已改回跟随来源方案的模板')
        }} style={{ ...buttonStyle, marginLeft: 'auto' }}>改回跟随来源</button>}
      </div>
      <textarea value={templateDraft ?? template.source} rows={8} spellCheck={false} disabled={busy}
        onChange={event => { setTemplateDraft(event.target.value) }}
        style={{ ...fieldStyle, ...monoStyle, marginTop: '6px', resize: 'vertical' }} />
      {templateDraft !== undefined && templateDraft !== template.source && <div style={{
        display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '6px',
      }}>
        <button type="button" disabled={busy} onClick={() => { setTemplateDraft(undefined) }}
          style={buttonStyle}>放弃改动</button>
        <button type="button" disabled={busy} onClick={() => {
          apply({ edit: { template: { format: template.format, source: templateDraft } } },
            '模板已保存到本会话（资源中心不受影响）')
        }} style={{
          ...buttonStyle,
          background: 'color-mix(in srgb, var(--dsw-alias-accent, #6ea8fe) 16%, transparent)',
        }}>保存模板到本会话</button>
      </div>}
      <iframe title="状态栏预览" sandbox="allow-scripts" srcDoc={previewDocument} style={{
        background: 'var(--dsw-alias-bg-base, #15161a)', border: '1px solid var(--dsw-alias-border-l2, #3d3d43)',
        borderRadius: '8px', colorScheme: 'dark', display: 'block', height: '240px', marginTop: '7px', width: '100%',
      }} />
    </div>

    {error !== undefined && <p role="alert" style={{
      color: 'var(--dsw-alias-state-danger, #e06470)', fontSize: '11px', margin: 0,
    }}>{error}</p>}
    {notice !== undefined && <p role="status" style={{ fontSize: '11px', margin: 0, opacity: .6 }}>{notice}</p>}
    {parsedValue.failure !== undefined && <p role="alert" style={{
      color: 'var(--dsw-alias-state-danger, #e06470)', fontSize: '11px', margin: 0,
    }}>{parsedValue.failure}</p>}

    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', justifyContent: 'flex-end' }}>
      <button type="button" disabled={busy || !contractDirty || budgetInvalid} onClick={() => {
        apply({
          edit: {
            name: name.trim(),
            rules,
            verificationMaxTokens: budgetValue ?? null,
          },
        }, '方案设定已保存到本会话（资源中心不受影响）')
      }} style={buttonStyle}>{busy ? '保存中…' : '保存方案设定'}</button>
      <button type="button" disabled={busy || !valueDirty} onClick={saveValue} style={{
        ...buttonStyle,
        background: 'color-mix(in srgb, var(--dsw-alias-accent, #6ea8fe) 16%, transparent)',
      }}>{busy ? '写入中…' : '写入当前值'}</button>
    </div>
  </section>
}
