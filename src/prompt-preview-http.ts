/**
 * Read-only view of the last request one Session dispatched.
 *
 * Two shapes on one path: without `index` the response is a summary — every
 * message named by source, with sizes and leading snippets but no bodies — and
 * with `index` it is one row's full text. That split is the whole point: a
 * roleplay prompt routinely runs past a hundred thousand tokens, so a panel that
 * shipped every body on open would move megabytes to render a list.
 *
 * Nothing here reads or writes the Session log.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { jsonResponse as json, trustedBrowserRequest, type AgentRpHttpServer } from './host-http.ts'
import { PROMPT_PREVIEW_PATH } from './prompt-preview-protocol.ts'
import { promptPreviewBody, promptPreviewSummary } from './prompt-preview.ts'

/** Register the same-origin prompt-preview reader used by the session panel. */
export function installPromptPreviewHttp(
  ctx: Context,
  server: AgentRpHttpServer,
): void {
  ctx.effect(() => server.register({
    kind: 'exact',
    path: PROMPT_PREVIEW_PATH,
    handler(request, response) {
      if (!trustedBrowserRequest(request)) {
        json(response, 403, { error: 'forbidden' })
        return
      }
      if (request.method !== 'GET') {
        response.setHeader('allow', 'GET')
        json(response, 405, { error: 'method not allowed' })
        return
      }
      const url = new URL(request.url ?? '', 'http://localhost')
      const sessionId = url.searchParams.get('sessionId')
      if (sessionId === null || sessionId === '') {
        json(response, 400, { error: 'sessionId is required' })
        return
      }
      const rawIndex = url.searchParams.get('index')
      if (rawIndex !== null) {
        const index = Number(rawIndex)
        if (!Number.isSafeInteger(index)) {
          json(response, 400, { error: 'index must be an integer' })
          return
        }
        const body = promptPreviewBody(sessionId, index)
        if (body === undefined) {
          json(response, 404, { error: '这条内容已经不在缓存里，请重新发送一次消息' })
          return
        }
        json(response, 200, body)
        return
      }
      const summary = promptPreviewSummary(sessionId)
      json(response, 200, {
        format: 0,
        available: true,
        ...(summary === undefined ? {} : { summary }),
      })
    },
  }))
}
