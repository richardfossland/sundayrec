/**
 * Static fallback for the redesigned `SettingsScreen`.
 *
 * `settings_get` rejects in the dev/test env (no Tauri backend), so the screen
 * needs a complete, type-safe default to render against without crashing. The
 * values mirror the per-field `#[serde(default)]` documented in
 * `@/lib/bindings/Settings` (the Electron `store.get(key, default)` heritage),
 * so the UI shows the same out-of-the-box state the backend would.
 */
import { open } from "@tauri-apps/plugin-dialog";

import type { Settings } from "@/lib/bindings/Settings";

/**
 * Open a native folder picker and return the chosen absolute path, or `null`
 * if the user cancelled or the dialog is unavailable (dev/test env). Never
 * throws — a cancelled/erroring dialog must not crash the settings screen.
 */
export async function pickFolder(): Promise<string | null> {
  try {
    const result = await open({ directory: true, multiple: false });
    return typeof result === "string" ? result : null;
  } catch {
    return null;
  }
}

export const DEFAULT_SETTINGS: Settings = {
  language: null,
  hasLaunched: false,
  onboardingDone: false,
  deviceId: null,
  deviceName: null,
  videoEnabled: false,
  videoDeviceName: null,
  videoDeviceIndex: null,
  videoResolution: "720p",
  videoFramerate: 30,
  outputMode: "combined",
  keepSeparateAudio: false,
  avSync: true,
  channels: "stereo",
  sampleRate: 48000,
  inputVolume: 100,
  eqEnabled: false,
  eqBass: 0,
  eqMid: 0,
  eqTreble: 0,
  compEnabled: false,
  compThreshold: -24,
  compRatio: 4,
  compAttack: 10,
  compRelease: 200,
  limiterEnabled: true,
  limiterCeiling: -1,
  format: "wav",
  bitrate: "192",
  filenamePattern: "church",
  saveFolder: null,
  autoDeleteDays: 90,
  stopOnSilence: true,
  silenceThreshold: -50,
  silenceTimeoutMinutes: 5,
  splitMinutes: 0,
  trimSilence: false,
  manualMaxMinutes: 0,
  preRollSeconds: 5,
  reminderMinutes: 10,
  launchAtLogin: true,
  showOnStartup: true,
  minimizeToTray: true,
  wakeFromSleep: true,
  protectRecording: true,
  slots: [],
  specialRecordings: [],
  churchName: "",
  responsiblePerson: "",
  notifyStart: true,
  notifyStop: true,
  webhookUrl: "",
  webhookOnWarning: false,
  emailOnError: false,
  emailAddress: "",
  emailSmtp: "",
  emailSmtpPort: 587,
  emailSmtpUser: "",
  editorIntroPath: null,
  editorOutroPath: null,
  autoUpdate: true,
  askOpenEditor: true,
};
