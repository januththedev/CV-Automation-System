import { z } from 'zod';
import { loadConfig } from '../../config.js';
import type { ExtractedCandidate, ExtractableField, OpenRouterConfig } from '../../contracts.js';
import { EXTRACTION_SYSTEM_PROMPT, STRUCTURED_RETRY_SUFFIX } from '../../ai/prompts.js';
import { chatJSON, InvalidJSONError, type ChatOptions } from './client.js';
import { extractedCandidateSchema, extractableFieldSchema } from './schemas.js';

export type { ExtractedCandidate } from '../../contracts.js';
export interface ExtractionInput {
  cvText: string | null;
  cvFilename: string | null;
  messages: { text: string; at: string }[];
}
export interface ExtractionOptions extends ChatOptions { mandatoryFields?: ExtractableField[] }
const fields: ExtractableField[] = ['name', 'nic', 'address', 'cv_phone_number', 'profession'];
const inputSchema = z.object({
  cvText: z.string().max(100_000).nullable(),
  cvFilename: z.string().max(255).nullable(),
  messages: z.array(z.object({ text: z.string().max(10_000), at: z.string().max(64).refine(v => Number.isFinite(Date.parse(v))) }).strict()).max(100),
}).strict();

function normalized(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}
function grounded(value: string, text: string, field: ExtractableField): boolean {
  if (field === 'cv_phone_number' || field === 'nic') {
    return text.split(/\r?\n/).some(line => line.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
      .includes(value.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()));
  }
  return normalized(text).includes(normalized(value));
}

/** Fresh config per extraction; optional explicit config isolates tests from disk/environment. */
export async function extractCandidateData(input: ExtractionInput, explicitConfig?: OpenRouterConfig, options: ExtractionOptions = {}): Promise<ExtractedCandidate> {
  const runtime = explicitConfig ? null : loadConfig();
  const cfg = explicitConfig ?? runtime?.openrouter;
  const mandatory = z.array(extractableFieldSchema).parse(options.mandatoryFields ?? runtime?.mandatoryFields ?? ['name', 'cv_phone_number']);
  const validated = inputSchema.parse(input);
  const messages = [...validated.messages].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const cvText = validated.cvText?.trim() || null;
  const cvFilename = validated.cvFilename?.trim() || null;
  const cvPresent = !!(cvFilename || cvText);
  const unreadableCV = cvPresent && !cvText;
  const user = JSON.stringify({ cvText, cvFilename, messages });
  if (user.length > 180_000) throw new Error('Candidate input exceeds total length limit');
  const reasons: string[] = [];
  if (unreadableCV) reasons.push('CV has no readable text; OCR or manual review of the original is required.');

  let result: ExtractedCandidate = {
    name: null, nic: null, address: null, cv_phone_number: null, profession: null,
    cv_present: cvPresent, cv_filename: cvFilename, missing_fields: [], needs_review: false, review_reason: null, source: {},
  };
  if (cvText || messages.some(message => message.text.trim())) {
    if (!cfg) throw new Error('OpenRouter is not configured');
    // A malformed output gets one repair attempt; provider failures belong to the job retry layer.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        result = extractedCandidateSchema.parse(await chatJSON(
          EXTRACTION_SYSTEM_PROMPT + (attempt ? STRUCTURED_RETRY_SUFFIX : ''), user, cfg, options,
        ));
        break;
      } catch (error) {
        if (!(error instanceof InvalidJSONError) && !(error instanceof z.ZodError)) throw error;
        if (attempt === 1) throw new InvalidJSONError();
      }
    }
  }
  if (result.needs_review) reasons.push('Model flagged ambiguous candidate details for manual review.');
  const messageText = messages.map(message => message.text).join('\n');
  for (const field of fields) {
    result[field] = result[field]?.trim() || null;
    const value = result[field];
    if (value === null) { delete result.source[field]; continue; }
    const source = result.source[field];
    const inCV = !!cvText && grounded(value, cvText, field);
    const inMessages = grounded(value, messageText, field);
    if (!source || (source === 'cv' && !inCV) || (source === 'whatsapp' && !inMessages) || (source === 'mixed' && !(inCV && inMessages))) {
      result[field] = null;
      delete result.source[field];
      reasons.push(`Unsupported source evidence for ${field}.`);
    }
  }
  if (result.nic && !/^(?:\d{9}[vVxX]|\d{12})$/.test(result.nic)) {
    result.nic = null; delete result.source.nic; reasons.push('NIC format requires manual review.');
  }
  if (result.cv_phone_number && (!/^\+?[\d\s().-]+$/.test(result.cv_phone_number) || result.cv_phone_number.replace(/\D/g, '').length < 7 || result.cv_phone_number.replace(/\D/g, '').length > 15)) {
    result.cv_phone_number = null; delete result.source.cv_phone_number; reasons.push('Candidate phone format requires manual review.');
  }
  // Computed facts are never trusted to the model (including apparently plausible metadata).
  result.cv_present = cvPresent;
  result.cv_filename = cvFilename;
  result.missing_fields = fields.filter(field => result[field] === null);
  const missingRequired = result.missing_fields.filter(field => mandatory.includes(field));
  if (missingRequired.length) reasons.push(`Missing required fields: ${missingRequired.join(', ')}.`);
  result.needs_review = reasons.length > 0;
  result.review_reason = reasons.length ? reasons.join(' ').slice(0, 1_000) : null;
  return extractedCandidateSchema.parse(result);
}
