import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
const mocks = vi.hoisted(() => ({ buffer: Buffer.from('Jane Perera'), pdf: { text: 'Jane Perera', pages: 1, blankPages: 0 }, terminate: vi.fn(), worker: vi.fn() }));
vi.mock('node:fs/promises', () => ({ open: vi.fn(async () => ({
  stat: async () => ({ size: mocks.buffer.length, isFile: () => true }),
  read: async (target: Buffer, offset: number, length: number, position: number) => {
    const bytesRead = Math.min(length, mocks.buffer.length - position);
    mocks.buffer.copy(target, offset, position, position + bytesRead);
    return { bytesRead, buffer: target };
  },
  close: async () => {},
})) }));
vi.mock('node:worker_threads', () => ({ Worker: class extends EventEmitter {
  constructor(path: string, options: unknown) { super(); mocks.worker(path, options); queueMicrotask(() => this.emit('message', mocks.pdf)); }
  terminate() { mocks.terminate(); return Promise.resolve(0); }
} }));
import { readDocument, DocumentReviewNeededError, MAX_DOCUMENT_BYTES } from '../document.js';

beforeEach(() => { vi.clearAllMocks(); mocks.buffer = Buffer.from('Jane Perera'); mocks.pdf = { text: 'Jane Perera', pages: 1, blankPages: 0 }; });
describe('document preparation', () => {
  it('reads UTF-8 text without network or shell', async () => {
    expect(await readDocument('/local/cv.txt', 'text/plain')).toBe('Jane Perera');
  });
  it('uses the static pdf-parse worker file, never the entrypoint', async () => {
    mocks.buffer = Buffer.from('%PDF-1.7\nmock');
    expect(await readDocument('/local/cv.pdf')).toBe('Jane Perera');
    expect(String(mocks.worker.mock.calls[0][0])).toMatch(/pdf-worker\.cjs$/);
    expect(mocks.terminate).toHaveBeenCalled();
  });
  it('rejects scanned and partially scanned PDFs, never empty success', async () => {
    mocks.buffer = Buffer.from('%PDF-1.7\nmock');
    mocks.pdf = { text: '', pages: 1, blankPages: 1 };
    await expect(readDocument('/local/scan.pdf')).rejects.toMatchObject({ code: 'OCR_REQUIRED', needs_review: true });
    mocks.pdf = { text: 'Page one', pages: 2, blankPages: 1 };
    await expect(readDocument('/local/partial.pdf')).rejects.toMatchObject({ code: 'OCR_REQUIRED' });
  });
  it('returns typed review-needed for images and optional unsupported DOCX', async () => {
    await expect(readDocument('/local/cv.png', 'image/png')).rejects.toMatchObject({ code: 'OCR_REQUIRED' });
    await expect(readDocument('/local/cv.docx')).rejects.toBeInstanceOf(DocumentReviewNeededError);
  });
  it('enforces byte/text limits, PDF signature and strict text decoding', async () => {
    mocks.buffer = Buffer.alloc(MAX_DOCUMENT_BYTES + 1);
    await expect(readDocument('/local/cv.pdf')).rejects.toMatchObject({ code: 'TOO_LARGE' });
    mocks.buffer = Buffer.from('not a PDF');
    await expect(readDocument('/local/cv.pdf')).rejects.toMatchObject({ code: 'INVALID_DOCUMENT' });
    mocks.buffer = Buffer.from([0xff, 0xfe]);
    await expect(readDocument('/local/cv.txt')).rejects.toMatchObject({ code: 'INVALID_DOCUMENT' });
    mocks.buffer = Buffer.from('x'.repeat(100_001));
    await expect(readDocument('/local/cv.txt')).rejects.toMatchObject({ code: 'TOO_LARGE' });
  });
});
