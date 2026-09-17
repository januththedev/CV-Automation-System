import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHEET_COLUMNS, type CandidateRecord, type SheetsConfig } from '../../../contracts.js';

const api = vi.hoisted(() => ({
  get: vi.fn(), update: vi.fn(), append: vi.fn(), metadata: vi.fn(),
  jwt: vi.fn(), sheets: vi.fn(),
}));
vi.mock('googleapis', () => ({
  google: {
    auth: { JWT: api.jwt },
    sheets: api.sheets,
  },
}));
import { SheetsClient } from '../client.js';

const dummyKey = ['not', 'a', 'real', 'key'].join('\\n');
const cfg: SheetsConfig = {
  serviceAccountEmail: 'automation@example.iam.gserviceaccount.com',
  privateKey: dummyKey, sheetId: 'spreadsheet-id',
};
const rec: CandidateRecord = {
  application_id: 'APP-2026-000142', datetime: '2026-09-17T10:42:00Z',
  name: 'Janith Perera', nic: null, address: '=untrusted text',
  whatsapp_number: '+94771234567', cv_phone_number: '0771234567',
  profession: 'Software Engineer', cv_url: 'https://1drv.ms/example',
  status: 'COMPLETED', review: false, error: null,
};
const rowValues = [rec.application_id, rec.datetime, rec.name, '', rec.address,
  rec.whatsapp_number, rec.cv_phone_number, rec.profession, rec.cv_url,
  rec.status, 'NO', ''];
const requestOptions = { timeout: 30_000, retry: false };

beforeEach(() => {
  vi.resetAllMocks();
  api.jwt.mockImplementation(function () { return { kind: 'jwt' }; });
  api.sheets.mockReturnValue({ spreadsheets: {
    values: { get: api.get, update: api.update, append: api.append },
    get: api.metadata,
  } });
  api.update.mockResolvedValue({ data: {} });
  api.append.mockResolvedValue({ data: { updates: { updatedRange: "'Applications'!A5:L5" } } });
  api.metadata.mockResolvedValue({ data: { sheets: [{ properties: { title: 'Applications' } }] } });
});
afterEach(() => { vi.useRealTimers(); });

