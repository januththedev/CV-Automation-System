/**
 * Single source of truth for cross-module types and integration client signatures.
 * Parallel implementers must import from here — never redefine these.
 */

export type ExtractableField =
  | 'name'
  | 'nic'
  | 'address'
  | 'cv_phone_number'
  | 'profession';

export type FieldSource = 'cv' | 'whatsapp' | 'mixed';

/** AI extraction output — zod-validated, never free-form prose. */
export interface ExtractedCandidate {
  name: string | null;
  nic: string | null;
  address: string | null;
  cv_phone_number: string | null;
  profession: string | null;
  cv_present: boolean;
  cv_filename: string | null;
  missing_fields: ExtractableField[];
  needs_review: boolean;
  review_reason: string | null;
  source: Partial<Record<ExtractableField, FieldSource>>;
}

export type ApplicationStatus =
  | 'RECEIVED'
  | 'IDENTIFYING_CANDIDATE'
  | 'WAITING_FOR_DETAILS'
  | 'DOCUMENT_RECEIVED'
  | 'DOWNLOADING'
  | 'AI_PROCESSING'
  | 'VALIDATING'
  | 'DUPLICATE_CHECK'
  | 'UPLOADING_TO_ONEDRIVE'
  | 'CREATING_LINK'
  | 'WRITING_TO_GOOGLE_SHEETS'
  | 'COMPLETED'
  | 'NEEDS_REVIEW'
  | 'RETRY_PENDING'
  | 'FAILED';

export interface Application {
  id: string; // APP-2026-000142
  created_at: string; // ISO
  updated_at: string;
  whatsapp_jid: string;
  whatsapp_number: string; // from WhatsApp API metadata ONLY — never AI-derived
  name: string | null;
  nic: string | null;
  address: string | null;
  cv_phone_number: string | null; // extracted from CV/messages; separate from whatsapp_number
  profession: string | null;
  status: ApplicationStatus;
  review: boolean;
  error: string | null;
  onedrive_file_id: string | null;
  onedrive_url: string | null;
  cv_file_hash: string | null; // sha256
  sheet_row_number: number | null;
  cv_local_path: string | null;
  confirmation_sent: boolean;
}

/** Row-facing record matching the canonical Google Sheets column order. */
export interface CandidateRecord {
  application_id: string;
  datetime: string;
  name: string | null;
  nic: string | null;
  address: string | null;
  whatsapp_number: string;
  cv_phone_number: string | null;
  profession: string | null;
  cv_url: string | null;
  status: ApplicationStatus;
  review: boolean;
  error: string | null;
}

/** Canonical sheet headers — exact order, written by SheetsClient.ensureHeaderRow(). */
export const SHEET_COLUMNS = [
  'Application ID',
  'Date/Time',
  'Name',
  'NIC',
  'Address',
  'WhatsApp Number',
  'CV Phone Number',
  'Profession',
  'CV URL',
  'Status',
  'Review',
  'Error',
] as const;

export interface InboundMessage {
  wa_message_id: string;
  from_jid: string; // e.g. 94771234567@s.whatsapp.net
  from_number: string; // e.g. +94771234567 (metadata-derived, never AI-derived)
  timestamp: string; // ISO
  type: 'text' | 'document' | 'image' | 'audio' | 'video' | 'other';
  text: string | null;
  media_id: string | null;
  media_mime_type: string | null;
  media_filename: string | null;
}

export interface WhatsAppConfig {
  accessToken: string;
  phoneNumberId: string;
  wabaId: string;
  verifyToken: string;
  appSecret?: string;
  apiVersion?: string; // default v21.0
}

export interface OneDriveConfig {
  clientId: string;
  tenantId?: string; // default 'consumers'
  folderRoot: string; // e.g. 'CV Applications'
  tokenCachePath: string;
}

export interface SheetsConfig {
  serviceAccountEmail: string;
  privateKey: string;
  sheetId: string;
  sheetName?: string; // default 'Applications'
}

export interface OpenRouterConfig {
  apiKey: string;
  model: string; // default google/gemini-3.8-flash
  baseUrl?: string; // default https://openrouter.ai/api/v1
}

export interface AppConfig {
  deviceName: string;
  dataDir: string;
  configDir: string;
  logDir: string;
  sessionTimeoutMinutes: number;
  redisUrl: string;
  apiPort: number;
  adminWhatsappNumber: string | null;
  dashboardUrl: string | null;
  mandatoryFields: ExtractableField[];
  whatsapp: WhatsAppConfig | null;
  onedrive: OneDriveConfig | null;
  sheets: SheetsConfig | null;
  openrouter: OpenRouterConfig | null;
}

export interface WhatsAppClientApi {
  sendText(to: string, text: string): Promise<void>;
  markRead(messageId: string): Promise<void>;
}

export interface OneDriveClientApi {
  ensureFolder(path: string): Promise<void>;
  uploadFile(localPath: string, remotePath: string): Promise<{ fileId: string }>;
  createShareLink(fileId: string): Promise<string>;
  verifyFolder(): Promise<void>;
}

export interface SheetsClientApi {
  ensureHeaderRow(): Promise<void>;
  findRowByApplicationId(applicationId: string): Promise<number | null>;
  writeApplicationRow(rec: CandidateRecord): Promise<{ row: number }>;
  verifyAccess(): Promise<void>;
}

/** Queues used by the worker; BullMQ Queue instances keyed by name. */
export const QUEUES = [
  'cv-processing',
  'onedrive',
  'google-sheets',
  'whatsapp-confirm',
] as const;

export type QueueName = (typeof QUEUES)[number];

export function applicationRecordFromApplication(
  app: Application,
): CandidateRecord {
  return {
    application_id: app.id,
    datetime: app.created_at,
    name: app.name,
    nic: app.nic,
    address: app.address,
    whatsapp_number: app.whatsapp_number,
    cv_phone_number: app.cv_phone_number,
    profession: app.profession,
    cv_url: app.onedrive_url,
    status: app.status,
    review: app.review,
    error: app.error,
  };
}
