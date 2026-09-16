/** What the provider was sent, one row per source, bodies on demand. */

import { useEffect, useState } from 'react'
import type {
  PromptPreviewMessage,
  PromptPreviewPart,
  PromptPreviewSummary,
} from '../prompt-preview-protocol.ts'
import type { RoleplayPromptOriginKind } from '../prompt-origin.ts'
import { loadPromptPreview, loadPromptPreviewBody } from './prompt-preview-client.ts'

const KIND_LABELS: Readonly<Record<RoleplayPromptOriginKind, string>> = {
  preset: '预设',
  'world-info': '世界书',
  card: '角色卡',
  persona: '玩家人设',
  memory: '记忆',
  state: '状态',
  mvu: '变量',
  'tavern-helper': '脚本',
  history: '聊天记录',
  continuation: '续写',
}

const KIND_COLORS: Readonly<Record<RoleplayPromptOriginKind, string>> = {
  preset: '#7aa2f7',
  'world-info': '#9ece6a',
  card: '#e0af68',
  persona: '#bb9af7',
  memory: '#7dcfff',
  state: '#f7768e',
  mvu: '#f7768e',
  'tavern-helper': '#ff9e64',
  history: '#9aa5ce',
  continuation: '#c0caf5',
}

const ROLE_LABELS: Readonly<Record<PromptPreviewMessage['role'], string>> = {
  system: 'system',
  user: 'user',
  assistant: 'assistant',
}

function formatTokens(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value)
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

const bodyStyle = {
  background: 'var(--dsw-alias-bg-base, #131316)',
  border: '1px solid var(--dsw-alias-border-l2, #303036)',
  borderRadius: '8px',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '11px',
  lineHeight: 1.6,
  margin: '6px 0 0',
  maxHeight: '320px',
  overflow: 'auto',
  padding: '9px 10px',
  whiteSpace: 'pre-wrap' as const,
  wordBreak: 'break-word' as const,
}

/** One coloured source chip. */
function KindChip({ kind }: { readonly kind: RoleplayPromptOriginKind }) {
  return <span style={{
    background: `color-mix(in srgb, ${KIND_COLORS[kind]} 18%, transparent)`,
    borderRadius: '4px',
    color: KIND_COLORS[kind],
    flexShrink: 0,
    fontSize: '10px',
    padding: '1px 5px',
  }}>{KIND_LABELS[kind]}</span>
}

