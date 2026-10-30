import { assistantProblem } from "../assistants/assistant-validation.js";

// The voices OpenAI's gpt-4o-mini-tts speaks (https://platform.openai.com/docs/guides/text-to-speech).
export const openaiVoices = Object.freeze([
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
]);
export const voiceProviders = Object.freeze(["openai", "elevenlabs"]);
export const voiceDefaults = Object.freeze({
  provider: "openai",
  openaiVoice: "coral",
  // ElevenLabs' premade voice "George", multilingual.
  elevenlabsVoice: "JBFqnCBsd6RMkjVDRZzb",
});
const inputKeys = [
  "revision",
  "provider",
  "openaiVoice",
  "elevenlabsVoice",
  "openaiApiKey",
  "removeOpenaiApiKey",
  "elevenlabsApiKey",
  "removeElevenlabsApiKey",
];
const validKey = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 1024 &&
  !/[^\x21-\x7e]/.test(value);

/**
 * The voice that reads agent replies aloud (speech-output.js): the provider, its voice
 * and one API key per provider. Kept in the speech connection's private database
 * (speech-connections.js) beside the Deepgram key; a key is written and used here but
 * never returned: `get()` only says whether one is stored.
 */
export class VoiceConnections {
  constructor(db) {
    this.db = db;
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS voice_settings(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, provider TEXT NOT NULL, openai_voice TEXT NOT NULL, elevenlabs_voice TEXT NOT NULL);
       INSERT OR IGNORE INTO voice_settings VALUES (1,0,'${voiceDefaults.provider}','${voiceDefaults.openaiVoice}','${voiceDefaults.elevenlabsVoice}');
       CREATE TABLE IF NOT EXISTS voice_credentials(provider TEXT PRIMARY KEY, api_key TEXT NOT NULL);`,
    );
  }
  keys() {
    const rows = this.db.prepare("SELECT provider FROM voice_credentials").all();
    return new Set(rows.map((row) => row.provider));
  }
  get() {
    const row = this.db.prepare("SELECT * FROM voice_settings WHERE id=1").get();
    const keys = this.keys();
    return {
      revision: row.revision,
      provider: row.provider,
      openaiVoice: row.openai_voice,
      elevenlabsVoice: row.elevenlabs_voice,
      hasOpenaiKey: keys.has("openai"),
      hasElevenlabsKey: keys.has("elevenlabs"),
    };
  }
  /** Whether the chosen provider can speak now, or why not. */
  status() {
    const settings = this.get();
    const ready =
      settings.provider === "openai" ? settings.hasOpenaiKey : settings.hasElevenlabsKey;
    return ready
      ? { available: true, provider: settings.provider }
      : { available: false, provider: settings.provider, reason: "voiceMissing" };
  }
  save(input) {
    const current = this.get();
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => !inputKeys.includes(key))
    )
      throw assistantProblem("invalid");
    if (input.revision !== current.revision) throw assistantProblem("conflict", 409);
    const next = {
      provider: input.provider ?? current.provider,
      openaiVoice: input.openaiVoice ?? current.openaiVoice,
      elevenlabsVoice: input.elevenlabsVoice ?? current.elevenlabsVoice,
    };
    const writes = [
      ["openai", input.openaiApiKey, input.removeOpenaiApiKey],
      ["elevenlabs", input.elevenlabsApiKey, input.removeElevenlabsApiKey],
    ];
    if (
      !voiceProviders.includes(next.provider) ||
      !openaiVoices.includes(next.openaiVoice) ||
      !/^[A-Za-z0-9]{8,64}$/.test(next.elevenlabsVoice) ||
      writes.some(
        ([, key, remove]) =>
          (key !== undefined && !validKey(key)) ||
          (remove !== undefined && typeof remove !== "boolean") ||
          (key !== undefined && remove),
      )
    )
      throw assistantProblem("invalid");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const [provider, key, remove] of writes) {
        if (key)
          this.db
            .prepare(
              "INSERT INTO voice_credentials VALUES(?,?) ON CONFLICT(provider) DO UPDATE SET api_key=excluded.api_key",
            )
            .run(provider, key);
        if (remove)
          this.db.prepare("DELETE FROM voice_credentials WHERE provider=?").run(provider);
      }
      const changed = this.db
        .prepare(
          "UPDATE voice_settings SET revision=revision+1,provider=?,openai_voice=?,elevenlabs_voice=? WHERE id=1 AND revision=?",
        )
        .run(next.provider, next.openaiVoice, next.elevenlabsVoice, input.revision);
      if (!changed.changes) throw assistantProblem("conflict", 409);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.get();
  }
  /** The chosen provider with its voice and key, for one synthesis; null without key. */
  acquire() {
    const settings = this.get();
    const row = this.db
      .prepare("SELECT api_key FROM voice_credentials WHERE provider=?")
      .get(settings.provider);
    if (!row) return null;
    return {
      provider: settings.provider,
      voice:
        settings.provider === "openai" ? settings.openaiVoice : settings.elevenlabsVoice,
      apiKey: row.api_key,
    };
  }
}
