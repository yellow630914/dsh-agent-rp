import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareRoleplayToolPolicy } from '../src/roleplay-tool-guidance.ts'
import { StateSchemeLibrary } from '../src/state-scheme-library.ts'
import { roleplayStateSchemeResourceProvider } from '../src/roleplay-state-scheme.ts'

function library(): { readonly store: StateSchemeLibrary; readonly dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'agent-rp-state-scheme-'))
  return { store: new StateSchemeLibrary({ root }), dispose: () => { rmSync(root, { recursive: true, force: true }) } }
}

const draft = {
  format: 0 as const,
  expectedRevision: 0,
  name: '航海状态',
  stateId: 'state:voyage',
  initial: { 船: { 耐久: 100 }, 天气: { 风向: '东南' } },
  rules: '只在正文写明损伤或天气变化时更新。',
  template: { format: 'html' as const, source: '<p>{{/船/耐久}}</p>' },
}

test('creates, reads back and revises one authored scheme under a revision check', () => {
  const { store, dispose } = library()
  try {
    const created = store.save(draft)
    assert.equal(created.revision, 1)
    assert.equal(created.stateId, 'state:voyage')
    assert.equal(created.fieldCount, 2)
    assert.deepEqual(store.get(created.id).initial, draft.initial)

    const revised = store.save({ ...draft, id: created.id, expectedRevision: 1, name: '航海状态 II' })
    assert.equal(revised.revision, 2)
    assert.equal(revised.name, '航海状态 II')

    assert.throws(
      () => store.save({ ...draft, id: created.id, expectedRevision: 1 }),
      /状态方案已经变化/u,
    )
  } finally {
    dispose()
  }
})

test('declines an invalid namespace, opening value or template before storing it', () => {
  const { store, dispose } = library()
  try {
    assert.throws(() => store.save({ ...draft, stateId: 'voyage' }), /state:xxx/u)
    assert.throws(() => store.save({ ...draft, initial: [1, 2] as never }), /必须是 JSON 对象/u)
    assert.throws(
      () => store.save({ ...draft, template: { format: 'html', source: '{{#/船}}' } }),
      /缺少结束标记/u,
    )
  } finally {
    dispose()
  }
})

test('publishes the built-in scheme beside every authored one, and freezes only the model-visible parts', () => {
  const { store, dispose } = library()
  try {
    const entry = store.save(draft)
    const provider = roleplayStateSchemeResourceProvider(store)
    const listed = provider.list()
    assert.deepEqual(listed.map(item => item.kind), ['state-scheme', 'state-scheme'])
    assert.ok(listed.some(item => item.name === '航海状态'))

    const reference = listed.find(item => item.name === '航海状态')!
    const materialized = provider.materialize!({
      selection: { kind: 'state-scheme', id: reference.id },
      descriptor: reference,
      events: [],
      context: { mode: 'character' },
    })
    const seed = materialized.events.at(-1)!
    assert.equal(seed.type, 'agent-rp/state-scheme-seed')
    // The template stays out of the Session so later edits still reach it.
    assert.deepEqual(
      Object.keys(seed.data as object).sort(),
      ['format', 'id', 'initial', 'name', 'rules', 'source', 'stateId'],
    )
    // The Session takes its own identity and records the library entry it copied.
    const seeded = seed.data as { readonly id: string; readonly source: string }
    assert.match(seeded.id, /^state-scheme:session:[0-9a-f]{32}$/u)
    assert.equal(seeded.source, reference.id)

    store.save({ ...draft, id: entry.id, expectedRevision: 1, template: { format: 'text', source: '{{/船/耐久}}' } })
    assert.equal(store.template(entry.id)?.format, 'text')
  } finally {
    dispose()
  }
})

test('maps the settlement cadence onto the contract and the automatic Worker', () => {
  const never = prepareRoleplayToolPolicy({ ...prepareRoleplayToolPolicy().source, stateMode: 'never' })
  const requested = prepareRoleplayToolPolicy({ ...prepareRoleplayToolPolicy().source, stateMode: 'requested' })
  const auto = prepareRoleplayToolPolicy({ ...prepareRoleplayToolPolicy().source, stateMode: 'auto' })

  assert.deepEqual(never.behavior.state, { mode: 'never', contractPrepared: false, settleAutomatically: false })
  // "Only on request" still prepares the contract, or a manual settlement
  // would have no baseline to recalculate from.
  assert.deepEqual(requested.behavior.state, { mode: 'requested', contractPrepared: true, settleAutomatically: false })
  assert.deepEqual(auto.behavior.state, { mode: 'auto', contractPrepared: true, settleAutomatically: true })
  assert.equal(prepareRoleplayToolPolicy().behavior.state.mode, 'auto')
})
