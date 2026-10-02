/** Sending World Info before the chat history, for provider prefix reuse. */

import assert from 'node:assert/strict'
import test from 'node:test'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { resolveConfig } from '../src/config.ts'
import { parseCharacterCardJson } from '../src/import/character-card.ts'
import { createCharacterCardSessionSeed } from '../src/import/character-card-seed.ts'
import { createPresetSessionSeed } from '../src/import/session-preset.ts'
import type { ImportedSillyTavernPreset } from '../src/import/sillytavern-preset.ts'
import { injectAttributedPromptPlan } from '../src/preset-prompt.ts'
import {
  capturePromptPreview,
  promptPreviewBody,
  promptPreviewSummary,
} from '../src/prompt-preview.ts'
import {
  projectRoleplayTurnPlan,
  roleplayTurnPlanSha256,
} from '../src/roleplay-turn-settlement.ts'
import { prepareRoleplayTurn } from '../src/roleplay-turn-plan.ts'
import { resolveSessionRoleplayRuntime } from '../src/session-roleplay-runtime.ts'
import {
  placedWorldInfoEntries,
  residentFirstWorldInfo,
  normalizeWorldInfoPlacement,
} from '../src/world-info-placement.ts'

const deployment = resolveConfig({})

function attachment(id: string, name: string) {
  return {
    kind: 'file' as const,
    attachmentId: AttachmentId(`sha256:${id}`),
    bytes: 100,
    name,
    mediaType: 'application/json',
  }
}

const RESIDENT = '常驻：海城终年多雾。'
const TRIGGERED = '关键词：钟楼在午夜停摆。'

/**
 * A book whose keyword entry sorts *ahead* of its resident entry.
 *
 * Insertion order alone would emit the triggered entry first, so any test that
 * sees the resident entry first is seeing the placement reorder, not the
 * authored order leaking through.
 */
function cardFixture() {
  return parseCharacterCardJson(JSON.stringify({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: '白露',
      description: '钟表匠',
      personality: '沉静',
      scenario: '修理铺打烊前',
      first_mes: '门还没锁。',
      mes_example: '',
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: [],
      creator: 'fixture',
      character_version: '1',
      extensions: {},
      character_book: {
        name: '海城',
        recursive_scanning: false,
        extensions: {},
        entries: [
          {
            id: 1,
            keys: ['门'],
            secondary_keys: [],
            content: TRIGGERED,
            enabled: true,
            insertion_order: 1,
            constant: false,
            selective: false,
            position: 'before_char',
            name: '钟楼',
            use_regex: false,
            extensions: {},
          },
          {
            id: 2,
            keys: [],
            secondary_keys: [],
            content: RESIDENT,
            enabled: true,
            insertion_order: 2,
            constant: true,
            selective: false,
            position: 'before_char',
            name: '海雾',
            use_regex: false,
            extensions: {},
          },
        ],
      },
    },
  }))
}

function nativeSession(id: string): Session {
  const card = cardFixture()
  const seed = createCharacterCardSessionSeed(
    card, attachment(`${id}-card`, '白露.json'), 0, card.firstMessage, { transport: 'json' },
  )
  return Session.create(SessionId(id), seed)
}

/** A preset whose World Info marker is authored before the history marker. */
function presetFixture(): ImportedSillyTavernPreset {
  const prompts: ImportedSillyTavernPreset['prompts'] = [
    {
      identifier: 'stable', name: '稳定前缀', role: 'system', content: '稳定系统前缀',
      marker: false, systemPrompt: true, forbidOverrides: false,
    },
    {
      identifier: 'worldInfoBefore', name: '世界前', role: 'system', content: '',
      marker: true, systemPrompt: true, forbidOverrides: false,
    },
    {
      identifier: 'chatHistory', name: '历史', role: 'system', content: '',
      marker: true, systemPrompt: true, forbidOverrides: false,
    },
  ]
  return {
    format: 0,
    name: '位置预设',
    prompts,
    order: prompts.map(prompt => ({ identifier: prompt.identifier, enabled: true })),
    generation: {},
    formats: { worldInfo: '<info>\n{0}\n</info>', scenario: '{0}', personality: '{0}' },
    regexScripts: [],
    extensionSummary: { regexScriptCount: 0, hasSPreset: false, hasTavernHelper: false },
  }
}

