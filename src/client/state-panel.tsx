/** Collapsible native state panel docked above the composer. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { AgentRpProjection } from '../projection-types.ts'
import { BASIC_ROLEPLAY_STATE_PANEL_TEMPLATE } from '../roleplay-state-scheme-ids.ts'
import {
  renderRoleplayStateTemplate,
  type RoleplayStateTemplate,
} from '../roleplay-state-template.ts'
import { readSessionStateScheme } from './state-scheme-client.ts'

const DEFAULT_TEMPLATE: RoleplayStateTemplate = {
  format: 'html',
  source: BASIC_ROLEPLAY_STATE_PANEL_TEMPLATE,
}

/**
 * Turn one rendered template into the isolated document the panel frame shows.
 *
 * The template comes from the local library rather than a Character Card, so it
 * gets the strict shell: no network, no forms, no nested browsing contexts, and
 * only the measuring script this frame injects itself.
 * @param rendered - template output already filled with state values.
 * @param format - authoring format the output is in.
 * @param token - per-mount token the height message must carry.
 * @param nonce - per-mount nonce allowing only the measuring script.
 * @returns a complete sandboxed document.
 */
export function compileStatePanelDocument(
  rendered: string,
  format: RoleplayStateTemplate['format'],
  token: string,
  nonce: string,
): string {
  const body = format === 'markdown'
    ? String(marked.parse(rendered, { async: false }))
    : format === 'text'
      ? `<pre>${rendered.replace(/[&<>]/gu, character =>
        character === '&' ? '&amp;' : character === '<' ? '&lt;' : '&gt;')}</pre>`
      : rendered
  // The wrapper is load-bearing, not cosmetic. DOMPurify parses the input as a
  // document and returns only the body, so a `<style>` that starts the input is
  // hoisted into the head by the HTML parser and silently disappears — the
  // sanitizer never reports it as removed. Any element before it keeps the
  // parser in body context, so the CSS survives and still gets sanitized.
  // Verified against DOMPurify 3.3.0 in a browser.
  const sanitized = String(DOMPurify.sanitize(`<div data-agent-rp-state-root>${body}</div>`, {
    FORBID_TAGS: ['base', 'embed', 'form', 'iframe', 'meta', 'object', 'script'],
    FORBID_ATTR: ['srcdoc'],
  }))
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{background:transparent;color:inherit;color-scheme:dark;margin:0;max-width:100%;min-width:0;padding:0}body{box-sizing:border-box;overflow:auto}pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.55 ui-monospace,monospace}</style></head><body>${sanitized}<script nonce="${nonce}">(()=>{'use strict';const token=${JSON.stringify(token)};let queued=false;const report=()=>{queued=false;const root=document.documentElement,body=document.body;parent.postMessage({source:'dsh-agent-rp-state-panel',token,height:Math.max(root.scrollHeight,body.scrollHeight)},'*')};const queue=()=>{if(queued)return;queued=true;requestAnimationFrame(report)};addEventListener('load',queue);new MutationObserver(queue).observe(document.documentElement,{attributes:true,characterData:true,childList:true,subtree:true});if(window.ResizeObserver)new ResizeObserver(queue).observe(document.documentElement);queue()})()</script></body></html>`
}

function StatePanelFrame({ source, token, collapsed }: {
  readonly source: string
  readonly token: string
  readonly collapsed: boolean
}) {
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const [height, setHeight] = useState(72)
  useEffect(() => {
    const receive = (event: MessageEvent<unknown>): void => {
      if (event.source !== frameRef.current?.contentWindow
        || typeof event.data !== 'object' || event.data === null) return
      const message = event.data as { source?: unknown; token?: unknown; height?: unknown }
      if (message.source !== 'dsh-agent-rp-state-panel' || message.token !== token
        || typeof message.height !== 'number' || !Number.isFinite(message.height)) return
      // A collapsed frame is hidden, so its observers report a useless height.
      // Keeping the last expanded height avoids a jump on the next expand.
      if (collapsed) return
      setHeight(Math.max(48, Math.min(420, Math.ceil(message.height))))
    }
    window.addEventListener('message', receive)
    return () => { window.removeEventListener('message', receive) }
  }, [collapsed, token])
  return <iframe ref={frameRef} title="角色状态栏" sandbox="allow-scripts" srcDoc={source} style={{
    background: 'transparent', border: 0, colorScheme: 'dark', display: collapsed ? 'none' : 'block',
    height: `${height}px`, maxWidth: '100%', width: '100%',
  }} />
}

/** Actions the panel offers; re-rendering is local, re-settling writes to the Session. */
export interface RoleplayStatePanelActions {
  /** Recompute the current state from the latest reply without touching stored state. */
  readonly resettle?: () => Promise<void>
}

/**
 * Read the template the Host says this Session is running with.
 *
 * Resolution — Session copy, source entry, built-in — happens on the Host, so
 * the dock panel and the state dialog cannot disagree about which one wins.
 * A failed read keeps the built-in rather than blanking a panel whose state is
 * still perfectly valid.
 */
function useSchemeTemplate(sessionId: string, revision: number, reloadToken: number): {
  readonly template: RoleplayStateTemplate
  readonly error?: string
} {
  const [template, setTemplate] = useState<RoleplayStateTemplate>(DEFAULT_TEMPLATE)
  const [error, setError] = useState<string>()
  useEffect(() => {
    let cancelled = false
    void readSessionStateScheme(sessionId).then((entry) => {
      if (cancelled) return
      setTemplate(entry.template)
      setError(undefined)
    }, (reason: unknown) => {
      if (cancelled) return
      setTemplate(DEFAULT_TEMPLATE)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => { cancelled = true }
  }, [reloadToken, revision, sessionId])
  return error === undefined ? { template } : { template, error }
}

const actionButtonStyle = {
  background: 'transparent', border: '1px solid var(--dsw-alias-border-l2, #3d3d43)', borderRadius: '7px',
  color: 'inherit', cursor: 'pointer', flex: '0 0 auto', fontSize: '11px', padding: '3px 8px',
} as const

function SettlementTrail({ settlement }: {
  readonly settlement: NonNullable<AgentRpProjection['stateSettlement']>
}) {
  const label = settlement.outcome === 'applied' ? '已写入'
    : settlement.outcome === 'unchanged' ? '无变化'
      : settlement.outcome === 'skipped' ? '已跳过'
        : settlement.outcome === 'failed' ? '失败' : '进行中'
  const failed = settlement.outcome === 'failed'
  return <details style={{ fontSize: '11px' }}>
    <summary style={{ cursor: 'pointer', opacity: .66 }}>
      第 {String(settlement.turn)} 轮结算 · <span style={{
        color: failed ? 'var(--dsw-alias-state-danger, #e06470)' : 'inherit',
      }}>{label}</span>
    </summary>
    <div style={{ display: 'grid', gap: '6px', marginTop: '6px' }}>
      {settlement.stages.length === 0 && <span style={{ opacity: .5 }}>这一轮没有发出结算请求</span>}
      {settlement.stages.map((stage, index) => <div key={index} style={{
        border: '1px solid var(--dsw-alias-border-l2, #3d3d43)', borderRadius: '8px', padding: '6px 8px',
      }}>
        <div style={{ display: 'flex', gap: '7px' }}>
          <strong style={{ fontWeight: 600 }}>{stage.stage === 'proposal' ? '候选' : '核验'}</strong>
          <span style={{
            color: stage.outcome === 'failure' ? 'var(--dsw-alias-state-danger, #e06470)' : 'inherit',
            opacity: .74,
          }}>{stage.outcome === 'success' ? '成功' : '失败'}</span>
          {stage.operations !== undefined && <span style={{ marginLeft: 'auto', opacity: .5 }}>
            {String(stage.operations.length)} 项操作
          </span>}
        </div>
        {stage.error !== undefined && <p style={{
          color: 'var(--dsw-alias-state-danger, #e06470)', lineHeight: 1.5, margin: '4px 0 0',
        }}>{stage.error}</p>}
        {stage.operations !== undefined && stage.operations.length > 0 && <pre style={{
          lineHeight: 1.5, margin: '5px 0 0', maxHeight: '150px', opacity: .68, overflow: 'auto',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}>{JSON.stringify(stage.operations, undefined, 1)}</pre>}
      </div>)}
      {/* Only a verified calculation is ever written, so a failed verification
          means the state stayed exactly as it was. */}
      {failed && <span style={{ opacity: .55 }}>核验未通过，状态保持原值</span>}
    </div>
  </details>
}

/** Render the scheme's state through its authored template, collapsed or expanded. */
export function RoleplayStatePanel({ scheme, sessionId, settlement, collapsed, onToggle, actions }: {
  readonly scheme: NonNullable<AgentRpProjection['stateScheme']>
  readonly sessionId: string
  readonly settlement?: AgentRpProjection['stateSettlement']
  readonly collapsed: boolean
  readonly onToggle: (collapsed: boolean) => void
  readonly actions?: RoleplayStatePanelActions
}) {
  const [reloadToken, setReloadToken] = useState(0)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string>()
  const { template, error } = useSchemeTemplate(sessionId, scheme.revision, reloadToken)
  // Regenerated per reload so a stale frame's late height message is ignored.
  const token = useMemo(() => crypto.randomUUID(), [reloadToken])
  const nonce = useMemo(() => crypto.randomUUID().replaceAll('-', ''), [reloadToken])
  const rendered = useMemo(() => {
    try {
      return {
        source: renderRoleplayStateTemplate(template, scheme.value as JsonValue),
        failure: undefined as string | undefined,
      }
    } catch (reason: unknown) {
      return { source: '', failure: reason instanceof Error ? reason.message : String(reason) }
    }
  }, [scheme.value, template])
  const source = useMemo(
    () => compileStatePanelDocument(rendered.source, template.format, token, nonce),
    [nonce, rendered.source, template.format, token],
  )
  const resettle = actions?.resettle
  const runResettle = useCallback((): void => {
    if (resettle === undefined || busy) return
    setBusy(true)
    setActionError(undefined)
    void resettle().then(() => { setBusy(false) }, (reason: unknown) => {
      setBusy(false)
      setActionError(reason instanceof Error ? reason.message : String(reason))
    })
  }, [busy, resettle])
  const notice = rendered.failure ?? actionError ?? error
  return <section data-agent-rp-state-panel data-agent-rp-state-collapsed={collapsed} style={{
    background: 'var(--dsw-alias-bg-base, #15161a)', border: '1px solid var(--dsw-alias-border-l2, #363840)',
    borderRadius: '12px', boxShadow: '0 10px 32px rgba(0,0,0,.24)', display: 'grid', gap: '6px',
    minWidth: 0, padding: '8px', width: '100%',
  }}>
    <header style={{ alignItems: 'center', display: 'flex', gap: '8px', minWidth: 0 }}>
      <button type="button" aria-expanded={!collapsed} onClick={() => { onToggle(!collapsed) }} style={{
        alignItems: 'center', background: 'transparent', border: 0, color: 'inherit', cursor: 'pointer',
        display: 'flex', flex: '1 1 auto', gap: '7px', minWidth: 0, padding: '2px 0', textAlign: 'left',
      }}>
        <span aria-hidden="true" style={{
          display: 'inline-block', fontSize: '10px', opacity: .6,
          transform: collapsed ? 'rotate(-90deg)' : 'none', transition: 'transform .12s ease',
        }}>▼</span>
        <strong style={{
          fontSize: '12px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{scheme.name}</strong>
        <span style={{ flex: '0 0 auto', fontSize: '11px', opacity: .45 }}>#{scheme.revision}</span>
      </button>
      <button type="button" disabled={busy} onClick={() => { setReloadToken(value => value + 1) }}
        title="重新载入模板并重绘，不改变已保存的状态" style={actionButtonStyle}>重新渲染</button>
      {resettle !== undefined && <button type="button" disabled={busy} onClick={runResettle}
        title="按结算前的状态重新计算本轮变化" style={actionButtonStyle}>
        {busy ? '结算中…' : '重新结算'}
      </button>}
    </header>
    {notice !== undefined && !collapsed && <p role="status" style={{
      color: 'var(--dsw-alias-state-warning, #d6a955)', fontSize: '11px', lineHeight: 1.5, margin: 0,
    }}>{notice}</p>}
    <StatePanelFrame source={source} token={token} collapsed={collapsed} />
    {!collapsed && settlement !== undefined && <SettlementTrail settlement={settlement} />}
  </section>
}
