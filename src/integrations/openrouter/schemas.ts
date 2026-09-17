import { z } from 'zod';

/** Strict allowlist: nothing else accepted; missing stays null, never a guess. */
export const fieldSourceSchema = z.enum(['cv', 'whatsapp', 'mixed']);
export const extractableFieldSchema = z.enum(['name', 'nic', 'address', 'cv_phone_number', 'profession']);
const limited = (max: number) => z.string().max(max);

export const extractedCandidateSchema = z.object({
  name: limited(200).nullable(),
  nic: limited(20).nullable(),
  address: limited(2_000).nullable(),
  cv_phone_number: limited(32).nullable(),
  profession: limited(200).nullable(),
  cv_present: z.boolean(),
  cv_filename: limited(255).nullable(),
  missing_fields: z.array(extractableFieldSchema),
  needs_review: z.boolean(),
  review_reason: limited(1_000).nullable(),
  source: z.record(extractableFieldSchema, fieldSourceSchema),
}).strict();
export type ExtractedCandidateParsed = z.infer<typeof extractedCandidateSchema>;
