/** No Worker may hard-code a reasoning effort the model was never asked about. */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const SOURCE_ROOT = fileURLToPath(new URL('../src/', import.meta.url))

function sourceFiles(root: string): readonly string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.tsx?$/u.test(entry.name) ? [path] : []
  })
}

test('an effort is never minted from a literal, only negotiated or player-chosen', () => {
  // `ReasoningEffortId('off')` reads as harmless, but the LLM layer rejects
  // every effort against a model that declares no reasoning — `off` included —
  // which fails the whole Worker turn. Efforts must come from a capability
  // check (`acceptWorkerReasoningEffort`) or from what the player saved.
  const offenders = sourceFiles(SOURCE_ROOT).flatMap(path => {
    const lines = readFileSync(path, 'utf8').split(/\r?\n/u)
    return lines.flatMap((line, index) => /ReasoningEffortId\(\s*['"`]/u.test(line)
      ? [`${relative(SOURCE_ROOT, path)}:${String(index + 1)}: ${line.trim()}`]
      : [])
  })
  assert.deepEqual(offenders, [], 'negotiate through negotiateWorkerReasoningEffort instead')
})
