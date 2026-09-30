import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SlotCore,
  type PropsRenderSlots,
  type PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import {
  AGENT_RP_CLIENT_EXTENSION_API_VERSION,
  AGENT_RP_WORKBENCH_SECTION_SLOT,
  type AgentRpWorkbenchSectionProps,
} from '../src/client-extension-v0.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'test.agent-rp-workbench': { kind: 'single'; scope: 'root' }
  }
}

type TestWorkbenchProps = PropsRuntime<'test.agent-rp-workbench'>
  & PropsRenderSlots<typeof AGENT_RP_WORKBENCH_SECTION_SLOT>

test('lets an independent client plugin join and leave the Agent RP workbench lifecycle', () => {
  assert.equal(AGENT_RP_CLIENT_EXTENSION_API_VERSION, 0)
  const slots = new SlotCore()
  slots.register({
    name: 'root',
    children: { 'test.agent-rp-workbench': { kind: 'single', scope: 'root' } },
  } as never, (() => null) as never)
  let closeWorkbenchCalls = 0
  const closeWorkbench = (): void => { closeWorkbenchCalls += 1 }
  const disposeWorkbench = slots.register({
    name: 'test.agent-rp-workbench',
    children: { [AGENT_RP_WORKBENCH_SECTION_SLOT]: { kind: 'list', scope: 'root' } },
  }, ({ renderSlot }: TestWorkbenchProps) => renderSlot(
    AGENT_RP_WORKBENCH_SECTION_SLOT,
    { closeWorkbench },
  ))

  const ExternalWorldbookSection = (props: AgentRpWorkbenchSectionProps) => {
    props.closeWorkbench()
    return null
  }
  const disposeExternal = slots.register({
    name: AGENT_RP_WORKBENCH_SECTION_SLOT,
    id: 'community-worldbook',
    order: 10,
    label: '世界书',
  }, ExternalWorldbookSection)

  assert.deepEqual(slots.spec(AGENT_RP_WORKBENCH_SECTION_SLOT), { kind: 'list', scope: 'root' })
  assert.deepEqual(slots.snapshot('test.agent-rp-workbench')[0]?.children[0], {
    name: AGENT_RP_WORKBENCH_SECTION_SLOT,
    kind: 'list',
    scope: 'root',
    // DSH 0.2.0 discriminates snapshot nodes, so a slot names itself as one.
    type: 'slot',
    declaredBy: 'an entry in "test.agent-rp-workbench"',
    occupants: [{ id: 'community-worldbook', order: 10, priority: 0, active: true }],
    children: [],
  })
  ExternalWorldbookSection({ closeWorkbench } as AgentRpWorkbenchSectionProps)
  assert.equal(closeWorkbenchCalls, 1)

  disposeWorkbench()
  assert.equal(slots.spec(AGENT_RP_WORKBENCH_SECTION_SLOT), undefined)
  assert.deepEqual(slots.entriesOfSlot(AGENT_RP_WORKBENCH_SECTION_SLOT), [])
  disposeExternal()
})
