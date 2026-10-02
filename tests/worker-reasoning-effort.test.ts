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
  // Nothing to name: the LLM layer rejects *every* effort against such a model,
  // `off` included, so omitting is the only request it can accept.
  const accepted = acceptWorkerReasoningEffort(undefined, 'off')
  assert.deepEqual(accepted.config, {})
  assert.equal(accepted.reasoningOff, false, 'the model will think, so the budget must allow for it')
})

test('a model that reasons but cannot turn it off gets the least it accepts', () => {
  // The live case: Z.ai answers 400 `this model always engages in thinking and
  // cannot be disabled; please use low, high, or max` — and it answers that to
  // a request naming no effort just as readily as to one naming `off`.
  const accepted = acceptWorkerReasoningEffort(efforts('high', 'low', 'max'), 'off')
  assert.deepEqual(accepted.config, { reasoningEffort: 'low' }, 'declared display order must not pick the level')
  assert.equal(accepted.reasoningOff, false, 'it will think, so the budget must allow for it')
})

test('falls back down the ladder, never up', () => {
  // Raising the effort would spend a Worker's whole budget on reasoning and
  // return no answer, which surfaces as "no JSON object" rather than a refusal.
  assert.deepEqual(acceptWorkerReasoningEffort(efforts('medium', 'max'), 'off').config,
    { reasoningEffort: 'medium' })
  assert.deepEqual(acceptWorkerReasoningEffort(efforts('xhigh', 'minimal'), 'low').config,
    { reasoningEffort: 'minimal' })
})

test('an effort outside the known ladder keeps its declared order', () => {
  assert.deepEqual(acceptWorkerReasoningEffort(efforts('thorough', 'brief'), 'off').config,
    { reasoningEffort: 'thorough' }, 'unknown ids rank after known ones, in declared order')
  assert.deepEqual(acceptWorkerReasoningEffort(efforts('thorough', 'high'), 'off').config,
    { reasoningEffort: 'high' }, 'a known level still wins over an unknown one')
})

test('a stale persisted effort is replaced rather than sent', () => {
  // The verification pass carries whatever the player chose against an earlier
  // model; the route may since have moved to one that never accepts it.
  const accepted = acceptWorkerReasoningEffort(efforts('low', 'high'), 'minimal')
  assert.deepEqual(accepted.config, { reasoningEffort: 'low' })
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

test('"no preference" keeps omitting the field where the model declares off', () => {
  // DeepSeek declares `off`, so leaving the control on "model default" must go
  // on sending nothing and letting the provider decide, as it always has.
  const accepted = acceptWorkerReasoningEffort(efforts('off', 'low', 'high'), undefined)
  assert.deepEqual(accepted.config, {})
  assert.equal(accepted.reasoningOff, false)
})

test('"no preference" names the least level on a model that always thinks', () => {
  // Omitting is not neutral everywhere: an adapter may render an absent effort
  // as an explicit disable, which such a model refuses exactly as it refuses
  // `off`. This is the verification pass left on "model default" against Z.ai.
  const accepted = acceptWorkerReasoningEffort(efforts('high', 'low', 'max'), undefined)
  assert.deepEqual(accepted.config, { reasoningEffort: 'low' })
  assert.equal(accepted.reasoningOff, false)
})

test('"no preference" against a model with no controls still omits', () => {
  assert.deepEqual(acceptWorkerReasoningEffort(undefined, undefined).config, {})
})
