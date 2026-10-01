import assert from 'node:assert/strict'
import test from 'node:test'
import { CommandId } from '@deepseek-ai/dsh-commands'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { inspectLorebook } from '../src/import/lorebook.ts'
import { parseWorldInfoJson } from '../src/import/world-info.ts'
import {
  characterWorldInfoBookName,
  configureWorldInfo,
  configuredLorebook,
  editableWorldInfoEntry,
  encodeWorldInfoConfiguration,
  parseWorldInfoConfigurationRequest,
  readWorldInfoConfiguration,
  retainedWorldInfoSources,
  worldInfoTokenBudget,
  type SessionLorebookSource,
} from '../src/world-info-configuration-core.ts'

function source(): SessionLorebookSource {
  const worldInfo = parseWorldInfoJson(JSON.stringify({ name: '海城', entries: {
    1: { uid: 1, key: ['钟楼'], content: '钟楼午夜停摆。', order: 1, position: 1 },
    2: { uid: 2, key: [], content: '海城终年多雾。', constant: true, order: 2, position: 0 },
  } }))
  return { id: 'standalone:fixture', name: '海城', source: 'standalone', lorebook: worldInfo.lorebook, degradations: [] }
}

test('resolves only the primary character World Info identity', () => {
  const standalone = source()
  const character = { ...source(), id: 'character:fixture', name: '角色主书', source: 'character' as const }

  assert.equal(characterWorldInfoBookName([standalone, character], undefined), '角色主书')
  assert.equal(characterWorldInfoBookName([standalone], undefined), undefined)
  assert.equal(characterWorldInfoBookName([character, standalone], {
    worldbookBindings: { character: { primary: '改绑世界书', additional: ['角色主书'] } },
  }), '改绑世界书')
  assert.equal(characterWorldInfoBookName([character, standalone], {
    worldbookBindings: { character: { primary: null, additional: ['角色主书'] } },
  }), undefined)
})

test('persists a complete editable World Info overlay without mutating imported entries', () => {
  const book = source()
  const original = book.lorebook.entries[0]!
  const initial = { format: 0, revision: 0, overrides: [] } as const
  const edited = configureWorldInfo(initial, parseWorldInfoConfigurationRequest(JSON.stringify({
    operation: 'edit', revision: 0, bookId: book.id, entryIndex: 0,
    entry: { ...editableWorldInfoEntry(original), name: '旧钟楼', content: '钟楼只在雨夜停摆。', enabled: false },
  })), [book])
  const removed = configureWorldInfo(edited, {
    operation: 'delete', revision: 1, bookId: book.id, entryIndex: 1, deleted: true,
  }, [book])
  const session = Session.create(SessionId('world-info-configuration'))
  session.append('command/done', {
    commandId: CommandId('world-info-1'), kind: 'success', text: encodeWorldInfoConfiguration(removed),
  })

  const restored = readWorldInfoConfiguration(session.snapshotEvents())
  const configured = configuredLorebook(book, restored)
  assert.equal(configured.lorebook.entries[0]?.name, '旧钟楼')
  assert.equal(configured.lorebook.entries[0]?.content, '钟楼只在雨夜停摆。')
  assert.equal(configured.lorebook.entries[0]?.enabled, false)
  assert.equal(configured.lorebook.entries[1]?.enabled, false)
  assert.deepEqual([...configured.deleted], [1])
  assert.equal(original.content, '钟楼午夜停摆。')

  const reset = configureWorldInfo(restored, {
    operation: 'reset-all', revision: 2,
  }, [book])
  assert.deepEqual(configuredLorebook(book, reset).lorebook, book.lorebook)
})

test('keeps depth placement metadata through a session-local edit', () => {
  const worldInfo = parseWorldInfoJson(JSON.stringify({ name: '深度世界', entries: {
    1: {
      uid: 1, key: [], content: '插入最近一层历史。', constant: true,
      order: 88, position: 4, depth: 1, role: 2,
    },
  } }))
  const book: SessionLorebookSource = {
    id: 'standalone:depth', name: '深度世界', source: 'standalone',
    lorebook: worldInfo.lorebook, degradations: worldInfo.degradations,
  }
  const original = book.lorebook.entries[0]!
  const edited = configureWorldInfo({ format: 0, revision: 0, overrides: [] },
    parseWorldInfoConfigurationRequest(JSON.stringify({
      operation: 'edit', revision: 0, bookId: book.id, entryIndex: 0,
      entry: { ...editableWorldInfoEntry(original), content: '当前会话改写。' },
    })), [book])
  const configured = configuredLorebook(book, edited).lorebook.entries[0]

  assert.equal(configured?.position, 'at_depth')
  assert.equal(configured?.injectionDepth, 1)
  assert.equal(configured?.injectionRole, 'assistant')
  assert.equal(configured?.content, '当前会话改写。')
})

