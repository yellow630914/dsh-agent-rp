import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseRoleplayStateTemplate,
  parseRoleplayStateTemplateValue,
  renderRoleplayStateTemplate,
} from '../src/roleplay-state-template.ts'
import { BASIC_ROLEPLAY_STATE_PANEL_TEMPLATE } from '../src/roleplay-state-scheme-ids.ts'

test('fills absolute JSON Pointers and formats every scalar kind', () => {
  const rendered = renderRoleplayStateTemplate({
    format: 'text',
    source: '{{/角色/体力}}|{{/角色/名字}}|{{/在场}}|{{/空值}}|{{/列表}}',
  }, { 角色: { 体力: 42, 名字: '林' }, 在场: true, 空值: null, 列表: [1, 2] })

  assert.equal(rendered, '42|林|true||[1,2]')
})

test('reads an unresolved pointer as absent instead of failing the panel', () => {
  const rendered = renderRoleplayStateTemplate({
    format: 'text',
    source: '[{{/不存在}}][{{/角色/不存在/更深}}][{{/列表/9}}]',
  }, { 角色: {}, 列表: [] })

  assert.equal(rendered, '[][][]')
})

test('iterates objects and arrays with the current key and item in scope', () => {
  const rendered = renderRoleplayStateTemplate({
    format: 'text',
    source: '{{#/组}}<{{@}}={{./值}}>{{/}}|{{#/数}}({{@}}:{{.}}){{/}}',
  }, { 组: { 甲: { 值: 1 }, 乙: { 值: 2 } }, 数: ['x', 'y'] })

  assert.equal(rendered, '<甲=1><乙=2>|(0:x)(1:y)')
})

test('renders conditional blocks by presence rather than by key existence', () => {
  const source = '{{?/有}}Y{{/}}{{!/有}}N{{/}}|{{?/空串}}Y{{/}}{{!/空串}}N{{/}}'
    + '|{{?/空表}}Y{{/}}{{!/空表}}N{{/}}|{{?/零}}Y{{/}}{{!/零}}N{{/}}'
  const rendered = renderRoleplayStateTemplate({ format: 'text', source }, {
    有: '值', 空串: '', 空表: [], 零: 0,
  })

  assert.equal(rendered, 'Y|N|N|N')
})

test('escapes substituted values only for the HTML format', () => {
  const state = { 名字: '<script>alert(1)</script>' }
  const html = renderRoleplayStateTemplate({ format: 'html', source: '<p>{{/名字}}</p>' }, state)
  const text = renderRoleplayStateTemplate({ format: 'text', source: '{{/名字}}' }, state)

  assert.equal(html, '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')
  assert.equal(text, '<script>alert(1)</script>')
})

test('is a pure function of the template and the state', () => {
  const template = { format: 'html' as const, source: BASIC_ROLEPLAY_STATE_PANEL_TEMPLATE }
  const state = { 场景: { 地点: '码头' }, 角色: { 状态: '疲惫' } }

  assert.equal(
    renderRoleplayStateTemplate(template, state),
    renderRoleplayStateTemplate(template, structuredClone(state)),
  )
})

test('rejects an unbalanced template before it can be stored', () => {
  assert.throws(() => parseRoleplayStateTemplate('{{#/组}}缺少结束'), /缺少结束标记/u)
  assert.throws(() => parseRoleplayStateTemplate('多余{{/}}'), /多余的结束标记/u)
  assert.throws(
    () => parseRoleplayStateTemplateValue({ format: 'html', source: '{{?/有}}' }, '状态栏模板'),
    /缺少结束标记/u,
  )
  assert.throws(
    () => parseRoleplayStateTemplateValue({ format: 'pdf', source: '' }, '状态栏模板'),
    /状态栏模板无效/u,
  )
})

test('renders the built-in template against the built-in two-level shape', () => {
  const rendered = renderRoleplayStateTemplate(
    { format: 'html', source: BASIC_ROLEPLAY_STATE_PANEL_TEMPLATE },
    { 场景: { 地点: '码头', 时间: '黄昏' }, 进度: { 回合: 3 } },
  )

  assert.match(rendered, /<h4>场景<\/h4>/u)
  assert.match(rendered, /<span class="k">地点<\/span><span class="v">码头<\/span>/u)
  assert.match(rendered, /<span class="k">回合<\/span><span class="v">3<\/span>/u)
})