/** One merged contribution inside an opened row. */
function PartRow({ part, body }: {
  readonly part: PromptPreviewPart
  readonly body: string | undefined
}) {
  const [open, setOpen] = useState(false)
  return <div style={{ borderTop: '1px solid color-mix(in srgb, currentColor 9%, transparent)', padding: '6px 0' }}>
    <button type="button" onClick={() => { setOpen(value => !value) }} style={{
      background: 'transparent', border: 0, color: 'inherit', cursor: 'pointer', display: 'flex',
      font: 'inherit', gap: '7px', padding: 0, textAlign: 'left', width: '100%',
    }}>
      <span style={{ flexShrink: 0, opacity: .4, width: '10px' }}>{open ? '▾' : '▸'}</span>
      <KindChip kind={part.kind} />
      <span style={{ flex: 1, fontSize: '11px', minWidth: 0 }}>
        <span style={{ fontWeight: 500 }}>{part.label}</span>
        {part.detail === undefined ? null
          : <span style={{ opacity: .5 }}>{` · ${part.detail}`}</span>}
        <span style={{
          display: 'block', opacity: .45, overflow: 'hidden',
          textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{part.snippet}</span>
      </span>
      <span style={{ flexShrink: 0, fontSize: '10px', opacity: .5 }}>{formatTokens(part.approximateTokens)}</span>
    </button>
    {!open ? null : <pre style={bodyStyle}>{body ?? '（这一段的正文无法单独还原，请展开整条消息查看）'}</pre>}
  </div>
}

/** One provider message: summary line collapsed, body and parts when opened. */
function MessageRow({ message, sessionId }: {
  readonly message: PromptPreviewMessage
  readonly sessionId: string
}) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState<string>()
  const [parts, setParts] = useState<readonly string[]>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (!open || text !== undefined) return
    let cancelled = false
    void loadPromptPreviewBody(sessionId, message.index).then(body => {
      if (cancelled) return
      setText(body.text)
      setParts(body.parts)
    }, (reason: unknown) => {
      if (cancelled) return
      setError(reason instanceof Error ? reason.message : '正文读取失败')
    })
    return () => { cancelled = true }
  }, [open, sessionId, message.index])

  return <div data-agent-rp-prompt-row={String(message.index)} style={{
    borderBottom: '1px solid color-mix(in srgb, currentColor 10%, transparent)', padding: '8px 10px',
  }}>
    <button type="button" onClick={() => { setOpen(value => !value) }} style={{
      background: 'transparent', border: 0, color: 'inherit', cursor: 'pointer', display: 'flex',
      font: 'inherit', gap: '8px', padding: 0, textAlign: 'left', width: '100%',
    }}>
      <span style={{ flexShrink: 0, opacity: .4, width: '10px' }}>{open ? '▾' : '▸'}</span>
      <span style={{ flexShrink: 0, fontSize: '10px', opacity: .35, width: '26px' }}>{message.index + 1}</span>
      <KindChip kind={message.kind} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: '12px', fontWeight: 500 }}>{message.label}</span>
        <span style={{ fontSize: '10px', opacity: .4 }}>{` ${ROLE_LABELS[message.role]}`}</span>
        {message.detail === undefined ? null
          : <span style={{ fontSize: '10px', opacity: .5 }}>{` · ${message.detail}`}</span>}
        {message.parts === undefined ? null
          : <span style={{ fontSize: '10px', opacity: .5 }}>{` · ${String(message.parts.length)} 个来源`}</span>}
        <span style={{
          display: 'block', fontSize: '11px', opacity: .45, overflow: 'hidden',
          textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{message.snippet}</span>
      </span>
      <span style={{ flexShrink: 0, fontSize: '11px', opacity: .55 }}>
        {formatTokens(message.approximateTokens)}
      </span>
    </button>
    {!open ? null : <div style={{ paddingLeft: '20px' }}>
      {error !== undefined ? <p style={{ color: '#f7768e', fontSize: '11px' }}>{error}</p>
        : text === undefined ? <p style={{ fontSize: '11px', opacity: .5 }}>读取中…</p>
          : message.parts === undefined ? <pre style={bodyStyle}>{text}</pre>
            : <div style={{ marginTop: '4px' }}>
                {message.parts.map((part, index) =>
                  <PartRow key={`${part.label}:${String(index)}`} part={part} body={parts?.[index]} />)}
              </div>}
    </div>}
  </div>
}

/** Totals by source, so a bloated block is visible without opening anything. */
function KindTotals({ summary }: { readonly summary: PromptPreviewSummary }) {
  const totals = new Map<RoleplayPromptOriginKind, number>()
  for (const message of summary.messages) {
    // A merged message is counted through its parts so one `worldInfoBefore`
    // module does not file thirty World Info entries under "preset".
    const contributions = message.parts ?? [{ kind: message.kind, approximateTokens: message.approximateTokens }]
    for (const part of contributions) {
      totals.set(part.kind, (totals.get(part.kind) ?? 0) + part.approximateTokens)
    }
  }
  const rows = [...totals].sort((left, right) => right[1] - left[1])
  const max = rows[0]?.[1] ?? 1
  return <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
    {rows.map(([kind, tokens]) => <span key={kind} style={{
      alignItems: 'center', display: 'flex', fontSize: '10px', gap: '5px',
    }}>
      <KindChip kind={kind} />
      <span style={{ opacity: .6 }}>{formatTokens(tokens)}</span>
      <span style={{
        background: KIND_COLORS[kind], borderRadius: '2px', height: '3px', opacity: .5,
        width: `${String(Math.max(6, Math.round(46 * tokens / max)))}px`,
      }} />
    </span>)}
  </div>
}

/**
 * Show the exact request this Session last dispatched.
 *
 * The capture is taken at the provider seam, so this is the array that was sent
 * — not a re-derivation that could disagree with it. It lives in memory and is
 * replaced by each new request, so a Session that has not generated since the
 * Host started has nothing to show yet.
 */
export function PromptPreviewDialog({ sessionId, onClose }: {
  readonly sessionId: string
  readonly onClose: () => void
}) {
  const [summary, setSummary] = useState<PromptPreviewSummary>()
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string>()

  const refresh = (): void => {
    setLoaded(false)
    setError(undefined)
    void loadPromptPreview(sessionId).then(response => {
      setSummary(response.summary)
      setLoaded(true)
    }, (reason: unknown) => {
      setError(reason instanceof Error ? reason.message : '提示词预览读取失败')
      setLoaded(true)
    })
  }

  useEffect(refresh, [sessionId])

  return <div data-agent-rp-dialog data-agent-rp-prompt-preview role="dialog" aria-modal="true"
    aria-label="发送给模型的内容" style={{
      alignItems: 'center', background: 'rgba(0,0,0,.62)', display: 'flex', inset: 0,
      justifyContent: 'center', padding: '18px', position: 'fixed', zIndex: 1200,
    }} onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section style={{
      background: 'var(--dsw-alias-bg-base, #171719)', border: '1px solid var(--dsw-alias-border-l2, #3e3e43)',
      borderRadius: '14px', boxShadow: '0 18px 58px rgba(0,0,0,.44)', display: 'flex', flexDirection: 'column',
      maxHeight: 'min(760px, 88vh)', maxWidth: '900px', padding: '18px', width: '100%',
    }}>
      <header style={{ alignItems: 'start', display: 'flex', gap: '14px', justifyContent: 'space-between' }}>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ fontSize: '16px', margin: 0 }}>发送给模型的内容</h2>
          <p style={{ fontSize: '11px', lineHeight: 1.55, margin: '5px 0 0', opacity: .55 }}>
            这是最近一次请求实际送出的顺序与正文。点开任意一条查看原文；世界书按条目、聊天按消息分开列出。
          </p>
        </div>
        <div style={{ alignItems: 'center', display: 'flex', flexShrink: 0, gap: '8px' }}>
          <button type="button" style={buttonStyle} onClick={refresh}>刷新</button>
          <button type="button" onClick={onClose} style={{
            background: 'transparent', border: 0, color: 'inherit', cursor: 'pointer',
            font: 'inherit', fontSize: '18px', opacity: .6, padding: '0 3px',
          }} aria-label="关闭提示词预览">×</button>
        </div>
      </header>

      {error !== undefined ? <p style={{ color: '#f7768e', fontSize: '12px', marginTop: '16px' }}>{error}</p>
        : !loaded ? <p style={{ fontSize: '12px', marginTop: '16px', opacity: .55 }}>读取中…</p>
          : summary === undefined
            ? <p style={{ fontSize: '12px', lineHeight: 1.7, marginTop: '16px', opacity: .55 }}>
                这段会话还没有发送过请求，或者服务在那之后重启过。<br />
                发送一条消息后再打开，就能看到完整内容。
              </p>
            : <>
                <div style={{
                  alignItems: 'center', display: 'flex', flexWrap: 'wrap', fontSize: '11px', gap: '14px',
                  marginTop: '14px', opacity: .75,
                }}>
                  <span>共 {String(summary.totals.messages)} 条消息</span>
                  <span>约 {formatTokens(summary.totals.approximateTokens)} tokens</span>
                  {summary.model === undefined ? null : <span>{summary.model}</span>}
                  <span style={{ opacity: .6 }}>
                    {new Date(summary.capturedAt).toLocaleString()}
                  </span>
                </div>
                <div style={{ marginTop: '10px' }}><KindTotals summary={summary} /></div>
                <div style={{
                  border: '1px solid var(--dsw-alias-border-l2, #3b3b41)', borderRadius: '9px',
                  flex: 1, marginTop: '12px', minHeight: 0, overflowY: 'auto',
                }}>
                  <SystemRow summary={summary} sessionId={sessionId} />
                  {summary.messages.map(message =>
                    <MessageRow key={message.index} message={message} sessionId={sessionId} />)}
                </div>
              </>}
    </section>
  </div>
}