test('restoring an otherwise unchanged removed entry leaves no empty override', () => {
  const book = source()
  const removed = configureWorldInfo({ format: 0, revision: 0, overrides: [] }, {
    operation: 'delete', revision: 0, bookId: book.id, entryIndex: 0, deleted: true,
  }, [book])
  const restored = configureWorldInfo(removed, {
    operation: 'delete', revision: 1, bookId: book.id, entryIndex: 0, deleted: false,
  }, [book])

  assert.deepEqual(restored.overrides, [])
  assert.equal(restored.revision, 2)
})

test('normalizes empty overrides already persisted by an earlier build', () => {
  const session = Session.create(SessionId('world-info-empty-override'))
  session.append('command/done', {
    commandId: CommandId('world-info-empty'),
    kind: 'success',
    text: encodeWorldInfoConfiguration({
      format: 0,
      revision: 4,
      overrides: [{ bookId: 'standalone:fixture', entryIndex: 0, deleted: false }],
    }),
  })

  assert.deepEqual(readWorldInfoConfiguration(session.snapshotEvents()), { format: 0, revision: 4, overrides: [] })
})

test('persists a bounded Session-wide token budget without resetting entry overlays', () => {
  const book = source()
  const edited = configureWorldInfo({ format: 0, revision: 0, overrides: [] }, {
    operation: 'toggle', revision: 0, bookId: book.id, entryIndex: 0, enabled: false,
  }, [book])
  const budgeted = configureWorldInfo(edited, {
    operation: 'set-budget', revision: 1, tokenBudget: 2_048,
  }, [book])

  assert.equal(worldInfoTokenBudget(budgeted), 2_048)
  assert.equal(budgeted.overrides.length, 1)
  assert.throws(() => parseWorldInfoConfigurationRequest(JSON.stringify({
    operation: 'set-budget', revision: 2, tokenBudget: 100_001,
  })), /过大/u)
})

test('adds no aggregate World Info cap until the player explicitly selects one', () => {
  const initial = { format: 0, revision: 0, overrides: [] } as const
  assert.equal(worldInfoTokenBudget(initial), undefined)

  const bounded = configureWorldInfo(initial, {
    operation: 'set-budget', revision: 0, tokenBudget: 4_096,
  }, [])
  assert.equal(worldInfoTokenBudget(bounded), 4_096)

  const unbounded = configureWorldInfo(bounded, {
    operation: 'set-budget', revision: 1, tokenBudget: 0,
  }, [])
  assert.equal(worldInfoTokenBudget(unbounded), undefined)
  assert.equal(Object.hasOwn(unbounded, 'tokenBudget'), false)
})

test('changes one whole book atomically and restores its imported state', () => {
  const book = source()
  const edited = configureWorldInfo({ format: 0, revision: 0, overrides: [] }, {
    operation: 'edit', revision: 0, bookId: book.id, entryIndex: 0,
    entry: { ...editableWorldInfoEntry(book.lorebook.entries[0]!), content: '保留这次会话的钟楼改写。' },
  }, [book])
  const removed = configureWorldInfo(edited, {
    operation: 'delete', revision: 1, bookId: book.id, entryIndex: 1, deleted: true,
  }, [book])
  const disabled = configureWorldInfo(removed,
    parseWorldInfoConfigurationRequest(JSON.stringify({
      operation: 'set-book-enabled', revision: 2, bookId: book.id, enabled: false,
    })), [book])

  assert.equal(disabled.revision, 3)
  assert.deepEqual(configuredLorebook(book, disabled).lorebook.entries.map(entry => entry.enabled), [false, false])
  assert.equal(configuredLorebook(book, disabled).lorebook.entries[0]?.content, '保留这次会话的钟楼改写。')
  assert.deepEqual([...configuredLorebook(book, disabled).deleted], [1])

  const restored = configureWorldInfo(disabled, parseWorldInfoConfigurationRequest(JSON.stringify({
    operation: 'reset-book', revision: 3, bookId: book.id,
  })), [book])
  assert.equal(restored.revision, 4)
  assert.deepEqual(restored.overrides, [])
  assert.deepEqual(configuredLorebook(book, restored).lorebook.entries.map(entry => entry.enabled), [true, true])
})