describe('SheetsClient', () => {
  it('creates a service-account JWT and Sheets v4 client', () => {
    new SheetsClient(cfg);
    expect(api.jwt).toHaveBeenCalledWith({ email: cfg.serviceAccountEmail,
      key: 'not\na\nreal\nkey', scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    expect(api.sheets).toHaveBeenCalledWith({ version: 'v4', auth: { kind: 'jwt' } });
  });

  it('updates an existing application in place with canonical, RAW column values', async () => {
    api.get.mockResolvedValue({ data: { values: [['OTHER'], [], [rec.application_id]] } });
    await expect(new SheetsClient(cfg).writeApplicationRow(rec)).resolves.toEqual({ row: 4 });
    expect(api.update).toHaveBeenCalledWith({ spreadsheetId: cfg.sheetId,
      range: "'Applications'!A4:L4", valueInputOption: 'RAW',
      requestBody: { values: [rowValues] } }, requestOptions);
    expect(api.append).not.toHaveBeenCalled();
    expect(api.get).toHaveBeenCalledWith({ spreadsheetId: cfg.sheetId,
      range: "'Applications'!A2:A100001", valueRenderOption: 'UNFORMATTED_VALUE' }, requestOptions);
  });

  it('appends a missing application and returns its actual row; true becomes YES', async () => {
    api.get.mockResolvedValue({ data: {} });
    await expect(new SheetsClient(cfg).writeApplicationRow({ ...rec, review: true }))
      .resolves.toEqual({ row: 5 });
    expect(api.update).not.toHaveBeenCalled();
    expect(api.append).toHaveBeenCalledWith({ spreadsheetId: cfg.sheetId,
      range: "'Applications'!A:L", valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[...rowValues.slice(0, 10), 'YES', '']] } }, requestOptions);
  });

  it.each([[], ['Application ID', 'Wrong'], [...SHEET_COLUMNS.slice(0, 11), 'Wrong']])(
    'repairs noncanonical headers %j', async (...headers) => {
      api.get.mockResolvedValue({ data: { values: [headers] } });
      await new SheetsClient(cfg).ensureHeaderRow();
      expect(api.get.mock.calls[0][0].range).toBe("'Applications'!A1:L1");
      expect(api.update).toHaveBeenCalledWith({ spreadsheetId: cfg.sheetId,
        range: "'Applications'!A1:L1", valueInputOption: 'RAW',
        requestBody: { values: [[...SHEET_COLUMNS]] } }, requestOptions);
    });

  it('does not rewrite a canonical header', async () => {
    api.get.mockResolvedValue({ data: { values: [[...SHEET_COLUMNS]] } });
    await new SheetsClient(cfg).ensureHeaderRow();
    expect(api.update).not.toHaveBeenCalled();
  });

  it('quotes sheet titles and matches IDs exactly', async () => {
    api.get.mockResolvedValue({ data: { values: [['APP-1-extra'], ['APP-1']] } });
    const client = new SheetsClient({ ...cfg, sheetName: "Owner's Applications" });
    await expect(client.findRowByApplicationId('APP-1')).resolves.toBe(3);
    expect(api.get.mock.calls[0][0].range).toBe("'Owner''s Applications'!A2:A100001");
  });

  it('fails closed when the lookup limit is reached rather than appending a potential duplicate', async () => {
    api.get.mockResolvedValue({ data: { values: Array.from({ length: 100_000 }, () => ['OTHER']) } });
    await expect(new SheetsClient(cfg).writeApplicationRow(rec)).rejects.toThrow(/limit/i);
    expect(api.append).not.toHaveBeenCalled();
  });

  it('verifies metadata without modifying the sheet', async () => {
    await new SheetsClient(cfg).verifyAccess();
    expect(api.metadata).toHaveBeenCalledWith({ spreadsheetId: cfg.sheetId,
      fields: 'sheets.properties.title', includeGridData: false }, requestOptions);
    expect(api.update).not.toHaveBeenCalled();
  });

  it('reports a missing tab with an actionable message', async () => {
    api.metadata.mockResolvedValue({ data: { sheets: [] } });
    await expect(new SheetsClient(cfg).verifyAccess()).rejects.toThrow(/Applications.*create|create.*Applications/i);
  });

  it.each([401, 403, 404])('reports actionable HTTP %s errors without secret-bearing provider errors', async status => {
    api.metadata.mockRejectedValue({ response: { status }, message: cfg.privateKey,
      config: { privateKey: cfg.privateKey } });
    const err = await new SheetsClient(cfg).verifyAccess().catch(e => e);
    expect(err.message).toMatch(/cv-auto config/);
    expect(err.message).not.toContain(cfg.privateKey);
    expect(err.cause).toBeUndefined();
    expect(api.metadata).toHaveBeenCalledTimes(1);
  });

  it('retries 429 and 503 with exponential backoff', async () => {
    vi.useFakeTimers();
    api.metadata.mockRejectedValueOnce({ response: { status: 429 } })
      .mockRejectedValueOnce({ response: { status: 503 } });
    const result = new SheetsClient(cfg).verifyAccess();
    await vi.advanceTimersByTimeAsync(999);
    expect(api.metadata).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.metadata).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    await result;
    expect(api.metadata).toHaveBeenCalledTimes(3);
  });

  it('bounds retries and returns a sanitized error after exhaustion', async () => {
    vi.useFakeTimers();
    api.metadata.mockRejectedValue({ response: { status: 500 }, message: cfg.privateKey });
    const result = new SheetsClient(cfg).verifyAccess().catch(e => e);
    await vi.runAllTimersAsync();
    const err = await result;
    expect(api.metadata).toHaveBeenCalledTimes(4);
    expect(err.message).toMatch(/500/);
    expect(err.message).not.toContain(cfg.privateKey);
  });

  it('rechecks the application before retrying an ambiguous append failure', async () => {
    vi.useFakeTimers();
    api.get.mockResolvedValueOnce({ data: {} })
      .mockResolvedValue({ data: { values: [[rec.application_id]] } });
    api.append.mockRejectedValueOnce({ response: { status: 503 } });
    const result = new SheetsClient(cfg).writeApplicationRow(rec);
    await vi.runAllTimersAsync();
    await expect(result).resolves.toEqual({ row: 2 });
    expect(api.append).toHaveBeenCalledTimes(1);
    expect(api.update.mock.calls[0][0].range).toBe("'Applications'!A2:L2");
  });

  it('recovers the row via lookup when append omits updatedRange', async () => {
    api.get.mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: { values: [[rec.application_id]] } });
    api.append.mockResolvedValue({ data: {} });
    await expect(new SheetsClient(cfg).writeApplicationRow(rec)).resolves.toEqual({ row: 2 });
    expect(api.append).toHaveBeenCalledTimes(1);
  });
});