function presetSession(id: string): Session {
  const card = cardFixture()
  let seed = createCharacterCardSessionSeed(
    card, attachment(`${id}-card`, '白露.json'), 0, card.firstMessage, { transport: 'json' },
  )
  seed = createPresetSessionSeed(seed, presetFixture(), attachment(`${id}-preset`, '位置预设.json'))
  return Session.create(SessionId(id), seed)
}

function plan(session: Session, placement?: 'before-history' | 'after-history') {
  const resolved = resolveSessionRoleplayRuntime({ session, deployment, memoryWriteAvailable: false })
  return prepareRoleplayTurn({
    session,
    deployment,
    resolved,
    ...(placement === undefined ? {} : { worldInfoPlacement: placement }),
  })
}

const texts = (prompts: readonly { readonly content: string }[]) => prompts.map(prompt => prompt.content)
const joined = (prompts: readonly { readonly content: string }[]) => texts(prompts).join('\n')

test('reads a stored placement, and treats anything else as the historical order', () => {
  assert.equal(normalizeWorldInfoPlacement('before-history'), 'before-history')
  assert.equal(normalizeWorldInfoPlacement('after-history'), 'after-history')
  for (const value of [undefined, null, '', 'BEFORE-HISTORY', 0, {}]) {
    assert.equal(normalizeWorldInfoPlacement(value), 'after-history', JSON.stringify(value ?? null))
  }
})

test('orders resident entries first while keeping each group authored order', () => {
  const entries = placedWorldInfoEntries(
    ['k1', 'r1', 'k2', 'r2'],
    [
      { kind: 'world-info', label: '关键词一' },
      { kind: 'world-info', label: '常驻一' },
      { kind: 'world-info', label: '关键词二' },
      { kind: 'world-info', label: '常驻二' },
    ],
    [false, true, false, true],
  )
  const ordered = residentFirstWorldInfo(entries)
  assert.deepEqual(ordered.map(entry => entry.content), ['r1', 'r2', 'k1', 'k2'])
  // The origin has to travel with the text, or the preview renames entries.
  assert.deepEqual(ordered.map(entry => entry.origin?.label), ['常驻一', '常驻二', '关键词一', '关键词二'])
})

test('leaves an all-resident or all-triggered run exactly as authored', () => {
  const all = (resident: boolean) => residentFirstWorldInfo(
    placedWorldInfoEntries(['a', 'b'], undefined, [resident, resident]),
  ).map(entry => entry.content)
  assert.deepEqual(all(true), ['a', 'b'])
  assert.deepEqual(all(false), ['a', 'b'])
})

test('entries without paired residency stay in authored order', () => {
  // A book whose pairing failed upstream reports no residency at all; reordering
  // on a guess would be worse than leaving the authored order alone.
  const entries = placedWorldInfoEntries(['a', 'b', 'c'], undefined, undefined)
  assert.deepEqual(entries.map(entry => entry.resident), [false, false, false])
  assert.deepEqual(residentFirstWorldInfo(entries).map(entry => entry.content), ['a', 'b', 'c'])
})

test('native mode keeps World Info after the history by default', () => {
  const after = plan(nativeSession('wi-placement-native-default'))

  assert.equal(after.prompt.worldInfoPlacement, 'after-history')
  assert.deepEqual(texts(after.prompt.beforeHistory), [])
  // Authored insertion order, which puts the triggered entry first.
  assert.deepEqual(texts(after.prompt.afterHistory), [TRIGGERED, RESIDENT])
})

test('native mode moves World Info ahead of the history, resident first', () => {
  const before = plan(nativeSession('wi-placement-native-before'), 'before-history')

  assert.equal(before.prompt.worldInfoPlacement, 'before-history')
  assert.deepEqual(texts(before.prompt.beforeHistory), [RESIDENT, TRIGGERED])
  assert.deepEqual(texts(before.prompt.afterHistory), [])
  // The character prompt is unaffected: World Info is never folded into it.
  assert.doesNotMatch(before.prompt.systemPromptText, /海城终年多雾/u)
  assert.doesNotMatch(before.prompt.systemPromptText, /钟楼在午夜停摆/u)
})

test('native mode carries each entry origin through the reorder', () => {
  const before = plan(nativeSession('wi-placement-native-origins'), 'before-history')
  assert.deepEqual(before.prompt.beforeHistory.map(prompt => prompt.origin?.label), ['海雾', '钟楼'])
  assert.deepEqual(
    before.prompt.beforeHistory.map(prompt => prompt.origin?.detail),
    ['海城 · 常驻', '海城 · 关键词 门'],
  )
})

