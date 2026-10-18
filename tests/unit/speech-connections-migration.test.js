import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SpeechConnections } from "../../server/features/speech/speech-connections.js";

// The schema and seed statement of builds before dictation, verbatim.
const oldSchema =
  "CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, model TEXT NOT NULL, language TEXT NOT NULL); CREATE TABLE IF NOT EXISTS credentials(id INTEGER PRIMARY KEY CHECK(id=1), api_key TEXT NOT NULL); INSERT OR IGNORE INTO settings VALUES (1,0,'nova-3','auto'); CREATE TABLE IF NOT EXISTS key_state(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL); INSERT OR IGNORE INTO key_state VALUES (1,0);";

test("an older speech database keeps its settings and stays readable by older builds", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-speech-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const file = path.join(dataDir, "speech", "connections.sqlite");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const old = new DatabaseSync(file);
  old.exec(oldSchema);
  old.exec(
    "UPDATE settings SET revision=3, model='nova-2', language='de'; INSERT INTO credentials VALUES (1,'old-key')",
  );
  old.close();
  fs.chmodSync(file, 0o600);

  const speech = new SpeechConnections({ dataDir });
  assert.deepEqual(speech.get(), {
    id: "deepgram",
    provider: "deepgram",
    revision: 3,
    model: "nova-2",
    language: "de",
    dictationSend: false,
    hasSecret: true,
  });
  assert.equal(speech.save({ revision: 3, dictationSend: true }).dictationSend, true);
  speech.close();

  // An older build opened after the upgrade (a rollback) still runs its seed
  // statement and reads the same settings.
  const rollback = new DatabaseSync(file);
  rollback.exec(oldSchema);
  assert.deepEqual(
    { ...rollback.prepare("SELECT * FROM settings WHERE id=1").get() },
    { id: 1, revision: 4, model: "nova-2", language: "de" },
  );
  rollback.close();
  const reopened = new SpeechConnections({ dataDir });
  assert.equal(reopened.get().dictationSend, true);
  reopened.close();
});