test('a Session sets its own book-level scan depth without touching the imported file', () => {
  // The key only appears in the oldest message, so the depth is what decides
  // whether this entry activates at all.
  const messages = ['提到钟楼。', '随后闲聊。', '继续闲聊。']
  const deep = parseWorldInfoJson(JSON.stringify({ name: '海城', scan_depth: 3, entries: {
    1: { uid: 1, key: ['钟楼'], content: '钟楼午夜停摆。', order: 1, position: 1 },
  } }))
  const book: SessionLorebookSource = {
    id: 'standalone:depth', name: '海城', source: 'standalone', lorebook: deep.lorebook, degradations: [],
  }
  const active = (state: Parameters<typeof configuredLorebook>[1]): boolean =>
    inspectLorebook(configuredLorebook(book, state).lorebook, messages).entries[0]!.active

  const initial = { format: 0, revision: 0, overrides: [] } as const
  assert.equal(book.lorebook.scanDepth, 3)
  assert.equal(active(initial), true, 'the file\'s own depth reaches the oldest message')

  const shallow = configureWorldInfo(initial, parseWorldInfoConfigurationRequest(JSON.stringify({
    operation: 'set-book-scan-depth', revision: 0, bookId: book.id, scanDepth: 1,
  })), [book])
  assert.deepEqual(shallow.bookOverrides, [{ bookId: book.id, scanDepth: 1 }])
  assert.equal(configuredLorebook(book, shallow).lorebook.scanDepth, 1)
  assert.equal(active(shallow), false, 'the Session\'s shallower depth no longer reaches it')
  assert.equal(book.lorebook.scanDepth, 3, 'the imported book is untouched')

  // An omitted scanDepth is "this Session uses no book-level depth", which is a
  // different outcome from having no override at all.
  const none = configureWorldInfo(shallow, parseWorldInfoConfigurationRequest(JSON.stringify({
    operation: 'set-book-scan-depth', revision: 1, bookId: book.id,
  })), [book])
  assert.deepEqual(none.bookOverrides, [{ bookId: book.id }])
  assert.equal(configuredLorebook(book, none).lorebook.scanDepth, undefined)
  assert.equal(active(none), true, 'with no book depth the whole transcript is scanned')

  const restored = configureWorldInfo(none, parseWorldInfoConfigurationRequest(JSON.stringify({
    operation: 'reset-book-scan-depth', revision: 2, bookId: book.id,
  })), [book])
  assert.equal(restored.bookOverrides, undefined, 'the emptied list is dropped rather than kept as []')
  assert.equal(configuredLorebook(book, restored).lorebook.scanDepth, 3)
  assert.equal(restored.revision, 3)
})

test('restoring a book or the whole overlay also drops its scan depth', () => {
  const book = source()
  const withDepth = configureWorldInfo({ format: 0, revision: 0, overrides: [] }, {
    operation: 'set-book-scan-depth', revision: 0, bookId: book.id, scanDepth: 2,
  }, [book])
  const edited = configureWorldInfo(withDepth, {
    operation: 'edit', revision: 1, bookId: book.id, entryIndex: 0,
    entry: { ...editableWorldInfoEntry(book.lorebook.entries[0]!), content: '改写。' },
  }, [book])

  const perBook = configureWorldInfo(edited, { operation: 'reset-book', revision: 2, bookId: book.id }, [book])
  assert.equal(perBook.bookOverrides, undefined)
  assert.deepEqual(perBook.overrides, [])

  const everything = configureWorldInfo(edited, { operation: 'reset-all', revision: 2 }, [book])
  assert.equal(everything.bookOverrides, undefined)
  assert.deepEqual(everything.overrides, [])

  // The narrow reset is narrow: the entry overlay stays.
  const depthOnly = configureWorldInfo(edited, {
    operation: 'reset-book-scan-depth', revision: 2, bookId: book.id,
  }, [book])
  assert.equal(depthOnly.bookOverrides, undefined)
  assert.equal(configuredLorebook(book, depthOnly).lorebook.entries[0]?.content, '改写。')
})

test('refuses a book scan depth that is not a whole non-negative count', () => {
  const book = source()
  for (const scanDepth of [-1, 2.5, 20_000, 'deep']) {
    assert.throws(() => parseWorldInfoConfigurationRequest(JSON.stringify({
      operation: 'set-book-scan-depth', revision: 0, bookId: book.id, scanDepth,
    })), /scanDepth/u, JSON.stringify(scanDepth))
  }
  assert.throws(() => configureWorldInfo({ format: 0, revision: 0, overrides: [] }, {
    operation: 'set-book-scan-depth', revision: 0, bookId: 'standalone:missing', scanDepth: 1,
  }, [book]), /目标世界书不存在/u)
})

