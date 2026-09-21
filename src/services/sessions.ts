import type { Application, InboundMessage } from '../contracts.js';
import type { Session } from '../database/db.js';

/**
 * Pipeline supplies the persisted session greeting checkpoint alongside the
 * application. Application itself does not contain greeting_sent. With no
 * checkpoint, fail closed (do not guess that the greeting has not been sent).
 */
export type ConversationApplication = Application & {
  greeting_sent?: boolean;
  media_id?: string | null;
};
export type InboundClassification = 'greeting' | 'details' | 'unsolicited';

/**
 * Pure routing only: recordInbound already saved text and bumped revision.
 * The pipeline owns sending greeting() and persisting its greeting checkpoint.
 * No dedicated unsolicited-ack template exists, so unsolicited may be ignored.
 */
export function classifyInbound(
  application: ConversationApplication,
  msg: InboundMessage,
): InboundClassification {
  if (msg.type !== 'text') return 'unsolicited';
  if (application.status === 'WAITING_FOR_DETAILS') return 'details';
  if (application.media_id || application.cv_local_path) return 'unsolicited';
  if (application.status === 'RECEIVED' && application.greeting_sent === false) return 'greeting';
  return 'unsolicited';
}

/** Admin/greeting decisions only; recordInbound remains authoritative for grouping. */
export function sessionExpired(
  session: Session | null,
  now: number | Date,
  timeoutMinutes: number,
): boolean {
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes < 0) throw new Error('Invalid session timeout');
  if (!session) return true;
  const at = typeof now === 'number' ? now : now.getTime();
  const last = Date.parse(session.updated_at);
  if (!Number.isFinite(at) || !Number.isFinite(last)) return false;
  return at - last > timeoutMinutes * 60_000;
}
