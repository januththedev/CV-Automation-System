import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as db from '../../src/database/db.js';
import { downloadMedia } from '../../src/integrations/whatsapp/client.js';
import { readDocument, DocumentReviewNeededError } from '../../src/ai/document.js';
import { extractCandidateData } from '../../src/integrations/openrouter/extract.js';
import { completed, greeting, needsReview } from '../../src/integrations/whatsapp/templates.js';
import { classifyInbound } from '../../src/services/sessions.js';
import { applicationDirectory, digest, finish, handled, safeFilename, type Stage } from './types.js';

export const processCv: Stage = async (pass, services) => {
  const { context } = services;
  const messages = db.listApplicationMessages(pass.app.id);
  if (handled(pass) || ((!pass.app.media_id && !pass.app.cv_local_path) &&
    (pass.app.status === 'COMPLETED' || pass.app.status === 'WAITING_FOR_DETAILS'))) {
    if (pass.app.status === 'COMPLETED' && !pass.app.confirmation_sent) await services.outbound(pass, 'confirmation', completed());
    if (pass.app.status === 'WAITING_FOR_DETAILS') {
      const missing = [...new Set(context.config.mandatoryFields)].filter(field => !pass.app[field]?.trim());
      if (missing.length) await services.outbound(pass, 'details', needsReview(missing));
    }
    return;
  }
  if (!pass.app.media_id && !pass.app.cv_local_path) {
    const session = db.getSession(pass.app.whatsapp_number);
    const last = messages.at(-1);
    if (last && classifyInbound({ ...pass.app, greeting_sent: session?.application_id === pass.app.id ? session.greeting_sent : undefined }, last) === 'greeting') {
      await services.outbound(pass, 'greeting', greeting());
    }
    return;
  }
  if (!pass.app.cv_local_path || !pass.app.cv_file_hash) {
    pass.patch({ status: 'DOWNLOADING', error: null });
    let bytes: Buffer;
    let filename = pass.app.cv_filename ?? 'cv.bin';
    let mime = pass.app.cv_mime_type;
    if (pass.app.cv_local_path) {
      bytes = await readFile(pass.app.cv_local_path);
    } else {
      if (!context.config.whatsapp || !pass.app.media_id) throw new Error('Document download is not configured');
      const media = await downloadMedia(context.config.whatsapp, pass.app.media_id);
      pass.refresh();
      bytes = media.buffer;
      filename = pass.app.cv_filename ?? media.filename;
      mime = pass.app.cv_mime_type ?? media.mimeType;
    }
    filename = safeFilename(filename);
    const hash = digest(bytes);
    // Content-addressed subfolders prevent an in-flight old revision overwriting a replacement.
    const root = path.resolve(applicationDirectory(context, pass.app.id));
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('Invalid content hash');
    const directory = path.resolve(root, hash);
    const localPath = path.resolve(directory, safeFilename(filename));
    // Defense in depth: the resolved write path must stay inside the directory.
    if (localPath !== directory && !localPath.startsWith(directory + path.sep)) {
      throw new Error('Refusing to write outside the application directory');
    }
    await mkdir(directory, { recursive: true });
    try { await writeFile(localPath, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (digest(await readFile(localPath)) !== hash) throw new Error('Original document integrity check failed');
    }
    pass.patch({ cv_local_path: localPath, cv_file_hash: hash, cv_filename: filename, cv_mime_type: mime });
  }
  if (!pass.journal.validated) {
    if (!pass.journal.extraction || !pass.app.extraction_json) {
      pass.patch({ status: 'AI_PROCESSING', error: null });
      let text: string;
      try { text = await readDocument(pass.app.cv_local_path!, pass.app.cv_mime_type ?? undefined); }
      catch (error) {
        if (!(error instanceof DocumentReviewNeededError)) throw error;
        pass.patch({ status: 'NEEDS_REVIEW', review: true, error: `DOCUMENT_${error.code}` });
        await services.notify({ type: 'review', appId: pass.app.id, missing: [] });
        finish(pass, 'NEEDS_REVIEW');
        return;
      }
      pass.refresh();
      if (!context.config.openrouter) throw new Error('Extraction is not configured');
      // Pass ALL conversation text/captions, never substitute an AI-supplied sender number.
      const extraction = await extractCandidateData({ cvText: text, cvFilename: pass.app.cv_filename,
        messages: messages.filter(message => message.text !== null).map(message => ({ text: message.text!, at: message.timestamp })),
      }, context.config.openrouter, { mandatoryFields: context.config.mandatoryFields });
      pass.refresh();
      pass.journal.extraction = extraction;
      await pass.saveJournal();
    }
    const extraction = pass.journal.extraction!;
    pass.patch({ status: 'VALIDATING', extraction_json: JSON.stringify(extraction),
      name: extraction.name, nic: extraction.nic, address: extraction.address,
      cv_phone_number: extraction.cv_phone_number, profession: extraction.profession,
      review: false, error: null, duplicate_of: null });
    const missing = [...new Set(context.config.mandatoryFields)].filter(field => !extraction[field]?.trim());
    if (missing.length) {
      pass.patch({ status: 'WAITING_FOR_DETAILS' });
      await services.outbound(pass, 'details', needsReview(missing));
      finish(pass, 'WAITING_FOR_DETAILS');
      return;
    }
    // AI supplies facts only. Backend validation/duplicate policy controls all transitions.
    pass.patch({ status: 'DUPLICATE_CHECK' });
    const duplicate = db.findDuplicate(pass.app.id);
    if (duplicate) {
      pass.patch({ status: 'NEEDS_REVIEW', review: true, duplicate_of: duplicate.id, error: 'DUPLICATE_MATCH' });
      await services.notify({ type: 'review', appId: pass.app.id, missing: [] });
      finish(pass, 'NEEDS_REVIEW');
      return;
    }
    if (extraction.needs_review) {
      pass.patch({ status: 'NEEDS_REVIEW', review: true, error: 'CANDIDATE_REVIEW_REQUIRED' });
      await services.notify({ type: 'review', appId: pass.app.id, missing: [] });
      finish(pass, 'NEEDS_REVIEW');
      return;
    }
    pass.journal.validated = true;
    await pass.saveJournal();
  }
  pass.refresh();
  await services.enqueue('onedrive', { applicationId: pass.app.id, revision: pass.revision }, `drive-${pass.app.id}-${pass.revision}`);
};
