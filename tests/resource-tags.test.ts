/** Flat resource-center labels, and the libraries that have to carry them. */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { mergeResourceTags, parseResourceTags } from '../src/resource-tags.ts'
import { WorldInfoLibrary } from '../src/world-info-library.ts'
import { PersonaLibrary } from '../src/persona-library.ts'

function root(context: { after: (fn: () => void) => void }): string {
  const directory = mkdtempSync(join(tmpdir(), 'agent-rp-tags-'))
  context.after(() => { rmSync(directory, { force: true, recursive: true }) })
  return directory
}

const book = (name: string, content: string): Uint8Array => new TextEncoder().encode(JSON.stringify({
  name,
  entries: { 1: { uid: 1, key: ['钥匙'], content, order: 1, position: 1 } },
}))

test('normalizes labels into a comparable set', () => {
  // Order is the collation's business; what matters is that two equal sets come
  // out identical however they were typed, so a content-addressed library can
  // compare them without churning ids.
  const normalized = parseResourceTags(['  西幻 ', '西幻', '', '现代'], '分类')
  assert.deepEqual([...normalized].sort(), ['现代', '西幻'])
  assert.deepEqual(parseResourceTags(['现代', ' 西幻'], '分类'), normalized)
  assert.deepEqual(parseResourceTags(normalized, '分类'), normalized, 'normalization is idempotent')
  assert.deepEqual(parseResourceTags(undefined, '分类'), [])
  assert.deepEqual(parseResourceTags(null, '分类'), [])
  // Case is NOT folded: CJK has no case, and folding Latin would silently merge
  // labels the player deliberately kept apart.
  assert.equal(parseResourceTags(['NSFW', 'nsfw'], '分类').length, 2)
  assert.throws(() => parseResourceTags('西幻', '分类'), /必须是文本数组/u)
  assert.throws(() => parseResourceTags([1], '分类'), /必须是文本数组/u)
  assert.throws(() => parseResourceTags(['字'.repeat(25)], '分类'), /最多 24 个字/u)
  assert.throws(() => parseResourceTags(Array.from({ length: 13 }, (_v, i) => `t${String(i)}`), '分类'),
    /最多 12 个分类/u)
})

test('merges two label sets additively', () => {
  assert.deepEqual([...mergeResourceTags(['西幻'], ['现代', '西幻'])].sort(), ['现代', '西幻'])
  assert.deepEqual(mergeResourceTags([], []), [])
})

test('a world book keeps its labels when an edit mints a new id', context => {
  // Ids are the sha256 of the stored bytes, so every edit is a new identity.
  // Labels live in a sidecar beside the content and have to follow it across,
  // or editing a book silently drops it out of every category it was in.
  const library = new WorldInfoLibrary({ root: root(context) })
  const first = library.importFile({ data: book('海城', '旧钟楼午夜停摆。'), filename: '海城.json' })
  assert.deepEqual(first.tags, [])

  library.setTags(first.id, ['西幻', '  常用  '])
  assert.deepEqual([...(library.list()[0]?.tags ?? [])].sort(), ['常用', '西幻'])

  const edited = library.update(first.id, book('海城', '旧钟楼午夜停摆三分钟。'))
  assert.notEqual(edited.id, first.id, 'content-addressed id follows the content')
  assert.deepEqual([...edited.tags].sort(), ['常用', '西幻'])
  assert.deepEqual(library.list().map(entry => [...entry.tags].sort()), [['常用', '西幻']])

  // Clearing drops the sidecar rather than storing an empty array.
  library.setTags(edited.id, [])
  assert.deepEqual(library.list()[0]?.tags, [])
})

test('collapsing two world books into one keeps both label sets', context => {
  // The edit made two books byte-identical, so they are now one stored file.
  // Labels are additive, so neither side's choice is dropped — a single folder
  // would have had to pick a winner.
  const library = new WorldInfoLibrary({ root: root(context) })
  const left = library.importFile({ data: book('甲', '一样的内容。'), filename: '甲.json' })
  const right = library.importFile({ data: book('乙', '不一样的内容。'), filename: '乙.json' })
  library.setTags(left.id, ['西幻'])
  library.setTags(right.id, ['现代'])

  const merged = library.update(right.id, book('甲', '一样的内容。'))
  assert.equal(merged.id, left.id, 'the edit collapsed the two books into one')
  assert.deepEqual([...merged.tags].sort(), ['现代', '西幻'])
})

test('removing a world book takes its labels with it', context => {
  const directory = root(context)
  const library = new WorldInfoLibrary({ root: directory })
  const entry = library.importFile({ data: book('海城', '内容。'), filename: '海城.json' })
  library.setTags(entry.id, ['西幻'])
  library.remove(entry.id)
  assert.throws(() => readFileSync(join(directory, `${entry.id}.tags`), 'utf8'))
})

test('a Persona keeps its labels across an edit that does not mention them', context => {
  const library = new PersonaLibrary({ root: root(context) })
  const created = library.save({ format: 0, name: '小满', description: '旅人。', tags: ['主线'] })
  assert.deepEqual(created.tags, ['主线'])

  // Omitted labels keep what the entry had; an empty array clears them.
  const edited = library.save({ format: 0, id: created.id, name: '小满', description: '刚到海城的旅人。' })
  assert.deepEqual(edited.tags, ['主线'])
  assert.deepEqual(library.save({
    format: 0, id: created.id, name: '小满', description: '旅人。', tags: [],
  }).tags, [])
})

test('a hand-damaged label sidecar does not take the library down', context => {
  const directory = root(context)
  const library = new WorldInfoLibrary({ root: directory })
  const entry = library.importFile({ data: book('海城', '内容。'), filename: '海城.json' })
  writeFileSync(join(directory, `${entry.id}.tags`), '{ not json', 'utf8')
  assert.deepEqual(library.list()[0]?.tags, [], 'the book is still perfectly readable without its labels')
})
