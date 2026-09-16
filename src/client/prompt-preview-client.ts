/** Browser-side reader for the last request a Session dispatched. */

import {
  PROMPT_PREVIEW_PATH,
  type PromptPreviewBodyResponse,
  type PromptPreviewResponse,
} from '../prompt-preview-protocol.ts'

/**
 * Read the summary: every message named by source, with sizes but no bodies.
 * @returns the capture, or a response whose `summary` is absent when this
 * Session has not dispatched a request since the Host started.
 */
export async function loadPromptPreview(sessionId: string): Promise<PromptPreviewResponse> {
  const query = new URLSearchParams({ sessionId })
  const response = await fetch(`${PROMPT_PREVIEW_PATH}?${query.toString()}`, {
    headers: { accept: 'application/json' },
  })
  const value = await response.json() as Partial<PromptPreviewResponse> & { readonly error?: string }
  if (!response.ok || value.format !== 0) {
    throw new Error(value.error ?? `提示词预览读取失败（${String(response.status)}）`)
  }
  return {
    format: 0,
    available: value.available === true,
    ...(value.summary === undefined ? {} : { summary: value.summary }),
  }
}

/** Read one opened row's full text; bodies are fetched one at a time on purpose. */
export async function loadPromptPreviewBody(
  sessionId: string,
  index: number,
): Promise<PromptPreviewBodyResponse> {
  const query = new URLSearchParams({ sessionId, index: String(index) })
  const response = await fetch(`${PROMPT_PREVIEW_PATH}?${query.toString()}`, {
    headers: { accept: 'application/json' },
  })
  const value = await response.json() as Partial<PromptPreviewBodyResponse> & { readonly error?: string }
  if (!response.ok || value.format !== 0 || typeof value.text !== 'string') {
    throw new Error(value.error ?? `提示词正文读取失败（${String(response.status)}）`)
  }
  return {
    format: 0,
    capturedAt: value.capturedAt ?? 0,
    index,
    text: value.text,
    ...(value.parts === undefined ? {} : { parts: value.parts }),
  }
}
