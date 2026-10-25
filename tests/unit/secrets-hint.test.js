import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SECRETS_FILE_ENV,
  secretsHint,
  secretsReminder,
} from "../../server/features/secrets/secrets-hint.js";
import { SSH_HINT_ENV, sshReminder } from "../../server/features/ssh/ssh-hook.js";
import AgentPierSsh from "../../server/features/ssh/ssh-opencode.js";

const hook = fileURLToPath(
  new URL("../../server/features/ssh/ssh-hook.js", import.meta.url),
);

function secretsFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "secrets-hint-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "secrets.env");
  fs.writeFileSync(file, "# Managed by AgentPier.\nA='b'\n", { mode: 0o600 });
  return file;
}

test("the secrets reminder names the file and how to load it", () => {
  assert.equal(SECRETS_FILE_ENV, "AGENTPIER_SECRETS_FILE");
  assert.equal(
    secretsReminder("/data/secrets/sessions/s/secrets.env"),
    "AgentPier secrets for this session are in /data/secrets/sessions/s/secrets.env. When a task needs them, load them in the same shell command with `set -a; . '/data/secrets/sessions/s/secrets.env'; set +a`. Never print, log, commit or paste their values.",
  );
});

test("the hint is given only for a set variable naming an existing file", (t) => {
  const file = secretsFile(t);
  assert.equal(secretsHint(file), ` ${secretsReminder(file)}`);
  assert.equal(secretsHint(undefined), "");
  assert.equal(secretsHint(""), "");
  assert.equal(secretsHint(path.join(path.dirname(file), "missing.env")), "");
});

test("the SSH start hint carries the secrets hint only when the file exists", (t) => {
  const file = secretsFile(t);
  const plain = sshReminder("", { sftp: false, secretsFile: undefined });
  assert.equal(plain.includes("AgentPier secrets"), false);
  assert.equal(
    sshReminder("", { sftp: false, secretsFile: file }),
    `${plain} ${secretsReminder(file)}`,
  );
  assert.equal(sshReminder("", { sftp: false, secretsFile: `${file}.gone` }), plain);
});

test("the session start hook reads the variable when it runs", (t) => {
  const file = secretsFile(t);
  const run = (env) =>
    JSON.parse(
      spawnSync(process.execPath, [hook], {
        input: "{}",
        env: { PATH: process.env.PATH, ...env },
        encoding: "utf8",
      }).stdout,
    ).hookSpecificOutput.additionalContext;
  assert.ok(run({ [SECRETS_FILE_ENV]: file }).endsWith(` ${secretsReminder(file)}`));
  assert.equal(run({}).includes("AgentPier secrets"), false);
  fs.rmSync(file);
  assert.equal(run({ [SECRETS_FILE_ENV]: file }).includes("AgentPier secrets"), false);
});

test("a path with a quote stays one sh word in the load command", () => {
  assert.match(
    secretsReminder("/data/it's/secrets.env"),
    /`set -a; \. '\/data\/it'\\''s\/secrets\.env'; set \+a`/,
  );
});

test("a hook registered for the secrets alone names only the secrets file", (t) => {
  const file = secretsFile(t);
  const run = (env) =>
    spawnSync(process.execPath, [hook], {
      input: "{}",
      env: { PATH: process.env.PATH, [SSH_HINT_ENV]: "0", ...env },
      encoding: "utf8",
    }).stdout;
  assert.equal(
    JSON.parse(run({ [SECRETS_FILE_ENV]: file })).hookSpecificOutput.additionalContext,
    secretsReminder(file),
  );
  fs.rmSync(file);
  assert.equal(run({ [SECRETS_FILE_ENV]: file }), "");
});

test("the opencode plugin follows the secrets file on every turn", async (t) => {
  const file = secretsFile(t);
  const saved = { file: process.env[SECRETS_FILE_ENV], hint: process.env[SSH_HINT_ENV] };
  t.after(() => {
    for (const [key, value] of [
      [SECRETS_FILE_ENV, saved.file],
      [SSH_HINT_ENV, saved.hint],
    ])
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  process.env[SECRETS_FILE_ENV] = file;
  const plugin = await AgentPierSsh();
  const turn = async () => {
    const output = { system: [] };
    await plugin["experimental.chat.system.transform"]({}, output);
    return output.system;
  };
  assert.ok((await turn())[0].endsWith(` ${secretsReminder(file)}`));
  process.env[SSH_HINT_ENV] = "0";
  assert.deepEqual(await turn(), [secretsReminder(file)]);
  fs.rmSync(file);
  assert.deepEqual(await turn(), []);
  delete process.env[SSH_HINT_ENV];
  assert.equal((await turn())[0].includes("AgentPier secrets"), false);
});
