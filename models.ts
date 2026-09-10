// Shared between server.ts and the frontend (plain data, no dependencies).
export const LIVE_MODEL = "gpt-live-1" as const;

export const BACKEND_MODEL_OPTIONS = ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.6-sol"] as const;
export type BackendModel = (typeof BACKEND_MODEL_OPTIONS)[number];
export const DEFAULT_BACKEND_MODEL: BackendModel = "gpt-5.6-terra";

export const LIVE_RATE_PER_MINUTE = 0.05;
export const BACKEND_RATES: Record<BackendModel, { input: number; cached: number; output: number }> = {
  "gpt-5.6-terra": { input: 2, cached: 0.2, output: 12 },
  "gpt-5.6-luna": { input: 0.2, cached: 0.02, output: 1.2 },
  "gpt-5.6-sol": { input: 4, cached: 0.4, output: 20 },
};

export const VOICE_OPTIONS = [
  "marin", "cedar", "quartz", "ripple", "vesper", "willow", "stone", "gleam", "meridian", "bossa", "tempo", "beacon", "delta", "cinder",
  "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse",
] as const;
export type Voice = (typeof VOICE_OPTIONS)[number];
export const VOICE_DESCRIPTIONS: Record<Voice, string> = {
  marin: "", cedar: "", quartz: "Australian, feminine", ripple: "", vesper: "", willow: "", stone: "", gleam: "", meridian: "", bossa: "Brazilian Portuguese, feminine", tempo: "", beacon: "", delta: "", cinder: "", alloy: "", ash: "", ballad: "", coral: "", echo: "", sage: "", shimmer: "", verse: "",
};
export const DEFAULT_VOICE: Voice = "marin";
export const RECOMMENDED_VOICES: readonly Voice[] = ["marin", "cedar"];

export function isVoice(value: unknown): value is Voice {
  return typeof value === "string" && (VOICE_OPTIONS as readonly string[]).includes(value);
}
export function isBackendModel(value: unknown): value is BackendModel {
  return typeof value === "string" && (BACKEND_MODEL_OPTIONS as readonly string[]).includes(value);
}