/** The provider's system field, which sits outside the message array. */
function SystemRow({ summary, sessionId }: {
  readonly summary: PromptPreviewSummary
  readonly sessionId: string
}) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState<string>()

  useEffect(() => {
    if (!open || text !== undefined) return
    let cancelled = false
    void loadPromptPreviewBody(sessionId, -1).then(body => { if (!cancelled) setText(body.text) }, () => {})
    return () => { cancelled = true }
  }, [open, sessionId])

  if (summary.system.chars === 0) return null
  return <div style={{
    borderBottom: '1px solid color-mix(in srgb, currentColor 10%, transparent)',
    padding: '8px 10px',
  }}>
    <button type="button" onClick={() => { setOpen(value => !value) }} style={{
      background: 'transparent', border: 0, color: 'inherit', cursor: 'pointer', display: 'flex',
      font: 'inherit', gap: '8px', padding: 0, textAlign: 'left', width: '100%',
    }}>
      <span style={{ flexShrink: 0, opacity: .4, width: '10px' }}>{open ? '▾' : '▸'}</span>
      <span style={{ flexShrink: 0, fontSize: '10px', opacity: .35, width: '26px' }}>sys</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: '12px', fontWeight: 500 }}>系统字段</span>
        <span style={{ fontSize: '10px', opacity: .5 }}>{' · 独立于消息数组，排在最前'}</span>
        <span style={{
          display: 'block', fontSize: '11px', opacity: .45, overflow: 'hidden',
          textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{summary.system.snippet}</span>
      </span>
      <span style={{ flexShrink: 0, fontSize: '11px', opacity: .55 }}>
        {formatTokens(summary.system.approximateTokens)}
      </span>
    </button>
    {!open ? null : <div style={{ paddingLeft: '20px' }}>
      <pre style={bodyStyle}>{text ?? '读取中…'}</pre>
    </div>}
  </div>
}
