import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Job } from 'bullmq';
import type { ExtractedCandidate, QueueName, ApplicationStatus } from '../../src/contracts.js';
import * as db from '../../src/database/db.js';
import type { WorkerContext } from '../worker-context.js';
import type { WhatsAppClient } from '../../src/integrations/whatsapp/client.js';
import type { OneDriveClient } from '../../src/integrations/onedrive/client.js';
import type { SheetsClient } from '../../src/integrations/google-sheets/client.js';
import type { AdminEvent } from '../../src/services/notify.js';

export interface PipelineJobData { applicationId: string; workId?: string; revision?: number }
export interface OutboundData {
  to: string; body: string; applicationId?: string; revision?: number;
  purpose?: 'greeting' | 'details' | 'confirmation';
}
export interface Journal {
  extraction?: ExtractedCandidate;
  validated?: boolean;
  sheetUrl?: string;
  sheetRow?: number;
  sent?: string[];
}
export class StaleRevision extends Error {}
export interface Pass {
  app: db.DatabaseApplication;
  revision: number;
  journal: Journal;
  refresh(): db.DatabaseApplication;
  patch(patch: db.ApplicationPatch): db.DatabaseApplication;
  saveJournal(): Promise<void>;
}
export interface PipelineServices {
  context: WorkerContext;
  whatsapp(): WhatsAppClient;
  onedrive(): OneDriveClient;
  sheets(): SheetsClient;
  ensureHeaders(): Promise<void>;
  notify(event: AdminEvent): Promise<void>;
  enqueue(name: QueueName, data: PipelineJobData | OutboundData, key: string): Promise<void>;
  outbound(pass: Pass, purpose: NonNullable<OutboundData['purpose']>, body: string): Promise<void>;
  serialize<T>(key: string, action: () => Promise<T>): Promise<T>;
}
export function safeFilename(input: string): string {
  let name = input.split(/[\\/]/).pop()!.replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_').replace(/[. ]+$/g, '').slice(0, 180);
  if (!name || /^\.+$/.test(name)) name = 'cv.bin';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  return name;
}
export function applicationDirectory(context: WorkerContext, id: string): string {
  // IDs normally use APP-YYYY-NNNNNN; reject traversal even for malformed queued data.
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid application identifier');
  return path.resolve(context.config.dataDir, 'cv-files', id);
}
export const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export async function openPass(context: WorkerContext, app: db.DatabaseApplication): Promise<Pass> {
  const journalPath = path.join(applicationDirectory(context, app.id), '.pipeline', `${app.revision}.json`);
  let journal: Journal = {};
  try { journal = JSON.parse(await readFile(journalPath, 'utf8')) as Journal; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Pipeline checkpoint could not be read'); }
  const pass: Pass = {
    app, revision: app.revision, journal,
    refresh() {
      const current = db.getApplicationById(app.id);
      if (!current || current.revision !== pass.revision) throw new StaleRevision();
      pass.app = current;
      return current;
    },
    patch(patch) {
      const current = db.updateApplication(app.id, patch, pass.revision);
      if (!current) throw new StaleRevision();
      pass.app = current;
      return current;
    },
    async saveJournal() {
      pass.refresh();
      await mkdir(path.dirname(journalPath), { recursive: true });
      const temporary = `${journalPath}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(pass.journal), { mode: 0o600 });
      await rename(temporary, journalPath);
      pass.refresh();
    },
  };
  return pass;
}
export function handled(pass: Pass): boolean { return pass.app.processed_revision >= pass.revision; }
export function finish(pass: Pass, status: ApplicationStatus, patch: db.ApplicationPatch = {}): void {
  pass.patch({ ...patch, status, processed_revision: pass.revision });
}
export type Stage = (pass: Pass, services: PipelineServices, job: Job) => Promise<void>;
