import { google, type sheets_v4 } from 'googleapis';
import { SHEET_COLUMNS, type CandidateRecord, type SheetsClientApi, type SheetsConfig } from '../../contracts.js';

const MAX_LOOKUP_ROWS = 100_000;
const MAX_RETRIES = 3;
const REQUEST_OPTIONS = { timeout: 30_000, retry: false } as const;

/** Service-account Sheets adapter. Call ensureHeaderRow before processing applications.
 * Writers across processes must be serialized by the queue: Sheets has no atomic upsert.
 */
export class SheetsClient implements SheetsClientApi {
  private readonly sheets: sheets_v4.Sheets;
  private readonly sheetId: string;
  private readonly sheetName: string;

  constructor(cfg: SheetsConfig) {
    this.sheetId = cfg.sheetId;
    this.sheetName = cfg.sheetName ?? 'Applications';
    try {
      const auth = new google.auth.JWT({
        email: cfg.serviceAccountEmail,
        key: cfg.privateKey.replace(/\\n/g, '\n'),
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      this.sheets = google.sheets({ version: 'v4', auth });
    } catch {
      throw new Error('Google Sheets: invalid service-account configuration. Check the email and private key via `cv-auto config`.');
    }
  }

  async ensureHeaderRow(): Promise<void> {
    const res = await this.withRetry(() => this.sheets.spreadsheets.values.get({
      spreadsheetId: this.sheetId, range: this.range('A1:L1'),
      valueRenderOption: 'UNFORMATTED_VALUE',
    }, REQUEST_OPTIONS));
    const header = res.data.values?.[0] ?? [];
    if (header.length === SHEET_COLUMNS.length && SHEET_COLUMNS.every((col, i) => header[i] === col)) return;
    await this.withRetry(() => this.sheets.spreadsheets.values.update({
      spreadsheetId: this.sheetId, range: this.range('A1:L1'), valueInputOption: 'RAW',
      requestBody: { values: [[...SHEET_COLUMNS]] },
    }, REQUEST_OPTIONS));
  }

  async findRowByApplicationId(applicationId: string): Promise<number | null> {
    if (!applicationId.trim()) throw new Error('Google Sheets: Application ID must not be empty.');
    const res = await this.withRetry(() => this.sheets.spreadsheets.values.get({
      spreadsheetId: this.sheetId, range: this.range(`A2:A${MAX_LOOKUP_ROWS + 1}`),
      valueRenderOption: 'UNFORMATTED_VALUE',
    }, REQUEST_OPTIONS));
    const values = res.data.values ?? [];
    const index = values.findIndex(row => row[0] === applicationId);
    if (index !== -1) return index + 2;
    // Do not conclude "missing" from a truncated scan and create duplicates.
    if (values.length >= MAX_LOOKUP_ROWS) {
      throw new SheetsOperationError('Google Sheets: application lookup limit reached. Archive old rows or increase the reviewed lookup limit before retrying.');
    }
    return null;
  }

  async writeApplicationRow(rec: CandidateRecord): Promise<{ row: number }> {
    const values = [[rec.application_id, rec.datetime, rec.name ?? '', rec.nic ?? '',
      rec.address ?? '', rec.whatsapp_number, rec.cv_phone_number ?? '', rec.profession ?? '',
      rec.cv_url ?? '', rec.status, rec.review ? 'YES' : 'NO', rec.error ?? '']];

    // Retry the whole lookup/write operation, never blindly retry append: a 5xx
    // response can arrive after the server committed the row.
    return this.withRetry(async () => {
      const existingRow = await this.findRowByApplicationId(rec.application_id);
      if (existingRow !== null) {
        await this.sheets.spreadsheets.values.update({
          spreadsheetId: this.sheetId, range: this.range(`A${existingRow}:L${existingRow}`),
          valueInputOption: 'RAW', requestBody: { values },
        }, REQUEST_OPTIONS);
        return { row: existingRow };
      }
      const res = await this.sheets.spreadsheets.values.append({
        spreadsheetId: this.sheetId, range: this.range('A:L'), valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS', requestBody: { values },
      }, REQUEST_OPTIONS);
      const match = res.data.updates?.updatedRange?.match(/!A(\d+):L\1$/);
      const parsed = match ? Number(match[1]) : 0;
      const row = Number.isSafeInteger(parsed) && parsed >= 2
        ? parsed : await this.findRowByApplicationId(rec.application_id);
      if (row === null) {
        throw new SheetsOperationError('Google Sheets: write returned no usable row number. Check the sheet and retry the application; do not append manually.');
      }
      return { row };
    });
  }

  /** Metadata-only access check, not proof of write permission. Header repair
   * and subsequent writes verify Editor permission without a destructive probe.
   */
  async verifyAccess(): Promise<void> {
    const res = await this.withRetry(() => this.sheets.spreadsheets.get({
      spreadsheetId: this.sheetId, fields: 'sheets.properties.title', includeGridData: false,
    }, REQUEST_OPTIONS));
    if (!res.data.sheets?.some(sheet => sheet.properties?.title === this.sheetName)) {
      throw new Error(`Google Sheets: tab "${this.sheetName}" does not exist. Create it or change sheetName via \`cv-auto config\`.`);
    }
  }

  private range(cells: string): string {
    return `'${this.sheetName.replace(/'/g, "''")}'!${cells}`;
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof SheetsOperationError) throw err;
        const status = statusOf(err);
        if (attempt >= MAX_RETRIES || !(status === 429 || (status !== undefined && status >= 500 && status <= 599))) {
          throw sanitizedError(err);
        }
        await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
      }
    }
  }
}

/** Only our own sanitized errors can pass through an outer retry boundary. */
class SheetsOperationError extends Error {}

function statusOf(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as { response?: { status?: unknown }; status?: unknown; code?: unknown };
  const raw = e.response?.status ?? e.status ?? e.code;
  const status = Number(raw);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

function sanitizedError(err: unknown): Error {
  const status = statusOf(err);
  let hint: string;
  switch (status) {
    case 401:
      hint = 'Authentication failed. Check the service-account email, private key and system clock via `cv-auto config`.';
      break;
    case 403:
      hint = 'Access denied. Enable the Google Sheets API and share the spreadsheet with the service-account email as Editor; check `cv-auto config`.';
      break;
    case 404:
      hint = 'Spreadsheet not found or not shared. Check the Sheet ID and share it with the service-account email via `cv-auto config`.';
      break;
    case 400:
      hint = 'Invalid request or credentials. Check the Sheet ID, tab name, service-account key and system clock via `cv-auto config`.';
      break;
    case undefined:
      hint = 'Request failed or timed out. Check connectivity, service-account credentials and system clock; run `cv-auto config` or `cv-auto doctor`.';
      break;
    default:
      hint = `API returned HTTP ${status}. Retry later; if it persists run \`cv-auto doctor\`.`;
  }
  // Provider errors can contain request config, JWTs and keys; never log or retain them as cause.
  return new SheetsOperationError(`Google Sheets: ${hint}`);
}
