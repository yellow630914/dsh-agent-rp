import assert from 'node:assert/strict'
import test from 'node:test'
import type { ImportedCharacterFrontend, ImportedRegexScript } from '../src/import/types.ts'
import {
  createRoleplayDisplayPlanner,
  ROLEPLAY_STATUS_PLACEHOLDER,
  type RoleplayDisplayMessage,
  type RoleplayDisplayProjection,
} from '../src/roleplay-display-plan.ts'

const messages: readonly RoleplayDisplayMessage[] = [
  { messageId: 0, seq: 10, role: 'user', text: '藤子', isHidden: false },
  { messageId: 1, seq: 20, role: 'assistant', text: '原回复', isHidden: false },
  { messageId: 2, seq: 21, role: 'assistant', text: '备选回复', isHidden: false },
]

const projection: RoleplayDisplayProjection = {
  characterName: '角色',
  userName: '用户',
  tavern: { messages },
  generations: [],
}

const frontend: ImportedCharacterFrontend = {
  regexScripts: [],
  tavernHelperScriptNames: [],
  tavernHelperScripts: [],
  tavernHelperVariables: {},
}

function displayScript(partial: Partial<ImportedRegexScript> = {}): ImportedRegexScript {
  return {
    scriptName: '着色',
    findRegex: '/藤子/g',
    replaceString: '<span style="color:#d9b36c">$&</span>',
    trimStrings: [],
    placement: [1],
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

test('leaves rows on the Host renderer when immersive display work is absent', () => {
  const planner = createRoleplayDisplayPlanner({ projection, frontend, immersive: true, overrides: new Map() })
  assert.deepEqual(planner.user({ seq: 10 }), { kind: 'host' })
  assert.deepEqual(planner.assistant({ finalSeq: 20, blockText: '原回复' }), { kind: 'host' })
})

test('plans user display regexes without reading a rendered DSH row', () => {
  const planner = createRoleplayDisplayPlanner({
    projection,
    frontend: { ...frontend, regexScripts: [displayScript()] },
    immersive: true,
    overrides: new Map(),
  })
  const plan = planner.user({ seq: 10 })
  assert.equal(plan.kind, 'render')
  if (plan.kind !== 'render') return
  assert.equal(plan.source, 'display-regex')
  assert.equal(plan.messageId, 0)
  assert.deepEqual(plan.compilation.segments, [{
    kind: 'inline-html', source: '<span style="color:#d9b36c">藤子</span>',
  }])
})

test('runs standalone global display rules before preset and character rules', () => {
  const planner = createRoleplayDisplayPlanner({
    projection: {
      ...projection,
      regexPacks: [{ scripts: [displayScript({ findRegex: '/藤子/g', replaceString: '全局' })] }],
      preset: { regexScripts: [displayScript({ findRegex: '/全局/g', replaceString: '预设' })] },
    },
    frontend: { ...frontend, regexScripts: [displayScript({ findRegex: '/预设/g', replaceString: '角色' })] },
    immersive: true,
    overrides: new Map(),
  })
  const plan = planner.user({ seq: 10 })
  assert.equal(plan.kind, 'render')
  if (plan.kind !== 'render') return
  assert.deepEqual(plan.compilation.segments, [{ kind: 'markdown', text: '角色' }])
})

test('runs standalone global display rules in a scene without a Character Card frontend', () => {
  const planner = createRoleplayDisplayPlanner({
    projection: {
      ...projection,
      regexPacks: [{ scripts: [displayScript({ placement: [1, 2] })] }],
    },
    immersive: true,
    overrides: new Map(),
  })
  const user = planner.user({ seq: 10 })
  const assistant = planner.assistant({ finalSeq: 20, blockText: '原回复', alignedMessage: {
    messageId: 3, seq: 20, role: 'assistant', text: '藤子', isHidden: false,
  } })
  assert.equal(user.kind, 'render')
  assert.equal(assistant.kind, 'render')
  if (user.kind !== 'render' || assistant.kind !== 'render') return
  assert.deepEqual(user.compilation.segments, [{
    kind: 'inline-html', source: '<span style="color:#d9b36c">藤子</span>',
  }])
  assert.deepEqual(assistant.compilation.segments, user.compilation.segments)
})

test('keeps display regexes inactive in debug view while honoring explicit script overrides', () => {
  const planner = createRoleplayDisplayPlanner({
    projection,
    frontend: { ...frontend, regexScripts: [displayScript()] },
    immersive: false,
    overrides: new Map([[0, '<!doctype html><html><body>脚本展示</body></html>']]),
  })
  const plan = planner.user({ seq: 10 })
  assert.equal(plan.kind, 'render')
  if (plan.kind !== 'render') return
  assert.equal(plan.source, 'override')
  assert.equal(plan.messageId, 0)
  assert.deepEqual(plan.compilation.segments, [{
    kind: 'html', source: '<!doctype html><html><body>脚本展示</body></html>',
  }])
})

test('selects one generation at the stable anchor and hides its superseded rows', () => {
  const withGeneration: RoleplayDisplayProjection = {
    ...projection,
    generations: [{
      anchorSeq: 20,
      selectedVersionSeq: 21,
      assistantSeqs: [20, 21],
      versions: [{ seq: 20, text: '原回复' }, { seq: 21, text: `备选${ROLEPLAY_STATUS_PLACEHOLDER}回复` }],
    }],
  }
  const planner = createRoleplayDisplayPlanner({
    projection: withGeneration, immersive: true, overrides: new Map(),
  })
  assert.deepEqual(planner.assistant({ finalSeq: 21, blockText: '备选回复' }), {
    kind: 'hidden', reason: 'unselected-generation',
  })
  const plan = planner.assistant({ finalSeq: 20, blockText: '原回复' })
  assert.equal(plan.kind, 'render')
  if (plan.kind !== 'render') return
  assert.equal(plan.source, 'selected-generation')
  assert.equal(plan.messageId, 2)
  assert.deepEqual(plan.compilation.segments, [{ kind: 'markdown', text: '备选回复' }])
})

test('uses an aligned imported message when its durable seq cannot identify the visible row', () => {
  const planner = createRoleplayDisplayPlanner({
    projection,
    frontend: { ...frontend, regexScripts: [displayScript({ placement: [2] })] },
    immersive: true,
    overrides: new Map(),
  })
  const aligned: RoleplayDisplayMessage = {
    messageId: 99, seq: 999, role: 'assistant', text: '藤子', isHidden: false,
  }
  const plan = planner.assistant({ blockText: 'Host 文本', alignedMessage: aligned })
  assert.equal(plan.kind, 'render')
  if (plan.kind !== 'render') return
  assert.equal(plan.messageId, 99)
  assert.deepEqual(plan.compilation.segments, [{
    kind: 'inline-html', source: '<span style="color:#d9b36c">藤子</span>',
  }])
})

function planText(plan: ReturnType<ReturnType<typeof createRoleplayDisplayPlanner>['user']>): string {
  if (plan.kind !== 'render') return ''
  return plan.compilation.segments.map(segment => segment.kind === 'markdown' ? segment.text : segment.source).join('')
}

test('renders a rewritten turn into the rows the transcript already showed', () => {
  // The Host transcript is built from append-origin events, so after an
  // in-place input rewrite it still carries the original message and the
  // discarded reply, plus the freshly generated one. The group anchors on
  // those original rows.
  const rewritten: RoleplayDisplayProjection = {
    ...projection,
    tavern: { messages: [{ messageId: 0, seq: 30, role: 'user', text: '我推开窗。', isHidden: false }] },
    generations: [{
      anchorSeq: 20,
      selectedVersionSeq: 21,
      assistantSeqs: [20, 21],
      versions: [{ seq: 21, text: '窗外正在下雨。' }],
      rewrittenInput: { seq: 10, text: '我推开窗。' },
    }],
  }
  const planner = createRoleplayDisplayPlanner({
    projection: rewritten, frontend, immersive: true, overrides: new Map(),
  })

  // The original player row shows the replacement, with no display rules and
  // even though seq 10 is no longer on the surface.
  const userPlan = planner.user({ seq: 10 })
  assert.equal(userPlan.kind, 'render')
  assert.equal(userPlan.kind === 'render' ? userPlan.source : '', 'rewritten-input')
  assert.match(planText(userPlan), /我推开窗。/u)
  // No messageId: the DOM adapter gates rendering on card-frame retention.
  assert.equal(userPlan.kind === 'render' ? userPlan.messageId : 'unset', undefined)

  // The discarded reply's row renders the new reply …
  const anchorPlan = planner.assistant({ finalSeq: 20, blockText: '门后是一条走廊。' })
  assert.equal(anchorPlan.kind, 'render')
  assert.match(planText(anchorPlan), /窗外正在下雨。/u)
  // … and the freshly appended reply row is hidden, so the turn reads as one exchange.
  assert.deepEqual(planner.assistant({ finalSeq: 21, blockText: '窗外正在下雨。' }), {
    kind: 'hidden', reason: 'unselected-generation',
  })

  // Rows outside the rewritten turn are untouched.
  assert.deepEqual(planner.user({ seq: 999 }), { kind: 'host' })
})

test('renders a superseded reply on the row that replaced it', () => {
  // DSH 0.1.3 bars an Assistant message from replacing surface nodes, so a
  // regenerated reply is appended (seq 22) and the row it replaced (seq 20)
  // stays in the transcript. The switcher and the rendered text belong to the
  // replacement row; the superseded rows disappear.
  // 20 is the original reply, 21 the regenerated one, 22 the blanking message
  // Agent RP appended over 20, and 23 the live replacement carrying the choice.
  const withReplacement: RoleplayDisplayProjection = {
    ...projection,
    surfaceAnchors: { 22: 20, 23: 20 },
    supersededSeqs: [20, 21, 22],
    generations: [{
      anchorSeq: 20,
      selectedVersionSeq: 21,
      assistantSeqs: [20, 21],
      versions: [{ seq: 20, text: '原回复' }, { seq: 21, text: '备选回复' }],
    }],
  }
  const planner = createRoleplayDisplayPlanner({
    projection: withReplacement, immersive: true, overrides: new Map(),
  })
  // The node Agent RP blanked ends on its own replacement, so it disappears.
  assert.deepEqual(planner.assistant({ finalSeq: 22, blockText: '' }), {
    kind: 'hidden', reason: 'superseded-reply',
  })
  // A shadowed model reply is not an Agent RP replacement: the unselected rule
  // decides it, so it stays hidden without the planner erasing the only row
  // that carries the turn's text.
  assert.deepEqual(planner.assistant({ finalSeq: 21, blockText: '备选回复' }), {
    kind: 'hidden', reason: 'unselected-generation',
  })
  const plan = planner.assistant({ finalSeq: 23, blockText: '备选回复' })
  assert.equal(plan.kind, 'render')
  if (plan.kind !== 'render') return
  assert.equal(plan.source, 'selected-generation')
  assert.deepEqual(plan.compilation.segments, [{ kind: 'markdown', text: '备选回复' }])
})

test('hides a superseded player row so its rewrite is not shown twice', () => {
  const withReplacement: RoleplayDisplayProjection = {
    ...projection,
    surfaceAnchors: { 30: 29, 31: 29 },
    supersededSeqs: [29, 30],
    generations: [],
  }
  const planner = createRoleplayDisplayPlanner({
    projection: withReplacement, immersive: true, overrides: new Map(),
  })
  assert.deepEqual(planner.user({ seq: 30 }), { kind: 'hidden', reason: 'superseded-reply' })
  assert.deepEqual(planner.user({ seq: 31 }), { kind: 'host' })
})
