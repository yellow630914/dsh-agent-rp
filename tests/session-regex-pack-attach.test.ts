/** Taking a resource-center regex pack into a Session that is already running. */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { attachSessionRegexPack, readSessionRegexPacks } from '../src/session-regex-pack.ts'
import { readSessionRegexSourcesFromEvents } from '../src/regex-configuration.ts'
import { installIgnorableSessionEventFixture } from './session-event-fixture.ts'

installIgnorableSessionEventFixture()

const script = (name: string) => ({
  scriptName: name,
  findRegex: '/钟楼/g',
  replaceString: '旧钟楼',
  trimStrings: [] as string[],
  placement: [2],
  disabled: false,
  markdownOnly: true,
  promptOnly: false,
  runOnEdit: false,
  substituteRegex: 0,
  minDepth: null,
  maxDepth: null,
})

const pack = (id: string, name: string) => ({
  format: 0 as const,
  id,
  name,
  scripts: [script(`${name}-规则`)],
})

const PACK_A = `regex-${'a'.repeat(32)}`
const PACK_B = `regex-${'b'.repeat(32)}`

test('a running Session takes a library pack as an ordinary regex source', () => {
  const session = Session.create(SessionId('regex-pack-attach'))
  assert.deepEqual(readSessionRegexPacks(session.snapshotEvents()), [])

  const attached = attachSessionRegexPack(session, pack(PACK_A, '文风'))
  assert.equal(attached.id, PACK_A)
  assert.deepEqual(readSessionRegexPacks(session.snapshotEvents()).map(entry => entry.name), ['文风'])

  // It lands in the `regex` owner, which is what makes the manager render,
  // toggle and override it exactly like a pack chosen at launch.
  const sources = readSessionRegexSourcesFromEvents(session.snapshotEvents())
  assert.deepEqual(sources.find(source => source.owner === 'regex')?.scripts.map(entry => entry.scriptName),
    ['文风-规则'])
})

test('packs keep the order they were taken in', () => {
  const session = Session.create(SessionId('regex-pack-attach-order'))
  attachSessionRegexPack(session, pack(PACK_A, '文风'))
  attachSessionRegexPack(session, pack(PACK_B, '语料'))
  assert.deepEqual(readSessionRegexSourcesFromEvents(session.snapshotEvents())
    .find(source => source.owner === 'regex')?.scripts.map(entry => entry.scriptName),
  ['文风-规则', '语料-规则'])
})

test('the same pack cannot be taken twice', () => {
  const session = Session.create(SessionId('regex-pack-attach-duplicate'))
  attachSessionRegexPack(session, pack(PACK_A, '文风'))
  assert.throws(() => attachSessionRegexPack(session, pack(PACK_A, '文风')), /已经在本会话里了/u)
  assert.equal(readSessionRegexPacks(session.snapshotEvents()).length, 1)
})

test('a Host that cannot persist private events refuses rather than losing the Session', () => {
  // Without the ignorable-event seam the append would be an ordinary required
  // event, which makes the log unreadable on the next Host start.
  const session = Session.create(SessionId('regex-pack-attach-unsupported'))
  const unsupported = Object.create(Object.getPrototypeOf(session) as object) as Session
  Object.assign(unsupported, session)
  Object.defineProperty(unsupported, 'appendIgnorable', { value: undefined })
  assert.throws(() => attachSessionRegexPack(unsupported, pack(PACK_A, '文风')), /已拒绝写入/u)
})
