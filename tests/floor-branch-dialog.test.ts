import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { FloorBranchDialog, MemoryProposalList } from '../src/client/floor-branch-dialog.tsx'
import type { AgentRpMemoryCompletionResponse } from '../src/memory-completion-protocol.ts'
import type { AgentRpProjection } from '../src/projection-types.ts'

function floors(count: number, hidden = 0): AgentRpProjection['floors'] {
  return Array.from({ length: count }, (_, index) => ({
    seq: index + 10,
    role: index % 2 === 0 ? 'assistant' as const : 'user' as const,
    preview: `第 ${index} 层的内容`,
    hidden: index < hidden,
  }))
}

const handlers = {
  onComplete: async (): Promise<AgentRpMemoryCompletionResponse> => { throw new Error('not called while rendering') },
  onBranch: async (): Promise<void> => {},
  onClose: (): void => {},
}

test('opens ready to complete memory or branch, with no way to hide floors', () => {
  const markup = renderToStaticMarkup(createElement(FloorBranchDialog, { floors: floors(6), ...handlers }))

  assert.match(markup, /从第 <!-- -->0<!-- --> 层开始另开分支|从第 0 层开始另开分支/u)
  assert.match(markup, /data-agent-rp-action="branch-floors"/u)
  // A completion reads the whole transcript, so it does not wait for the
  // player to choose which floors the branch leaves behind.
  assert.doesNotMatch(markup, /<button[^>]*data-agent-rp-action="complete-memory"[^>]*disabled=""/u)
  assert.match(markup, /data-agent-rp-action="complete-memory"/u)
  // The one-way hide is gone from the panel altogether.
  assert.doesNotMatch(markup, /confirm-floors|不可还原|隐藏最前面/u)
})

test('counts floors an older build already hid apart from the ones a branch leaves', () => {
  const markup = renderToStaticMarkup(createElement(FloorBranchDialog, { floors: floors(6, 2), ...handlers }))

  // The slider cannot go below what is already out of the transcript.
  assert.match(markup, /type="range"[^>]*min="2"[^>]*max="5"/u)
  assert.match(markup, /另有 <!-- -->2<!-- --> 层此前已隐藏|另有 2 层此前已隐藏/u)
})

test('shows a proposal as additions and replacements the player can untick', () => {
  const proposal: AgentRpMemoryCompletionResponse = {
    format: 0,
    entries: [
      { kind: 'event', subject: '【第3天 清晨 ~ 第3天 傍晚】', text: '[清晨] 两人抵达王都东门。\n[傍晚] 白露答应带旅人去钟楼。' },
      {
        kind: 'event', subject: '【第2天 清晨 ~ 第2天 深夜】', text: '[清晨] 两人离开旅店。\n[深夜] 白露第一次叫了旅人的名字。',
        // Extending a day changes its title, so the entry names the one it replaces.
        replaces: { subject: '【第2天 清晨 ~ 第2天 午后】', kind: 'event', text: '[清晨] 两人离开旅店。' },
      },
    ],
    floorCount: 4,
    activeCount: 3,
    rejectedCount: 1,
    provider: 'fixture',
    model: 'fixture',
  }
  const markup = renderToStaticMarkup(createElement(MemoryProposalList, {
    proposal, excluded: new Set([1]), disabled: false, onToggle: () => {},
  }))

  assert.match(markup, /data-agent-rp-memory-proposal-entry="add"[\s\S]*【第3天 清晨 ~ 第3天 傍晚】[\s\S]*新增[\s\S]*\[傍晚\] 白露答应带旅人去钟楼。/u)
  assert.match(markup, /data-agent-rp-memory-proposal-entry="replace"[\s\S]*【第2天 清晨 ~ 第2天 深夜】[\s\S]*更新[\s\S]*原：[\s\S]*【第2天 清晨 ~ 第2天 午后】[\s\S]*\[清晨\] 两人离开旅店。/u)
  // The first entry is ticked, the excluded second one is not.
  assert.deepEqual(
    [...markup.matchAll(/<input type="checkbox"[^>]*>/gu)].map(match => match[0].includes('checked=""')),
    [true, false],
  )
  assert.match(markup, /那段时间没有记上/u)

  const empty = renderToStaticMarkup(createElement(MemoryProposalList, {
    proposal: { ...proposal, entries: [], rejectedCount: 0 }, excluded: new Set<number>(), disabled: false, onToggle: () => {},
  }))
  assert.match(empty, /没有需要补全的记忆/u)
})
