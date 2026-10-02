/** What a background Worker may ask of one exact model's reasoning controls. */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId, type LlmModelReasoningInfo } from '@deepseek-ai/dsh-llm'
import {
  acceptWorkerReasoningEffort,
  negotiateWorkerReasoningEffort,
} from '../src/worker-reasoning-effort.ts'

const efforts = (...ids: readonly string[]): LlmModelReasoningInfo => ({
  efforts: ids.map(id => ({ id: ReasoningEffortId(id), name: id.toUpperCase() })),
})

test('sends the requested effort only when the model declares it', () => {
  const accepted = acceptWorkerReasoningEffort(efforts('off', 'low', 'high'), 'off')
  assert.deepEqual(accepted.config, { reasoningEffort: 'off' })
  assert.equal(accepted.reasoningOff, true)
})

test('a model that declares no reasoning at all gets no field', () => {
  // This is the GLM-through-pi-ai case: the LLM layer rejects *every* effort
  // against such a model, `off` included, so asking for it fails the turn.
  const accepted = acceptWorkerReasoningEffort(undefined, 'off')
  assert.deepEqual(accepted.config, {})
  assert.equal(accepted.reasoningOff, false, 'the model will think, so the budget must allow for it')
})

test('a model that reasons but cannot turn it off gets no field either', () => {
  const accepted = acceptWorkerReasoningEffort(efforts('low', 'medium', 'high'), 'off')
  assert.deepEqual(accepted.config, {})
  assert.equal(accepted.reasoningOff, false)
})

test('a stale persisted effort is dropped rather than sent', () => {
  // The verification pass carries whatever the player chose against an earlier
  // model; the route may since have moved to one that never accepts it.
  const accepted = acceptWorkerReasoningEffort(efforts('low', 'high'), 'minimal')
  assert.deepEqual(accepted.config, {})
  assert.equal(accepted.reasoningOff, false)
})

test('a supported effort that is not "off" still reserves reasoning budget', () => {
  const accepted = acceptWorkerReasoningEffort(efforts('low', 'high'), 'low')
  assert.deepEqual(accepted.config, { reasoningEffort: 'low' })
  assert.equal(accepted.reasoningOff, false)
})

function llmContext(resolve: () => Promise<{ readonly reasoning?: LlmModelReasoningInfo }>): Context {
  return { llm: { resolveModelInfo: resolve } } as unknown as Context
}

test('negotiates against the exact route the Worker dispatches to', async () => {
  const seen: string[] = []
  const ctx = {
    llm: {
      resolveModelInfo: async (provider: string, model: string) => {
        seen.push(`${provider}/${model}`)
        return { reasoning: efforts('off', 'high') }
      },
    },
  } as unknown as Context
  const negotiated = await negotiateWorkerReasoningEffort(ctx, { provider: 'zai', model: 'glm-5.3-flash' }, 'off')
  assert.deepEqual(seen, ['zai/glm-5.3-flash'])
  assert.deepEqual(negotiated.config, { reasoningEffort: 'off' })
})

test('an unreadable catalogue omits the field instead of failing the Worker', async () => {
  const ctx = llmContext(() => Promise.reject(new Error('catalogue unavailable')))
  const negotiated = await negotiateWorkerReasoningEffort(ctx, { provider: 'zai', model: 'glm-5.3-flash' }, 'off')
  assert.deepEqual(negotiated.config, {})
  assert.equal(negotiated.reasoningOff, false, 'the safe direction is to assume the model thinks')
})
