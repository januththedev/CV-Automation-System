import { describe, expect, it } from 'vitest';
import type { Application, InboundMessage } from '../../contracts.js';
import { classifyInbound, sessionExpired, type ConversationApplication } from '../sessions.js';

const application: ConversationApplication = {
  id: 'APP-2026-000001', created_at: '2026-09-17T10:00:00Z', updated_at: '2026-09-17T10:00:00Z',
  whatsapp_number: '+94771234567', whatsapp_jid: '94771234567@s.whatsapp.net',
  name: null, nic: null, address: null, cv_phone_number: null, profession: null,
  status: 'RECEIVED', review: false, error: null, onedrive_file_id: null, onedrive_url: null,
  cv_file_hash: null, sheet_row_number: null, cv_local_path: null, confirmation_sent: false,
  greeting_sent: false,
};
const message: InboundMessage = {
  wa_message_id: 'one', from_number: application.whatsapp_number, from_jid: application.whatsapp_jid,
  timestamp: application.created_at, type: 'text', text: 'Hello +19999999999',
  media_id: null, media_mime_type: null, media_filename: null,
};

describe('classifyInbound', () => {
  it('greets a new text conversation with no greeting checkpoint', () => {
    expect(classifyInbound(application, message)).toBe('greeting');
  });
  it('never re-greets after the caller supplies the persisted greeting checkpoint', () => {
    expect(classifyInbound({ ...application, greeting_sent: true }, message)).toBe('unsolicited');
  });
  it('does not infer an unsent greeting from a missing session checkpoint', () => {
    const { greeting_sent: _checkpoint, ...app } = application;
    expect(classifyInbound(app, message)).toBe('unsolicited');
  });
  it('prioritizes requested details without changing status or content', () => {
    const app = Object.freeze({ ...application, status: 'WAITING_FOR_DETAILS' as const });
    expect(classifyInbound(app, Object.freeze(message))).toBe('details');
    expect(app.status).toBe('WAITING_FOR_DETAILS');
    expect(app.name).toBeNull();
    expect(app.whatsapp_number).toBe(message.from_number);
  });
  it.each(['COMPLETED', 'FAILED', 'NEEDS_REVIEW'] satisfies Application['status'][])(
    'classifies unrequested text in %s as unsolicited', status => {
      expect(classifyInbound({ ...application, status }, message)).toBe('unsolicited');
    });
  it('does not treat media or a document-bearing application as a new text greeting', () => {
    expect(classifyInbound(application, { ...message, type: 'document', media_id: 'doc' })).toBe('unsolicited');
    expect(classifyInbound({ ...application, media_id: 'doc' }, message)).toBe('unsolicited');
    expect(classifyInbound({ ...application, cv_local_path: '/cv.pdf' }, message)).toBe('unsolicited');
  });
});

describe('sessionExpired', () => {
  const session = { whatsapp_number: message.from_number, application_id: application.id,
    updated_at: '2026-09-17T10:00:00Z', greeting_sent: true };
  it('expires only strictly past the timeout boundary', () => {
    expect(sessionExpired(session, new Date('2026-09-17T10:29:59.999Z'), 30)).toBe(false);
    expect(sessionExpired(session, new Date('2026-09-17T10:30:00Z'), 30)).toBe(false);
    expect(sessionExpired(session, new Date('2026-09-17T10:30:00.001Z'), 30)).toBe(true);
  });
  it('handles absent sessions, backdated clocks and zero timeout', () => {
    expect(sessionExpired(null, new Date(), 30)).toBe(true);
    expect(sessionExpired(session, Date.parse('2026-09-17T09:00:00Z'), 30)).toBe(false);
    expect(sessionExpired(session, Date.parse(session.updated_at), 0)).toBe(false);
    expect(sessionExpired(session, Date.parse(session.updated_at) + 1, 0)).toBe(true);
  });
  it('rejects invalid timeouts and does not guess on invalid timestamps', () => {
    for (const timeout of [-1, NaN, Infinity]) {
      expect(() => sessionExpired(session, Date.now(), timeout)).toThrow('Invalid session timeout');
    }
    expect(sessionExpired({ ...session, updated_at: 'invalid' }, Date.now(), 30)).toBe(false);
    expect(sessionExpired(session, NaN, 30)).toBe(false);
  });
});
