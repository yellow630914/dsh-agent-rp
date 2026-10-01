/** The reserved surface node 0 every seeded transcript has to carry. */

import { createSystemMessage } from '@deepseek-ai/dsh-llm'
import type { SystemMessage } from '@deepseek-ai/dsh-llm'

/**
 * The empty `system/message` that reserves surface node 0 for the Agent Loop.
 *
 * DSH 0.2.0 made the rendered system prompt a surface node, and its durable
 * format refuses a log whose first `system/message` is preceded by any other
 * surface event: "system/message requires a protected first surface head". The
 * live `Session` does not enforce this — only the format validator does, when
 * the log is read back. A seed that opens straight into an imported transcript
 * therefore accepts the Agent Loop's first system prompt happily, writes it,
 * and is unreadable from the next Host start onward.
 *
 * So every seed that puts surface events in a Session has to open with this: an
 * empty system node, inside an open step, ahead of the transcript. Empty is the
 * documented reservation — it projects to no message, so the imported history
 * reaches the model unchanged — and the loop's own projection recognizes the
 * head and rewrites it in place on the first live step.
 * @returns the empty system prompt message carried by that node.
 */
export function protectedSystemHeadMessage(): SystemMessage {
  return createSystemMessage('')
}
