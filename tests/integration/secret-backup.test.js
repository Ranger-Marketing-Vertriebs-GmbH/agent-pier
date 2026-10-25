import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Backup } from "../../server/features/operations/backup.js";
import { Restore } from "../../server/features/operations/restore.js";
import {
  decryptCredentials,
  encryptCredentials,
} from "../../server/features/operations/archive.js";
import { ProjectMemory } from "../../server/features/memory/project-memory.js";
import { projectScope } from "../../server/features/memory/project-scope.js";
import { SecretStore } from "../../server/features/secrets/secret-store.js";
import {
  captureSecrets,
  restoreSecrets,
  secretsMember,
  secretsPresent,
  secretsOmission,
  secretsRestoreFile,
} from "../../server/features/secrets/secret-backup.js";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { archiveText, encodeArchiveV2, loadArchive } from "../helpers/backup-archive.js";

const passphrase = "secret backup passphrase";
const values = {
  API_TOKEN: "tok-9f3e1c-value",
  DB_PASSWORD: "pw'with$`quotes\\and\nnewline-77ab",
  STRAY_KEY: "stray-4c0d2e-value",
};
const sessionValue = "session-only-value-5e21";

async function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-sec-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "live");
  fs.mkdirSync(dataDir);
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const memory = new ProjectMemory({ dataDir });
  const scope = await memory.register(project);
  memory.close();
  const store = new SecretStore({ dataDir });
  const created = {
    API_TOKEN: store.create({
      name: "API_TOKEN",
      description: "Deploy token",
      projectId: scope.id,
      value: values.API_TOKEN,
    }),
    DB_PASSWORD: store.create({ name: "DB_PASSWORD", value: values.DB_PASSWORD }),
    STRAY_KEY: store.create({
      name: "STRAY_KEY",
      projectId: "project-that-is-not-in-the-backup",
      value: values.STRAY_KEY,
    }),
  };
  store.close();
  // Delivered session files (Task 6) are derived data and never backed up.
  const sessions = path.join(dataDir, "secrets", "sessions");
  fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(sessions, "s1.env"), `X='${sessionValue}'\n`, {
    mode: 0o600,
  });
  return { root, dataDir, scope, created };
}

const sealed = (dataDir, includeHistory = false) =>
  new Backup({ dataDir }).create({ includeHistory, withCredentials: true, passphrase });

function assertNoValues(made) {
  const archive = loadArchive(made.file);
  const text = archiveText(made.file);
  for (const value of [...Object.values(values), sessionValue])
    assert.equal(text.includes(value), false, value);
  for (const member of archive.files) {
    assert.equal(member.path.startsWith("secrets/"), false, member.path);
    const bytes = Buffer.from(member.content, "base64").toString("latin1");
    for (const value of [...Object.values(values), sessionValue])
      assert.equal(bytes.includes(value), false, member.path);
  }
  assert.equal(JSON.stringify(archive.manifest).includes(values.API_TOKEN), false);
  return archive;
}

async function restore(root, dataDir, made, options = {}, name = "restored") {
  const target = path.join(root, name);
  const report = await new Restore({ dataDir }).apply({
    archive: made.file,
    targetDataDir: target,
    passphrase,
    ...options,
  });
  return { target, report };
}

function open(dataDir) {
  const store = new SecretStore({ dataDir });
  try {
    return store.exportSealed().secrets;
  } finally {
    store.close();
  }
}

test("ordinary backup leaves every secret out and lists the omission", async (t) => {
  const { dataDir } = await setup(t);
  const backup = new Backup({ dataDir });
  for (const includeHistory of [false, true]) {
    const plan = backup.plan({ includeHistory });
    assert.ok(plan.omissions.includes(secretsOmission));
    assert.equal(plan.components.includes("sealed-secrets"), false);
    const made = await backup.create({ includeHistory });
    const archive = assertNoValues(made);
    assert.equal(archive.credentials, undefined);
    assert.ok(made.manifest.omissions.includes(secretsOmission));
  }
});

test("a host without secrets lists neither the component nor the omission", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-sec-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const backup = new Backup({ dataDir: root });
  const scope = (plan) => [...plan.components, ...plan.omissions];
  assert.equal(scope(backup.plan({})).includes(secretsOmission), false);
  new SecretStore({ dataDir: root }).close();
  for (const withCredentials of [false, true]) {
    const listed = scope(backup.plan({ withCredentials }));
    assert.equal(listed.includes(secretsOmission), false);
    assert.equal(listed.includes("sealed-secrets"), false);
  }
});

