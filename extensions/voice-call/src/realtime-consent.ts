import { z } from "zod";

/** Opening question used by the explicit realtime consent flow. */
export const REALTIME_VOICE_CONSENT_QUESTION = "Do you consent to this call being recorded?";

const CONSENT_TOPIC = /\bconsent\b/i;
const RECORDING_TOPIC = /\brecord/i;

/**
 * True when a completed assistant turn is the opening recording-consent question rather than some
 * other opening remark. The watchdog must arm only after the question was actually asked, so a
 * provider that opens with something else cannot have a live call ended on silence.
 */
export function isConsentQuestionUtterance(transcript: string): boolean {
  const text = transcript.trim();
  if (!text) {
    return false;
  }
  if (text.includes(REALTIME_VOICE_CONSENT_QUESTION)) {
    return true;
  }
  return CONSENT_TOPIC.test(text) && RECORDING_TOPIC.test(text);
}

export const VoiceCallRealtimeConsentWindowConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    windowMs: z.number().int().positive().default(5000),
  })
  .strict()
  .default({ enabled: false, windowMs: 5000 });
