import assert from 'node:assert/strict'
import test from 'node:test'
import { CommandId } from '@deepseek-ai/dsh-commands'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ImportedRegexScript } from '../src/import/types.ts'
import {
  activeRegexScripts,
  configuredRegexScripts,
  configureRegex,
  editableFromImported,
  encodeRegexConfiguration,
  parseRegexConfigurationRequest,
  readRegexConfiguration,
  type SessionRegexSource,
} from '../src/regex-configuration-core.ts'
import type { RegexConfigurationState } from '../src/regex-configuration-types.ts'

function script(partial: Partial<ImportedRegexScript> = {}): ImportedRegexScript {
  return {
    scriptName: '着色',
    findRegex: '/藤子/g',
    replaceString: '<b>$&</b>',
    trimStrings: [],
    placement: [2],
    disabled: false,
    markdownOnly: true,
    promptOnly: false,
    runOnEdit: false,
    substituteRegex: 0,
    minDepth: null,
    maxDepth: null,
    ...partial,
  }
}

const sources: readonly SessionRegexSource[] = [
  { owner: 'regex', scripts: [script({ scriptName: '包规则' })] },
  { owner: 'prompt-policy', scripts: [script({ scriptName: '预设规则' })] },
  { owner: 'actor', scripts: [script({ scriptName: '卡规则' }), script({ scriptName: '卡规则二' })] },
]

const initial: RegexConfigurationState = { format: 0, revision: 0, overrides: [], added: [] }

test('addresses every imported collection in one execution order', () => {
  const configured = configuredRegexScripts(sources, initial)
  assert.deepEqual(configured.map(entry => [entry.owner, entry.index]), [
    ['regex', 0], ['prompt-policy', 0], ['actor', 0], ['actor', 1],
  ])
  assert.deepEqual(configured.map(entry => entry.script.scriptName), ['包规则', '预设规则', '卡规则', '卡规则二'])
  assert.equal(configured.every(entry => !entry.modified && !entry.deleted), true)
})

test('a Session edits an imported rule without touching what it imported', () => {
  const edited = configureRegex(initial, parseRegexConfigurationRequest(JSON.stringify({
    operation: 'edit',
    revision: 0,
    owner: 'actor',
    index: 0,
    script: { ...editableFromImported(script()), scriptName: '卡规则（本会话）', findRegex: '/藤子|藤/g' },
  })), sources)

  const configured = configuredRegexScripts(sources, edited)
  const actor = configured.find(entry => entry.owner === 'actor' && entry.index === 0)!
  assert.equal(actor.script.findRegex, '/藤子|藤/g')
  assert.equal(actor.modified, true)
  assert.equal(sources[2]!.scripts[0]!.findRegex, '/藤子/g', 'the imported collection is untouched')
  assert.equal(edited.revision, 1)

  const restored = configureRegex(edited, {
    operation: 'reset-script', revision: 1, owner: 'actor', index: 0,
  }, sources)
  assert.deepEqual(restored.overrides, [])
  assert.equal(configuredRegexScripts(sources, restored)[2]?.script.findRegex, '/藤子/g')
})

test('toggling back to the imported value leaves no override behind', () => {
  const off = configureRegex(initial, {
    operation: 'toggle', revision: 0, owner: 'regex', index: 0, disabled: true,
  }, sources)
  assert.equal(off.overrides.length, 1)
  assert.equal(activeRegexScripts(sources, off)[0]?.disabled, true)

  const on = configureRegex(off, {
    operation: 'toggle', revision: 1, owner: 'regex', index: 0, disabled: false,
  }, sources)
  assert.deepEqual(on.overrides, [], 'a rule put back is indistinguishable from one never touched')
})

test('a deleted rule stays addressable but never executes', () => {
  const deleted = configureRegex(initial, {
    operation: 'delete', revision: 0, owner: 'prompt-policy', index: 0, deleted: true,
  }, sources)

  const entry = configuredRegexScripts(sources, deleted).find(item => item.owner === 'prompt-policy')!
  assert.equal(entry.deleted, true)
  assert.equal(entry.script.disabled, true, 'a consumer reading only the rule still skips it')
  assert.deepEqual(
    activeRegexScripts(sources, deleted).map(item => item.scriptName),
    ['包规则', '卡规则', '卡规则二'],
  )
})

test('Session-authored rules run last and are editable on their own index', () => {
  const own = { ...editableFromImported(script()), scriptName: '本会话新增', findRegex: '/雾/g' }
  const added = configureRegex(initial, parseRegexConfigurationRequest(JSON.stringify({
    operation: 'add', revision: 0, script: own,
  })), sources)
  assert.deepEqual(
    activeRegexScripts(sources, added).map(item => item.scriptName),
    ['包规则', '预设规则', '卡规则', '卡规则二', '本会话新增'],
  )

  const renamed = configureRegex(added, {
    operation: 'edit-added', revision: 1, index: 0, script: { ...own, scriptName: '改过的' },
  }, sources)
  assert.equal(activeRegexScripts(sources, renamed).at(-1)?.scriptName, '改过的')

  const removed = configureRegex(renamed, { operation: 'remove-added', revision: 2, index: 0 }, sources)
  assert.deepEqual(removed.added, [])
  assert.equal(activeRegexScripts(sources, removed).length, 4)
})

test('refuses stale revisions, unknown rules and unusable values', () => {
  assert.throws(() => configureRegex(initial, {
    operation: 'reset-all', revision: 9,
  }, sources), /已在别处改变/u)
  assert.throws(() => configureRegex(initial, {
    operation: 'toggle', revision: 0, owner: 'actor', index: 9, disabled: true,
  }, sources), /目标正则不存在/u)
  assert.throws(() => parseRegexConfigurationRequest(JSON.stringify({
    operation: 'edit', revision: 0, owner: 'actor', index: 0,
    script: { ...editableFromImported(script()), placement: [] },
  })), /至少要作用于一种消息/u)
  assert.throws(() => parseRegexConfigurationRequest(JSON.stringify({
    operation: 'edit', revision: 0, owner: 'actor', index: 0,
    script: { ...editableFromImported(script()), minDepth: 4, maxDepth: 1 },
  })), /深度上限不能小于下限/u)
  assert.throws(() => parseRegexConfigurationRequest(JSON.stringify({
    operation: 'edit', revision: 0, owner: 'nowhere', index: 0, script: editableFromImported(script()),
  })), /owner无效/u)
})

test('carries the overlay through a persisted Session snapshot', () => {
  const state = configureRegex(initial, {
    operation: 'toggle', revision: 0, owner: 'actor', index: 1, disabled: true,
  }, sources)
  const session = Session.create(SessionId('regex-overlay'))
  const commandId = CommandId('regex-1')
  session.append('command/run', { commandId, name: 'rp-regex', args: ' {}', source: { kind: 'user' } })
  session.append('command/done', { commandId, kind: 'success', text: encodeRegexConfiguration(state) })

  const replayed = readRegexConfiguration(session.snapshotEvents())
  assert.equal(replayed.revision, 1)
  assert.equal(activeRegexScripts(sources, replayed).at(-1)?.disabled, true)

  // Sessions that never opened the manager read as an empty overlay, and a
  // branch inherits whatever its parent had because this is a durable record.
  assert.deepEqual(readRegexConfiguration([]), initial)
})
