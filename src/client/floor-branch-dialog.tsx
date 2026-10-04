/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** Floor panel: bring memory up to the latest floor, then branch from one floor. */

import React, { useEffect, useRef, useState } from 'react'
import type { AgentRpMemoryMergeEntry, AgentRpMemorySeedEntry } from '../memory.ts'
import {
  AGENT_RP_MEMORY_COMPLETION_INSTRUCTION_MAX_LENGTH,
  type AgentRpMemoryCompletionEntry,
  type AgentRpMemoryCompletionRequest,
  type AgentRpMemoryCompletionResponse,
} from '../memory-completion-protocol.ts'
import type { AgentRpProjection } from '../projection-types.ts'

/** What the player may send along with one memory-completion run. */
export type MemoryCompletionGuidance = Pick<AgentRpMemoryCompletionRequest, 'instruction' | 'previous'>

const accent = 'var(--dsw-alias-state-business-primary, #6f78e8)'

const buttonStyle = {
  background: 'transparent', border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
  borderRadius: '6px', color: 'inherit', cursor: 'pointer', font: 'inherit', fontSize: '12px',
  lineHeight: 1, minHeight: '30px', minWidth: '24px', padding: '4px 9px',
} as const

const primaryButtonStyle = {
  ...buttonStyle,
  background: `color-mix(in srgb, ${accent} 18%, transparent)`,
  borderColor: `color-mix(in srgb, ${accent} 48%, transparent)`,
} as const

const panelStyle = {
  background: 'var(--dsw-alias-bg-layer-1, #222226)', border: '1px solid var(--dsw-alias-border-l2, #3e3e43)',
} as const

function seedEntry(entry: AgentRpMemorySeedEntry): AgentRpMemorySeedEntry {
  return { kind: entry.kind, subject: entry.subject, text: entry.text }
}

/** What the branch carries for one accepted entry, naming the memory it stands in for. */
function mergeEntry(entry: AgentRpMemoryCompletionEntry): AgentRpMemoryMergeEntry {
  return { ...seedEntry(entry), ...(entry.replaces === undefined ? {} : { replaces: entry.replaces.subject }) }
}

/**
 * The proposal a completion returned, as a list the player ticks entries off.
 *
 * Purely presentational: which entries are excluded lives with the dialog, so
 * the same selection decides both what is shown dimmed and what the branch
 * carries.
 */
