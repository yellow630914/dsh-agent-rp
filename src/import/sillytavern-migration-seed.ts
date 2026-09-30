/** One-shot SillyTavern character and chat migration. */

import { SessionSeq, Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createCharacterCardSessionSeed } from './character-card-seed.ts'
import { createSillyTavernChatSeed, resolveSillyTavernChatIdentity } from './sillytavern-chat-seed.ts'
import type {
  CharacterCardAttachmentRef,
  CharacterImportTransport,
  FileAttachmentRef,
} from './session-character.ts'
import type { ImportedCharacterCard, ImportedSillyTavernChat } from './types.ts'

/**
 * Build one Session from a Character Card JSON and its SillyTavern chat export.
 * @param card - parsed Character Card identity.
 * @param cardAttachment - stored card JSON, PNG, or CHARX.
 * @param cardTransport - decoded card transport metadata.
 * @param chat - parsed SillyTavern chat history.
 * @param chatAttachment - stored chat JSONL.
 * @param libraryId - reusable card id used to resolve CHARX media.
 * @returns one validated seed with imported history and active card identity.
 */
export function createSillyTavernMigrationSeed(
  card: ImportedCharacterCard,
  cardAttachment: CharacterCardAttachmentRef,
  cardTransport: CharacterImportTransport,
  chat: ImportedSillyTavernChat,
  chatAttachment: FileAttachmentRef,
  libraryId?: string,
): readonly SessionEvent[] {
  const chatEvents = createSillyTavernChatSeed(chat, chatAttachment)
  const cardEvent = createCharacterCardSessionSeed(
    card,
    cardAttachment,
    0,
    '',
    cardTransport,
    resolveSillyTavernChatIdentity(chat).userName,
    undefined,
    libraryId,
  )[0]
  if (cardEvent?.type !== 'agent-rp/character-card-seed') throw new Error('Character Card seed is missing')
  // Identity first, transcript after.
  //
  // This used to append the card behind the imported chat, which reads fine
  // until something takes a prefix of the log: DSH's own "branch in a new
  // conversation" copies the events up to the message it forks at, so a fork
  // anywhere inside the transcript landed before the card and the child Session
  // came up with no character, no world books and no persona. Seeding identity
  // at the front makes every prefix carry it.
  const seq = SessionSeq(0)
  const events: SessionEvent[] = [{
    ...cardEvent,
    seq,
    time: Math.min(Date.now(), chatEvents[0]?.time ?? Date.now()),
    data: {
      ...cardEvent.data,
      meta: {
        ...cardEvent.data.meta,
        result: { ...cardEvent.data.meta.result, sourceEventSeq: seq },
      },
    },
  }]
  for (const event of chatEvents) {
    events.push({ ...event, seq: SessionSeq(events.length) } as SessionEvent)
  }
  const validated = Session.create(SessionId('agent-rp-sillytavern-migration-validation'), events)
  return Object.freeze(validated.snapshotEvents().slice(0, events.length))
}
