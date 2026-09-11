import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentRpProjection } from '../src/projection-types.ts'
import type { WorldInfoLibraryUpload } from '../src/world-info-library-protocol.ts'
import {
  activeWorldInfoLibraryIds,
  availableWorldInfoLibraryUploads,
} from '../src/client/world-info-library-selection.ts'

const id = (suffix: string): string => `world-info-${suffix.repeat(32)}`
const upload = (value: string, name: string): WorldInfoLibraryUpload => ({
  id: value,
  name,
  entryCount: 1,
  degradations: [],
  defaultForNewSessions: false,
})
const book = (value: string): AgentRpProjection['worldInfo']['books'][number] => ({
  id: value,
  name: value,
  source: value.startsWith('character:') ? 'character' : 'standalone',
  scanDepthModified: false,
  recursiveScanning: false,
  degradations: [],
  entries: [],
})

test('excludes retained worlds already active as character or standalone Session snapshots', () => {
  const character = id('a')
  const standalone = id('b')
  const available = id('c')
  const books = [
    book(`character:library:${character}`),
    book(`standalone:library:${standalone}`),
    book('character:attachment-legacy-card'),
  ]

  assert.deepEqual([...activeWorldInfoLibraryIds(books)], [character, standalone])
  assert.deepEqual(
    availableWorldInfoLibraryUploads([
      upload(character, '角色世界'),
      upload(standalone, '已有外部世界'),
      upload(available, '可添加世界'),
    ], books).map(entry => entry.id),
    [available],
  )
})
