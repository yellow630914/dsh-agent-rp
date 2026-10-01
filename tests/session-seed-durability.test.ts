/**
 * Every Agent RP seed has to survive DSH's own durable session format.
 *
 * The live `Session` accepts a `system/message` appended behind an existing
 * transcript; the format validator that reads the log back does not. A seed
 * that opens straight into imported history therefore runs one turn happily and
 * is unreadable from the next Host start onward — the failure these tests pin.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { KNOWN_SESSION_EVENT_TYPES, Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { restoreReleasedV4Artifact } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { createCharacterCardSessionSeed } from '../src/import/character-card-seed.ts'
import { parseCharacterCardJsonBytes } from '../src/import/character-card.ts'
import { parseSillyTavernChatBytes } from '../src/import/sillytavern-chat.ts'
import { createSillyTavernChatSeed } from '../src/import/sillytavern-chat-seed.ts'
import { createSillyTavernMigrationSeed } from '../src/import/sillytavern-migration-seed.ts'
import { prepareAgentRpBranchSession } from '../src/session-launch.ts'
import { substituteCardMacros } from '../src/prompt.ts'
import { installIgnorableSessionEventFixture } from './session-event-fixture.ts'

installIgnorableSessionEventFixture()

const cardAttachment = {
  kind: 'file' as const,
  attachmentId: AttachmentId('sha256:character-card-fixture'),
  bytes: 2_000,
  name: '白露.json',
  mediaType: 'application/json',
}
const chatAttachment = {
  kind: 'file' as const,
  attachmentId: AttachmentId('sha256:sillytavern-chat-fixture'),
  bytes: 1_000,
  name: '白露 - 2026-08-12.jsonl',
  mediaType: 'application/x-ndjson',
}

function card() {
  return parseCharacterCardJsonBytes(readFileSync('tests/fixtures/manual-character-card.json'))
}

function chat() {
  return parseSillyTavernChatBytes(readFileSync('tests/fixtures/manual-sillytavern-chat.jsonl'))
}

/**
 * Run the Agent Loop's first live step over one seed, exactly as it commits it:
 * the rendered system prompt reaches the surface first, rewriting the reserved
 * head in place, and the claimed inbox message is appended behind it.
 */
function afterOneLiveStep(seed: readonly SessionEvent[]): readonly SessionEvent[] {
  const session = Session.create(SessionId('agent-rp-seed-durability'), seed)
  const turn = session.snapshotEvents().filter(event => event.type === 'turn/start').length + 1
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  const head = session.surface.nodes[0]
  const reserved = head === undefined ? undefined : session.eventAt(head)
  session.append('system/message', { turn, step: 1, message: createSystemMessage('你是白露。') },
    reserved?.type === 'system/message'
      ? { surfaceOp: { op: 'replace', startSeq: reserved.seq, endSeq: reserved.seq }, sourceEventSeqs: [reserved.seq] }
      : { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '測試' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  return session.snapshotEvents()
}

/** Validate one complete log the way the persistence backend validates it on load. */
function assertDurable(events: readonly SessionEvent[]): void {
  restoreReleasedV4Artifact({
    header: {
      version: 4,
      id: 'agent-rp-seed-durability',
      createdAt: Date.now(),
      isSeeded: false,
      delegationDepth: 0,
    },
    events: events.map(event => ({ ...event })),
    inheritedEventCount: 0,
  } as never, KNOWN_SESSION_EVENT_TYPES)
}

test('a seeded greeting still reads back after the first live step', () => {
  const parsed = card()
  const greeting = substituteCardMacros(parsed.firstMessage, parsed, '小满')
  const seed = createCharacterCardSessionSeed(parsed, cardAttachment, 0, greeting, { transport: 'json' })
  assertDurable(afterOneLiveStep(seed))
})

test('an imported SillyTavern chat still reads back after the first live step', () => {
  assertDurable(afterOneLiveStep(createSillyTavernChatSeed(chat(), chatAttachment)))
})

test('a one-shot Character Card and chat migration still reads back after the first live step', () => {
  assertDurable(afterOneLiveStep(createSillyTavernMigrationSeed(
    card(), cardAttachment, { transport: 'json' }, chat(), chatAttachment,
  )))
})

test('a branched transcript still reads back after the first live step', () => {
  const parsed = card()
  const greeting = substituteCardMacros(parsed.firstMessage, parsed, '小满')
  const source = Session.create(SessionId('agent-rp-branch-source'),
    createCharacterCardSessionSeed(parsed, cardAttachment, 0, greeting, { transport: 'json' }))
  source.append('turn/start', { turn: 2 })
  source.append('step/start', { turn: 2, step: 1 })
  source.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '先去港口。' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  source.append('step/end', { turn: 2, step: 1 })
  source.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

  // Cut the greeting; the kept floor has to carry the reserved head itself.
  const { seed } = prepareAgentRpBranchSession(source, 1)
  assertDurable(afterOneLiveStep(seed))
})

test('refuses a transcript seeded without the reserved system head', () => {
  const seed = createSillyTavernChatSeed(chat(), chatAttachment)
    .filter(event => event.type !== 'system/message')
    .map((event, index) => ({ ...event, seq: index }) as SessionEvent)
  assert.throws(() => { assertDurable(afterOneLiveStep(seed)) },
    /system\/message requires a protected first surface head/u)
})
