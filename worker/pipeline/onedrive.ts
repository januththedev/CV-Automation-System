import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { digest, handled, type Stage } from './types.js';

export const processOneDrive: Stage = async (pass, services) => {
  if (handled(pass)) return;
  if (!pass.journal.validated || !pass.app.cv_local_path || !pass.app.cv_file_hash) {
    await services.enqueue('cv-processing', { applicationId: pass.app.id }, `cv-${pass.app.id}-${pass.revision}`);
    return;
  }
  if (!pass.app.onedrive_file_id) {
    pass.patch({ status: 'UPLOADING_TO_ONEDRIVE', error: null });
    if (digest(await readFile(pass.app.cv_local_path!)) !== pass.app.cv_file_hash) throw new Error('Original document integrity check failed');
    const root = services.context.config.onedrive?.folderRoot;
    if (!root) throw new Error('OneDrive is not configured');
    const folder = `${root.replace(/\/+$/g, '')}/${pass.app.id}/${pass.app.cv_file_hash}`;
    await services.onedrive().ensureFolder(folder);
    pass.refresh();
    const uploaded = await services.onedrive().uploadFile(pass.app.cv_local_path!, `${folder}/${path.basename(pass.app.cv_local_path!)}`);
    pass.patch({ onedrive_file_id: uploaded.fileId });
  }
  if (!pass.app.onedrive_url) {
    pass.patch({ status: 'CREATING_LINK', error: null });
    const url = await services.onedrive().createShareLink(pass.app.onedrive_file_id!);
    pass.patch({ onedrive_url: url });
  }
  await services.enqueue('google-sheets', { applicationId: pass.app.id, revision: pass.revision }, `sheets-${pass.app.id}-${pass.revision}`);
};
