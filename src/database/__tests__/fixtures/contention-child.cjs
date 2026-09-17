'use strict';
const path = require('node:path');
const db = require('../../db.ts');

const main = async () => {
  db.getDb(path.resolve('test.db'));
  const ids = Array.from({ length: 15 }, () => db.nextApplicationId());
  const result = db.recordInbound({
    wa_message_id: 'shared-message',
    from_number: '+94771234567',
    from_jid: '94771234567@s.whatsapp.net',
    timestamp: '2026-09-17T10:00:00.000Z',
    type: 'document',
    text: null,
    media_id: 'media-1',
    media_mime_type: 'application/pdf',
    media_filename: 'CV.pdf',
  }, 30);
  process.stdout.write(JSON.stringify({ ids, duplicate: result.duplicate }));
  db.closeDb();
};

main().catch((error) => {
  process.stderr.write(String(error && error.stack ? error.stack : error));
  process.exit(1);
});