export function MemoryProposalList({ proposal, excluded, disabled, onToggle }: {
  readonly proposal: AgentRpMemoryCompletionResponse
  readonly excluded: ReadonlySet<number>
  readonly disabled: boolean
  readonly onToggle: (index: number, included: boolean) => void
}) {
  return <>
    <p style={{ fontSize: '12px', lineHeight: 1.6, margin: 0, opacity: .62 }}>
      读了全部 {proposal.floorCount} 层聊天记录，接着现有记忆提出 {proposal.entries.length} 条时间线条目。勾选的会写进新会话；
      现有的 {proposal.activeCount} 条记忆照常带过去。这段会话不会被改动。
      {proposal.rejectedCount > 0 && ` 另有 ${proposal.rejectedCount} 条因格式不合、过长或时间重复被略过，那段时间没有记上。`}
    </p>
    {proposal.entries.length === 0 && <p role="status" style={{ fontSize: '13px', margin: '6px 0', opacity: .58 }}>
      没有需要补全的记忆：聊天记录里的事件现有记忆已经记到最后一层了
    </p>}
    {proposal.entries.map((entry, index) => <label key={`${index}:${entry.subject}`}
      data-agent-rp-memory-proposal-entry={entry.replaces === undefined ? 'add' : 'replace'} style={{
        ...panelStyle, alignItems: 'start', borderRadius: '10px', cursor: 'pointer',
        display: 'flex', gap: '10px', opacity: excluded.has(index) ? .45 : 1, padding: '10px 12px',
      }}>
      <input type="checkbox" checked={!excluded.has(index)} disabled={disabled}
        onChange={(event) => { onToggle(index, event.target.checked) }} style={{ marginTop: '3px' }} />
      <span style={{ display: 'grid', flex: 1, gap: '4px', minWidth: 0 }}>
        <span style={{ alignItems: 'baseline', display: 'flex', flexWrap: 'wrap', fontSize: '12px', gap: '7px' }}>
          <strong style={{ fontWeight: 620 }}>{entry.subject}</strong>
          <span style={{
            background: `color-mix(in srgb, ${accent} 14%, transparent)`, borderRadius: '999px',
            fontSize: '10px', padding: '1px 7px',
          }}>{entry.replaces === undefined ? '新增' : '更新'}</span>
        </span>
        <span style={{ fontSize: '12px', lineHeight: 1.6, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{entry.text}</span>
        {entry.replaces !== undefined && <span style={{
          fontSize: '11px', lineHeight: 1.55, opacity: .5, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap',
        }}>原：{entry.replaces.subject === entry.subject ? '' : `${entry.replaces.subject}\n`}{entry.replaces.text}</span>}
      </span>
    </label>)}
  </>
}

/**
 * Bring memory up to the latest floor, and pick the floor a branch starts from.
 *
 * The two are independent. A completion reads every floor still in the
 * transcript and records whatever memory has not covered yet, so memory runs
 * ahead of the cut: whichever floor the branch starts from, the ones before it
 * are already recorded. The proposal is only a preview — nothing is written
 * until the branch is created with it, and a player who dislikes it can say why
 * and ask again.
 */
export function FloorBranchDialog({ floors, onComplete, onBranch, onClose }: {
  readonly floors: AgentRpProjection['floors']
  readonly onComplete: (
    guidance: MemoryCompletionGuidance,
    signal: AbortSignal,
  ) => Promise<AgentRpMemoryCompletionResponse>
  readonly onBranch: (fromVisibleFloor: number, memory?: readonly AgentRpMemoryMergeEntry[]) => Promise<void>
  readonly onClose: () => void
}) {
  // Floors an older build hid with a surface replace. They are already out of
  // the transcript, so a branch can neither keep nor re-read them.
  const committed = floors.filter(floor => floor.hidden).length
  const [start, setStart] = useState(committed)
  const [busy, setBusy] = useState<'complete' | 'branch'>()
  const [proposal, setProposal] = useState<AgentRpMemoryCompletionResponse>()
  const [excluded, setExcluded] = useState<ReadonlySet<number>>(new Set())
  const [instruction, setInstruction] = useState('')
  const [error, setError] = useState<string>()
  const completion = useRef<AbortController>()
  useEffect(() => () => { completion.current?.abort() }, [])
  // At least one floor has to come along for the character to answer.
  const maximum = Math.max(0, floors.length - 1)
  const target = Math.min(Math.max(start, committed), maximum)
  // The slider counts every floor, including the ones already hidden, but the
  // Host numbers only the floors still in the transcript.
  const fromVisibleFloor = target - committed
  const accepted = (proposal?.entries ?? []).filter((_, index) => !excluded.has(index))
  const added = accepted.filter(entry => entry.replaces === undefined).length
  const complete = (): void => {
    if (busy !== undefined) return
    const controller = new AbortController()
    completion.current = controller
    // Guidance refers to the proposal on screen ("drop the third one"), so the
    // whole of it goes back with the request. Without guidance there is nothing
    // to revise, and the run starts fresh.
    const guidance: MemoryCompletionGuidance = proposal === undefined || instruction.trim() === '' ? {} : {
      instruction: instruction.trim(),
      ...(proposal.entries.length === 0 ? {} : { previous: proposal.entries.map(seedEntry) }),
    }
    setBusy('complete')
    setError(undefined)
    void onComplete(guidance, controller.signal).then((value) => {
      setProposal(value)
      setExcluded(new Set())
    }, (reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '无法补全记忆')
    }).finally(() => {
      if (completion.current === controller) completion.current = undefined
      setBusy(undefined)
    })
  }
  const branch = (memory?: readonly AgentRpMemoryMergeEntry[]): void => {
    if (busy !== undefined) return
    setBusy('branch')
    setError(undefined)
    void onBranch(fromVisibleFloor, memory).then(onClose, (reason: unknown) => {
      setBusy(undefined)
      setError(reason instanceof Error ? reason.message : '无法创建分支')
    })
  }
  const idle = busy === undefined
  return <div data-agent-rp-dialog data-agent-rp-floor-panel role="dialog" aria-modal="true" aria-label="楼层" style={{
    alignItems: 'center', background: 'rgba(0,0,0,.62)', display: 'flex', inset: 0,
    justifyContent: 'center', padding: '18px', position: 'fixed', zIndex: 1200,
  }} onMouseDown={(event) => { if (event.target === event.currentTarget && idle) onClose() }}>
    <section style={{
      background: 'var(--dsw-alias-bg-base, #171719)', border: '1px solid var(--dsw-alias-border-l2, #3e3e43)',
      borderRadius: '14px', boxShadow: '0 18px 58px rgba(0,0,0,.42)', display: 'flex', flexDirection: 'column',
      maxHeight: 'min(720px, 86vh)', maxWidth: '640px', padding: '20px', width: '100%',
    }}>
      <header style={{ alignItems: 'start', display: 'flex', gap: '16px', justifyContent: 'space-between' }}>
        <div>
          <h2 style={{ fontSize: '17px', margin: 0 }}>楼层</h2>
          <p style={{ fontSize: '12px', lineHeight: 1.55, margin: '5px 0 0', opacity: .58 }}>
            选一层另开分支：它之前的楼层留在这段会话里，新会话从它开始。分支前可以先把还没记下的事件补全成记忆带过去
          </p>
        </div>
        <button type="button" disabled={!idle} onClick={onClose} style={{
          background: 'transparent', border: 0, color: 'inherit', cursor: idle ? 'pointer' : 'default',
          font: 'inherit', fontSize: '18px', opacity: .6, padding: '0 3px',
        }} aria-label="关闭楼层面板">×</button>
      </header>

      {floors.length === 0 && <p role="status" style={{ fontSize: '13px', margin: '22px 0 4px', opacity: .58 }}>
        这段会话还没有楼层
      </p>}

      {floors.length > 0 && <div style={{
        ...panelStyle, borderRadius: '11px', display: 'grid', gap: '10px', marginTop: '16px', padding: '13px',
      }}>
        <label htmlFor="agent-rp-floor-slider" style={{ fontSize: '12px', fontWeight: 620 }}>
          从第 {target} 层开始另开分支
        </label>
        <input id="agent-rp-floor-slider" data-agent-rp-floor-slider type="range"
          min={committed} max={maximum} step={1} value={target}
          disabled={!idle || maximum === committed}
          onChange={(event) => { setStart(Number(event.target.value)) }} style={{ width: '100%' }} />
        <div style={{ display: 'flex', fontSize: '11px', gap: '10px', justifyContent: 'space-between', opacity: .55 }}>
          <span>带过去 {floors.length - target} 层</span>
          <span>
            留在这段会话 {fromVisibleFloor} 层{committed === 0 ? '' : `（另有 ${committed} 层此前已隐藏）`}
          </span>
        </div>
      </div>}

      {floors.length > 0 && proposal === undefined && <div style={{
        display: 'grid', gap: '6px', marginTop: '14px', overflowY: 'auto',
      }}>
        {floors.map((floor, index) => {
          const left = index < target
          return <div key={floor.seq} data-agent-rp-floor={left ? 'left' : 'kept'} style={{
            alignItems: 'baseline', display: 'flex', fontSize: '12px', gap: '8px',
            opacity: left ? .42 : 1, padding: '4px 2px',
          }}>
            <span style={{ minWidth: '2.2em', opacity: .5, textAlign: 'right' }}>{index}</span>
            <span style={{ minWidth: '2.6em', opacity: .55 }}>{floor.role === 'user' ? '玩家' : '角色'}</span>
            <span style={{
              flex: 1, overflow: 'hidden', textDecoration: floor.hidden ? 'line-through' : 'none',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{floor.preview || '（空楼层）'}</span>
          </div>
        })}
      </div>}

      {proposal !== undefined && <div data-agent-rp-memory-proposal style={{
        display: 'grid', gap: '8px', marginTop: '14px', overflowY: 'auto',
      }}>
        <MemoryProposalList proposal={proposal} excluded={excluded} disabled={!idle} onToggle={(index, included) => {
          const next = new Set(excluded)
          if (included) next.delete(index)
          else next.add(index)
          setExcluded(next)
        }} />
        <label style={{ display: 'grid', fontSize: '12px', gap: '6px', marginTop: '4px' }}>
          <span style={{ opacity: .62 }}>不满意？写下要求再补全一次（可留空）</span>
          <textarea data-agent-rp-memory-instruction value={instruction} rows={2}
            maxLength={AGENT_RP_MEMORY_COMPLETION_INSTRUCTION_MAX_LENGTH} disabled={!idle}
            placeholder="例如：第 3 天的事件拆细一点；不要记战斗过程；把两人的约定写进去"
            onChange={(event) => { setInstruction(event.target.value) }} style={{
              ...panelStyle, borderRadius: '9px', color: 'inherit', font: 'inherit', fontSize: '12px',
              lineHeight: 1.5, padding: '8px 10px', resize: 'vertical',
            }} />
        </label>
      </div>}

      {busy === 'complete' && <p role="status" style={{ fontSize: '12px', lineHeight: 1.6, margin: '12px 0 0', opacity: .62 }}>
        正在读全部 {floors.length - committed} 层聊天记录并整理记忆，楼层多的时候要等一会儿…
      </p>}

      {error !== undefined && <p role="alert" style={{
        color: 'var(--dsw-alias-state-danger, #e06470)', fontSize: '12px', lineHeight: 1.5, margin: '12px 0 0',
      }}>{error}</p>}

      {floors.length > 0 && proposal === undefined && busy !== 'complete' && <p style={{
        fontSize: '12px', lineHeight: 1.6, margin: '14px 0 0', opacity: .62,
      }}>
        角色卡、人物、世界书、记忆、正则与状态数据都会跟到新会话，这段会话原样留着。分支的楼层会像导入聊天那样
        重新叙述，所以插图、标注与回复版本不会跟过去。
      </p>}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', justifyContent: 'flex-end', marginTop: '16px' }}>
        {busy === 'complete'
          ? <button type="button" data-agent-rp-action="cancel-memory-completion"
              onClick={() => { completion.current?.abort() }} style={buttonStyle}>取消补全</button>
          : <button type="button" disabled={!idle} onClick={() => {
              if (proposal === undefined) { onClose(); return }
              setProposal(undefined)
              setError(undefined)
            }} style={{ ...buttonStyle, opacity: idle ? 1 : .5 }}>{proposal === undefined ? '取消' : '返回'}</button>}
        {proposal === undefined && floors.length > 0 && <button type="button" data-agent-rp-action="branch-floors"
          disabled={!idle} onClick={() => { branch() }} style={{ ...buttonStyle, opacity: idle ? 1 : .5 }}>
          {busy === 'branch' ? '正在创建分支…' : '直接分支'}</button>}
        {proposal === undefined && floors.length > 0 && <button type="button" data-agent-rp-action="complete-memory"
          disabled={!idle} onClick={complete} style={{ ...primaryButtonStyle, opacity: idle ? 1 : .5 }}>
          {busy === 'complete' ? '正在补全…' : '补全记忆后分支'}</button>}
        {proposal !== undefined && <button type="button" data-agent-rp-action="recomplete-memory"
          disabled={!idle} onClick={complete} style={{ ...buttonStyle, opacity: idle ? 1 : .5 }}>
          {busy === 'complete' ? '正在补全…' : '重新补全'}</button>}
        {proposal !== undefined && <button type="button" data-agent-rp-action="branch-with-memory"
          disabled={!idle} onClick={() => { branch(accepted.map(mergeEntry)) }}
          style={{ ...primaryButtonStyle, opacity: idle ? 1 : .5 }}>
          {busy === 'branch'
            ? '正在创建分支…'
            : accepted.length === 0
              ? '创建分支（不带新记忆）'
              : `创建分支（新增 ${added} 条，更新 ${accepted.length - added} 条）`}</button>}
      </div>
    </section>
  </div>
}
