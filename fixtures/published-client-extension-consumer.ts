// DSH 0.2.0 retired `@deepseek-ai/dsh-client-runtime`, whose `ClientContext`
// carried every client service at once. A client plugin's context is now the
// ordinary cordis one — what Agent RP's own client takes too — and each service
// it uses is declared by importing that service's own module augmentation.
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import {
  AGENT_RP_ST_EXTENSION_SERVICE,
  AGENT_RP_WORKBENCH_SECTION_SLOT,
  type AgentRpWorkbenchSectionProps,
} from '@hewzhew/dsh-agent-rp/client-extension/v0'

/** DSH client services required by the independent fixture plugin. */
export const inject = ['slots', AGENT_RP_ST_EXTENSION_SERVICE]

function CommunityWorldbookSection(props: AgentRpWorkbenchSectionProps) {
  void props.closeWorkbench
  return null
}

/** Register one external workbench section using only the published client contract. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.agentRpStExtensions.register({
    id: 'fixture.worldbook',
    displayName: 'External fixture',
    loadingOrder: 10,
    source: 'document.documentElement.dataset.fixtureExtension = "loaded"',
  }))
  ctx.slots.inject(AGENT_RP_WORKBENCH_SECTION_SLOT, () => ctx.slots.register({
    name: AGENT_RP_WORKBENCH_SECTION_SLOT,
    id: 'published-consumer-fixture',
    order: 10,
    label: 'External fixture',
  }, CommunityWorldbookSection))
}