test("credential backup seals the secrets in the capsule only", async (t) => {
  const { dataDir, created } = await setup(t);
  for (const includeHistory of [false, true]) {
    const plan = new Backup({ dataDir }).plan({ includeHistory, withCredentials: true });
    assert.ok(plan.components.includes("sealed-secrets"));
    assert.equal(plan.omissions.includes(secretsOmission), false);
    const made = await sealed(dataDir, includeHistory);
    assert.equal(made.manifest.omissions.includes(secretsOmission), false);
    const archive = assertNoValues(made);
    const opened = await decryptCredentials(archive.credentials, passphrase);
    const under = opened.filter((entry) => entry.path.startsWith("secrets/"));
    assert.deepEqual(
      under.map((entry) => entry.path),
      [secretsMember],
    );
    const value = JSON.parse(Buffer.from(under[0].content, "base64").toString("utf8"));
    assert.equal(value.version, 1);
    assert.deepEqual(
      value.secrets.map((row) => [row.id, row.name, row.value]),
      Object.keys(values).map((name) => [created[name].id, name, values[name]]),
    );
    assert.equal(JSON.stringify(opened).includes(sessionValue), false);
  }
});

test("restore brings the secrets back with their ids and mapped projects", async (t) => {
  const { root, dataDir, scope, created } = await setup(t);
  const made = await sealed(dataDir);
  const moved = path.join(root, "moved");
  fs.mkdirSync(moved);
  const { target, report } = await restore(root, dataDir, made, {
    projectMap: { [scope.id]: moved },
  });
  assert.deepEqual(report.secrets, { restored: 3, withoutProject: 1 });
  for (const value of Object.values(values))
    assert.equal(JSON.stringify(report).includes(value), false);
  assert.equal(fs.existsSync(path.join(target, secretsMember)), false);
  const pending = path.join(target, "secrets", secretsRestoreFile);
  assert.equal(fs.statSync(pending).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(pending)).mode & 0o777, 0o700);
  assert.equal(fs.existsSync(path.join(target, "secrets", "sessions")), false);
  const expected = (await projectScope(moved, { known: false })).id;
  assert.notEqual(expected, scope.id);
  const back = open(target);
  assert.equal(fs.existsSync(pending), false);
  assert.deepEqual(
    back.map((row) => [row.id, row.name, row.value, row.projectId]),
    [
      [created.API_TOKEN.id, "API_TOKEN", values.API_TOKEN, expected],
      [created.DB_PASSWORD.id, "DB_PASSWORD", values.DB_PASSWORD, null],
      [created.STRAY_KEY.id, "STRAY_KEY", values.STRAY_KEY, null],
    ],
  );
  assert.equal(back[0].description, "Deploy token");
  // Without a mapping every project secret comes back without a project.
  const { target: unmapped, report: plain } = await restore(
    root,
    dataDir,
    made,
    {},
    "unmapped",
  );
  assert.deepEqual(plain.secrets, { restored: 3, withoutProject: 2 });
  assert.deepEqual(
    open(unmapped).map((row) => row.projectId),
    [null, null, null],
  );
});

test("restore does not duplicate a secret whose name is taken", async (t) => {
  const { root, dataDir, created } = await setup(t);
  const made = await sealed(dataDir);
  const { target } = await restore(root, dataDir, made);
  const pending = path.join(target, "secrets", secretsRestoreFile);
  const copy = fs.readFileSync(pending);
  open(target);
  // An import interrupted before the file was removed runs again on the next open.
  fs.writeFileSync(pending, copy, { mode: 0o600 });
  assert.equal(open(target).length, 3);
  assert.equal(fs.existsSync(pending), false);
  // Another id under a taken name is skipped; a free name is added with its id.
  const restored = JSON.parse(copy);
  const fresh = "00000000-0000-4000-8000-0000000000aa";
  restored.secrets = [
    { ...restored.secrets[0], id: "00000000-0000-4000-8000-0000000000bb", value: "new" },
    { ...restored.secrets[1], id: fresh, name: "FRESH_NAME" },
  ];
  fs.writeFileSync(pending, JSON.stringify(restored), { mode: 0o600 });
  const back = open(target);
  assert.deepEqual(
    back.map((row) => [row.id, row.name]),
    [
      [created.API_TOKEN.id, "API_TOKEN"],
      [created.DB_PASSWORD.id, "DB_PASSWORD"],
      [fresh, "FRESH_NAME"],
      [created.STRAY_KEY.id, "STRAY_KEY"],
    ],
  );
  assert.equal(back[0].value, values.API_TOKEN);
});

