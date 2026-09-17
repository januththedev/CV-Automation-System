import { open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
export const MAX_DOCUMENT_TEXT_LENGTH = 100_000;
const PDF_TIMEOUT_MS = 30_000;
export type DocumentReviewCode = 'TOO_LARGE' | 'OCR_REQUIRED' | 'UNSUPPORTED_FORMAT' | 'INVALID_DOCUMENT' | 'READ_FAILED' | 'PARSER_UNAVAILABLE' | 'TIMEOUT';

/** The pipeline should persist NEEDS_REVIEW; never replace this error with empty CV text. */
export class DocumentReviewNeededError extends Error {
  readonly needs_review = true;
  readonly needsReview = true;
  constructor(public readonly code: DocumentReviewCode, message: string) {
    super(message);
    this.name = 'DocumentReviewNeededError';
  }
}

// Static worker file (never eval'd); tsc ignores it, so it must be shipped alongside
// the compiled output (Dockerfile copies it into dist/ai/).
const PDF_WORKER_PATH = fileURLToPath(new URL('./pdf-worker.cjs', import.meta.url));

async function parsePDF(bytes: Buffer): Promise<string> {
  const result = await new Promise<{ text: string; pages: number; blankPages: number }>((resolve, reject) => {
    // Isolate parser CPU/memory so the timeout can actually terminate a stuck parser.
    const worker = new Worker(PDF_WORKER_PATH, {
      workerData: { bytes },
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32 },
    });
    let settled = false;
    const finish = (error?: DocumentReviewNeededError, value?: { text: string; pages: number; blankPages: number }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().catch(() => {});
      if (error) reject(error); else resolve(value!);
    };
    const timer = setTimeout(() => finish(new DocumentReviewNeededError('TIMEOUT', 'PDF parsing timed out; manual review required.')), PDF_TIMEOUT_MS);
    worker.once('message', (value) => {
      if (value?.tooLarge) finish(new DocumentReviewNeededError('TOO_LARGE', 'PDF exceeds 100 pages or text limit.'));
      else if (!value || value.failed || typeof value.text !== 'string' || !Number.isInteger(value.pages) || value.pages < 1 || !Number.isInteger(value.blankPages)) {
        finish(new DocumentReviewNeededError('INVALID_DOCUMENT', 'PDF is unreadable, encrypted or malformed; manual review required.'));
      } else finish(undefined, value);
    });
    worker.once('error', () => finish(new DocumentReviewNeededError('INVALID_DOCUMENT', 'PDF parsing failed; manual review required.')));
    worker.once('exit', () => { if (!settled) finish(new DocumentReviewNeededError('INVALID_DOCUMENT', 'PDF parser exited without a result.')); });
  });
  if (!result.text.trim() || result.blankPages > 0) {
    throw new DocumentReviewNeededError('OCR_REQUIRED', 'PDF has pages without readable text; OCR or manual review of the original is required.');
  }
  return result.text;
}

async function boundedRead(localPath: string): Promise<Buffer> {
  const file = await open(localPath, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new DocumentReviewNeededError('INVALID_DOCUMENT', 'Document must be a regular file.');
    if (stat.size > MAX_DOCUMENT_BYTES) throw new DocumentReviewNeededError('TOO_LARGE', 'Document exceeds the 20 MiB size limit.');
    if (stat.size === 0) throw new DocumentReviewNeededError('INVALID_DOCUMENT', 'Document is empty.');
    // Read at most size+1: detects a growing file without an unbounded readFile allocation.
    const buffer = Buffer.alloc(stat.size + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await file.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > stat.size) throw new DocumentReviewNeededError('INVALID_DOCUMENT', 'Document changed while being read.');
    return buffer.subarray(0, total);
  } finally { await file.close(); }
}

/**
 * Local PDF/text reader. MIME is optional; extension fallback supports downloaded originals.
 * DOC/DOCX and images are accepted for review but not silently reduced to empty text.
 * No OCR dependency is bundled: preserve the original for manual review/OCR upstream.
 */
export async function readDocument(localPath: string, mime?: string): Promise<string> {
  try {
    const bytes = await boundedRead(localPath);
    const type = mime?.split(';')[0].trim().toLowerCase();
    const ext = path.extname(localPath).toLowerCase();
    const fallback = !type || type === 'application/octet-stream';
    let text: string;
    if (type === 'application/pdf' || (fallback && ext === '.pdf')) {
      if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new DocumentReviewNeededError('INVALID_DOCUMENT', 'Document is not a PDF.');
      text = await parsePDF(bytes);
    } else if (type === 'text/plain' || (fallback && ext === '.txt')) {
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new DocumentReviewNeededError('INVALID_DOCUMENT', 'Text document must be valid UTF-8.'); }
      if (text.includes('\0')) throw new DocumentReviewNeededError('INVALID_DOCUMENT', 'Text document contains binary data.');
    } else if (type?.startsWith('image/') || (fallback && ['.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff', '.bmp'].includes(ext))) {
      throw new DocumentReviewNeededError('OCR_REQUIRED', 'Image CV requires OCR or manual review of the original.');
    } else {
      throw new DocumentReviewNeededError('UNSUPPORTED_FORMAT', 'Document format is not text-readable here. Supply a text PDF/UTF-8 file or manually review the original DOC/DOCX.');
    }
    if (text.length > MAX_DOCUMENT_TEXT_LENGTH) throw new DocumentReviewNeededError('TOO_LARGE', 'Document text exceeds 100000 characters.');
    text = text.trim();
    if (!text) throw new DocumentReviewNeededError('OCR_REQUIRED', 'Document has no readable text; manual review required.');
    return text;
  } catch (error) {
    if (error instanceof DocumentReviewNeededError) throw error;
    throw new DocumentReviewNeededError('READ_FAILED', 'Document could not be read; manual review required.');
  }
}