test('carries book scan depth through a persisted overlay snapshot', () => {
  const book = source()
  const state = configureWorldInfo({ format: 0, revision: 0, overrides: [] }, {
    operation: 'set-book-scan-depth', revision: 0, bookId: book.id, scanDepth: 4,
  }, [book])
  const session = Session.create(SessionId('world-info-book-depth'))
  const commandId = CommandId('world-info-1')
  session.append('command/run', { commandId, name: 'rp-world-info', args: ' {}', source: { kind: 'user' } })
  session.append('command/done', { commandId, kind: 'success', text: encodeWorldInfoConfiguration(state) })

  const replayed = readWorldInfoConfiguration(session.snapshotEvents())
  assert.deepEqual(replayed.bookOverrides, [{ bookId: book.id, scanDepth: 4 }])

  // Overlays written before book settings existed still load.
  const legacy = readWorldInfoConfiguration([{
    type: 'command/done', seq: 0, time: 0,
    data: { commandId, kind: 'success', text: encodeWorldInfoConfiguration({ format: 0, revision: 7, overrides: [] }) },
  } as never])
  assert.equal(legacy.bookOverrides, undefined)
  assert.equal(legacy.revision, 7)
})

test('removes one whole book from the Session and puts it back', () => {
  // A Session's books come from seed events and the log is append-only, so a
  // seed cannot be taken back. Removal is an overlay decision, like an entry's
  // `deleted`: the book stays in the manager so it can be restored, it just
  // stops reaching the prompt.
  const book = source()
  const other = { ...source(), id: 'standalone:other', name: '另一本' }
  const sources = [book, other]

  const removed = configureWorldInfo({ format: 0, revision: 0, overrides: [] },
    parseWorldInfoConfigurationRequest(JSON.stringify({
      operation: 'remove-book', revision: 0, bookId: book.id, removed: true,
    })), sources)
  assert.equal(removed.revision, 1)
  assert.deepEqual(removed.removedBooks, [book.id])
  assert.deepEqual(retainedWorldInfoSources(sources, removed).map(entry => entry.id), [other.id])
  // The manager still sees it; only the prompt side filters.
  assert.equal(configuredLorebook(book, removed).lorebook.entries.length, 2)

  const back = configureWorldInfo(removed, parseWorldInfoConfigurationRequest(JSON.stringify({
    operation: 'remove-book', revision: 1, bookId: book.id, removed: false,
  })), sources)
  assert.equal(back.revision, 2)
  // Restoring the last removal drops the key, so the overlay serializes the way
  // one that never removed anything does.
  assert.equal(Object.hasOwn(back, 'removedBooks'), false)
  assert.deepEqual(retainedWorldInfoSources(sources, back).map(entry => entry.id), [book.id, other.id])
})

test('a removal survives an encode round trip and is cleared by the restores that own it', () => {
  const book = source()
  const sources = [book]
  const removed = configureWorldInfo({ format: 0, revision: 0, overrides: [] },
    { operation: 'remove-book', revision: 0, bookId: book.id, removed: true }, sources)

  const session = Session.create(SessionId('world-info-remove-book'))
  session.append('command/run', {
    commandId: CommandId('cmd-remove-book'), name: 'rp-world-info', args: ' {}', source: { kind: 'user' },
  })
  session.append('command/done', {
    commandId: CommandId('cmd-remove-book'),
    kind: 'success',
    text: encodeWorldInfoConfiguration(removed),
  })
  assert.deepEqual(readWorldInfoConfiguration(session.snapshotEvents()).removedBooks, [book.id])

  // "Restore from file" covers the whole book, removal included.
  const reset = configureWorldInfo(removed, {
    operation: 'reset-book', revision: 1, bookId: book.id,
  }, sources)
  assert.equal(Object.hasOwn(reset, 'removedBooks'), false)

  // The narrower scan-depth restore leaves it alone.
  const depthOnly = configureWorldInfo(removed, {
    operation: 'reset-book-scan-depth', revision: 1, bookId: book.id,
  }, sources)
  assert.deepEqual(depthOnly.removedBooks, [book.id])

  const all = configureWorldInfo(removed, { operation: 'reset-all', revision: 1 }, sources)
  assert.equal(Object.hasOwn(all, 'removedBooks'), false)
})

test('refuses to remove a book this Session does not have', () => {
  assert.throws(() => configureWorldInfo({ format: 0, revision: 0, overrides: [] },
    { operation: 'remove-book', revision: 0, bookId: 'standalone:missing', removed: true }, [source()]),
  /目标世界书不存在/u)
  assert.throws(() => parseWorldInfoConfigurationRequest(JSON.stringify({
    operation: 'remove-book', revision: 0, bookId: 'standalone:fixture',
  })), /removed 必须是布尔值/u)
})