test('preset mode defers a World Info marker past the history by default', () => {
  const after = plan(presetSession('wi-placement-preset-default'))

  assert.match(joined(after.prompt.afterHistory), /<info>/u)
  assert.doesNotMatch(joined(after.prompt.beforeHistory), /<info>/u)
  assert.doesNotMatch(after.prompt.systemPromptText, /<info>/u)
})

test('preset mode leaves the marker where the preset authored it', () => {
  const before = plan(presetSession('wi-placement-preset-before'), 'before-history')

  assert.match(joined(before.prompt.beforeHistory), /<info>/u)
  assert.doesNotMatch(joined(before.prompt.afterHistory), /<info>/u)
})

test('the World Info module never joins the provider system field', () => {
  const before = plan(presetSession('wi-placement-preset-system'), 'before-history')

  // The leading stable module still merges; the split has to stop at the World
  // Info module, which would otherwise be re-sent after the history on every
  // change and accumulate there.
  assert.match(before.prompt.systemPromptText, /稳定系统前缀/u)
  assert.doesNotMatch(before.prompt.systemPromptText, /<info>/u)
  assert.doesNotMatch(before.prompt.systemPromptText, /海城终年多雾/u)
  assert.equal(before.prompt.beforeHistory[0]?.ownMessage, true)
})

test('preset mode orders the joined module resident first and keeps its parts aligned', () => {
  const before = plan(presetSession('wi-placement-preset-parts'), 'before-history')
  const module = before.prompt.beforeHistory.find(prompt => prompt.content.includes('<info>'))
  assert.ok(module)

  assert.match(module.content, new RegExp(`${RESIDENT}[\\s\\S]*${TRIGGERED}`, 'u'))
  assert.deepEqual(module.origin?.parts?.map(part => part.label), ['海雾', '钟楼'])
})

test('the preview shows the moved World Info in the order actually sent', () => {
  const before = plan(presetSession('wi-placement-preview'), 'before-history')
  // The preview reads the dispatched array, so it only reports the new order if
  // the assembly really produced it — this is the end of the same path.
  const messages = injectAttributedPromptPlan([], before.prompt)
  capturePromptPreview({ sessionId: 'wi-placement-preview', messages, system: before.prompt.systemPromptText })

  const summary = promptPreviewSummary('wi-placement-preview')
  assert.ok(summary)
  const worldIndex = summary.messages.findIndex(message => message.kind === 'preset' && message.label === '世界前')
  const historyIndex = summary.messages.findIndex(message => message.role !== 'system')
  assert.notEqual(worldIndex, -1, 'the World Info module is attributed in the preview')
  assert.ok(historyIndex === -1 || worldIndex < historyIndex, 'it is listed before the conversation')

  // Opening the merged module splits it back into one row per entry, resident
  // first, matching the labels the reorder assigned.
  const body = promptPreviewBody('wi-placement-preview', worldIndex)
  assert.ok(body)
  assert.ok(body.text.indexOf(RESIDENT) < body.text.indexOf(TRIGGERED), 'resident entry comes first')
  assert.equal(body.parts?.length, 2)
  assert.match(String(body.parts?.[0]), /海城终年多雾/u)
  assert.match(String(body.parts?.[1]), /钟楼在午夜停摆/u)

  // The system field carries the stable prefix only.
  assert.doesNotMatch(String(promptPreviewBody('wi-placement-preview', -1)?.text), /海城终年多雾/u)
})

test('a plan recorded before the setting existed still verifies', () => {
  // Adding a field to `plan.prompt` changes that section's durable digest, so
  // every receipt written under schema 7 would stop replaying. Schema 7 keeps
  // projecting the plan without the field; only schema 8 includes it.
  const before = plan(nativeSession('wi-placement-schema'), 'before-history')
  const asSeven = projectRoleplayTurnPlan(before, 7) as { readonly prompt: Record<string, unknown> }
  const asEight = projectRoleplayTurnPlan(before, 8) as { readonly prompt: Record<string, unknown> }

  assert.equal('worldInfoPlacement' in asSeven.prompt, false)
  assert.equal(asEight.prompt.worldInfoPlacement, 'before-history')
  assert.notEqual(roleplayTurnPlanSha256(before, 7), roleplayTurnPlanSha256(before, 8))

  // A turn that ran at the historical order projects identically either way,
  // which is why existing Sessions keep verifying under their own schema.
  const after = plan(nativeSession('wi-placement-schema-default'))
  assert.equal((projectRoleplayTurnPlan(after, 8) as typeof asEight).prompt.worldInfoPlacement, 'after-history')
})