test("restore refuses crafted secret rows", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-sec-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const row = {
    id: "00000000-0000-4000-8000-000000000001",
    name: "GOOD_NAME",
    description: "",
    projectId: null,
    value: "v",
  };
  const other = { ...row, id: "00000000-0000-4000-8000-000000000002" };
  const cases = [
    { version: 2, secrets: [row] },
    { version: 1, secrets: [{ ...row, name: "bad-name" }] },
    { version: 1, secrets: [{ ...row, value: "" }] },
    { version: 1, secrets: [{ ...row, id: "../escape" }] },
    { version: 1, secrets: [{ ...row, projectId: 7 }] },
    // Two secrets under one name, and two under one id.
    { version: 1, secrets: [row, other] },
    { version: 1, secrets: [row, { ...row, name: "OTHER_NAME" }] },
  ];
  for (const value of cases) {
    const stage = fs.mkdtempSync(path.join(root, "stage-"));
    fs.mkdirSync(path.join(stage, "secrets"), { mode: 0o700 });
    fs.writeFileSync(path.join(stage, secretsMember), JSON.stringify(value), {
      mode: 0o600,
    });
    assert.throws(
      () => restoreSecrets(stage, []),
      (error) => error.message === serverMessages.backups.unexpectedComponent,
    );
    assert.equal(fs.existsSync(path.join(stage, secretsMember)), false);
    assert.equal(fs.existsSync(path.join(stage, "secrets", secretsRestoreFile)), false);
  }
  assert.equal(restoreSecrets(fs.mkdtempSync(path.join(root, "empty-")), []), null);
});

test("restore refuses secrets outside the sealed member", async (t) => {
  const { root, dataDir } = await setup(t);
  const ordinary = loadArchive((await new Backup({ dataDir }).create({})).file);
  const credentialed = loadArchive((await sealed(dataDir)).file);
  const opened = await decryptCredentials(credentialed.credentials, passphrase);
  const member = (name, content) => {
    const bytes = Buffer.from(content);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return { path: name, content: bytes.toString("base64"), sha256, mode: 0o600 };
  };
  const sealedJson = opened.find((entry) => entry.path === secretsMember);
  const cases = {
    publicJson: {
      ...ordinary,
      files: [...ordinary.files, { ...sealedJson, mode: 0o600 }],
    },
    publicDatabase: {
      ...ordinary,
      files: [...ordinary.files, member("secrets/secrets.sqlite", "SQLite format 3")],
    },
    sealedDatabase: {
      ...credentialed,
      credentials: await encryptCredentials(
        [...opened, member("secrets/secrets.sqlite", "SQLite format 3")],
        passphrase,
      ),
    },
  };
  for (const [name, archive] of Object.entries(cases)) {
    const file = path.join(root, `${name}.tar.gz`);
    fs.writeFileSync(file, encodeArchiveV2(archive));
    const target = path.join(root, `target-${name}`);
    await assert.rejects(
      new Restore({ dataDir }).apply({
        archive: file,
        targetDataDir: target,
        passphrase,
      }),
      { message: serverMessages.backups.unexpectedComponent },
      name,
    );
    assert.equal(fs.existsSync(target), false, name);
  }
});

test("secrets a restore left pending count as present", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-sec-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "secrets"), { mode: 0o700 });
  const row = {
    id: "00000000-0000-4000-8000-000000000001",
    name: "PENDING_NAME",
    description: "",
    projectId: null,
    value: values.API_TOKEN,
  };
  fs.writeFileSync(
    path.join(root, "secrets", secretsRestoreFile),
    JSON.stringify({ version: 1, secrets: [row] }),
    { mode: 0o600 },
  );
  assert.equal(secretsPresent(root), true);
  assert.deepEqual(
    captureSecrets(root).secrets.map((entry) => entry.name),
    ["PENDING_NAME"],
  );
});
