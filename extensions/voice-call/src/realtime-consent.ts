import { z } from "zod";

/** Opening question used by the explicit realtime consent flow. */
export const REALTIME_VOICE_CONSENT_QUESTION = "Do you consent to this call being recorded?";

export const VoiceCallRealtimeConsentWindowConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    windowMs: z.number().int().positive().default(5000),
  })
  .strict()
  .default({ enabled: false, windowMs: 5000 });
