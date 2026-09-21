import { applicationRecordFromApplication } from '../../src/contracts.js';
import { completed } from '../../src/integrations/whatsapp/templates.js';
import { finish, handled, type Stage } from './types.js';

export const processSheets: Stage = async (pass, services) => {
  if (handled(pass)) {
    if (pass.app.status === 'COMPLETED' && !pass.app.confirmation_sent) await services.outbound(pass, 'confirmation', completed());
    return;
  }
  if (!pass.journal.validated || !pass.app.onedrive_url) {
    await services.enqueue('cv-processing', { applicationId: pass.app.id }, `cv-${pass.app.id}-${pass.revision}`);
    return;
  }
  if (!pass.app.sheet_row_number || pass.journal.sheetUrl !== pass.app.onedrive_url || !pass.journal.sheetRow) {
    pass.patch({ status: 'WRITING_TO_GOOGLE_SHEETS', error: null });
    // Sheets upsert is lookup + write, not atomic. Serialize writers in this runtime.
    await services.serialize('sheet-writer', async () => {
      await services.ensureHeaders();
      pass.refresh();
      const result = await services.sheets().writeApplicationRow(applicationRecordFromApplication({ ...pass.app, status: 'COMPLETED' }));
      pass.patch({ sheet_row_number: result.row });
      pass.journal.sheetUrl = pass.app.onedrive_url!;
      pass.journal.sheetRow = result.row;
      await pass.saveJournal();
    });
  }
  pass.patch({ status: 'COMPLETED', error: null, review: false });
  if (!pass.app.confirmation_sent) await services.outbound(pass, 'confirmation', completed());
  // Outbound queue is durable now; confirmation_sent belongs to its delivery processor.
  finish(pass, 'COMPLETED');
};
