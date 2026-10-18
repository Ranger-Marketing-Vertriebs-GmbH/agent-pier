import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { writeArchive } from "../../server/features/operations/archive-v2.js";
import { encryptCredentials } from "../../server/features/operations/archive.js";
import { fileMember } from "../../server/features/operations/snapshot.js";
import {
  SEAL_MEMBER,
  sealHistory,
} from "../../server/features/operations/history-seal.js";
import { Restore } from "../../server/features/operations/restore.js";
import { RunStore } from "../../server/features/pipelines/run-store.js";
import {
  artifactIds,
  artifactIndex,
  generations,
  marker,
  passphrase,
} from "../helpers/private-content-fixture.js";

// Backups before AGENTPIER-110 (seal record version 2, or no passphrase) held agent
// chats and workspaces, pipeline history and unpinned artifacts as public members.
function setup(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-private-legacy-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const live = path.join(root, "live");
  fs.mkdirSync(live);
  // A pipeline history database as older backups archived it.
  const source = path.join(root, "source");
  fs.mkdirSync(source);
  const runs = new RunStore(source);
  runs.create({
    id: "run",
    status: "completed",
    task: marker,
    nodes: [],
    executionLog: [],
  });
  runs.close();
  const { index, files } = artifactIndex();
  const publicFiles = {
    "accounts.json": "[]",
    "pipeline-runs/runs.sqlite": fs.readFileSync(
      path.join(source, "pipeline-runs/runs.sqlite"),
    ),
    "artifacts/index.json": JSON.stringify(index),
    ...files,
    "assistants/workspaces/home/MEMORY.md": `remember ${marker}`,
    "assistants/state/agents/home/sessions/s1.jsonl": `{"t":"${marker}"}\n`,
  };
  return { root, restore: new Restore({ dataDir: live }), publicFiles };
}

/** An archive with `publicFiles`, and with `version` a seal record over `sealed`. */
async function archive(root, name, { publicFiles, version, sealed = [] }) {
  const sources = sealed.map((item, index) => {
    const file = path.join(root, `${name}-${index}.src`);
    fs.writeFileSync(file, "{}\n");
    return { path: item, file, size: 3 };
  });
  const history = sealHistory("backup-id", sources);
  const record = JSON.parse(Buffer.from(history.record.content, "base64"));
  const file = path.join(root, `${name}.apbackup`);
  await writeArchive(file, {
    manifest: {
      createdAt: "2026-10-17T10:00:00.000Z",
      applicationVersion: "2.9.0",
      includeHistory: Boolean(version),
      withCredentials: Boolean(version),
      consistency: "per-component-snapshots; independent-native-captures",
      omissions: [],
      captures: [],
    },
    ...(version && {
      capsule: await encryptCredentials(
        [fileMember(SEAL_MEMBER, { ...record, version })],
        passphrase,
      ),
    }),
    members: [
      ...Object.entries(publicFiles).map(([member, content]) => ({
        path: member,
        bytes: Buffer.from(content),
      })),
      ...(version ? history.members : []),
    ],
  });
  return file;
}

function assertRestored(target) {
  assert.equal(
    fs.readFileSync(path.join(target, "assistants/workspaces/home/MEMORY.md"), "utf8"),
    `remember ${marker}`,
  );
  assert.ok(
    fs.existsSync(path.join(target, "assistants/state/agents/home/sessions/s1.jsonl")),
  );
  const index = JSON.parse(fs.readFileSync(path.join(target, "artifacts/index.json")));
  assert.equal(index.records[artifactIds.unpinned].pinned, false);
  assert.equal(
    fs.readFileSync(
      path.join(target, `artifacts/generations/${generations.unpinned}/0`),
      "utf8",
    ),
    `<h1>${marker}</h1>`,
  );
  const runs = new RunStore(target);
  try {
    assert.equal(runs.get("run").imported.historyOnly, true);
  } finally {
    runs.close();
  }
}

test("older archives with public private content still restore", async (t) => {
  const { root, restore, publicFiles } = setup(t);
  // Without a passphrase, and beside a version 2 seal record.
  const plain = await archive(root, "plain", { publicFiles });
  const target = path.join(root, "plain-restored");
  const report = await restore.apply({ archive: plain, targetDataDir: target });
  assert.equal(report.importedRuns, 1);
  assertRestored(target);
  const sealed = await archive(root, "sealed-v2", {
    publicFiles,
    version: 2,
    sealed: ["sessions/s2.screen"],
  });
  const second = path.join(root, "v2-restored");
  await restore.apply({ archive: sealed, targetDataDir: second, passphrase });
  assertRestored(second);
  assert.equal(fs.readFileSync(path.join(second, "sessions/s2.screen"), "utf8"), "{}\n");
});

test("a version 2 seal record cannot seal private content", async (t) => {
  const { root, restore } = setup(t);
  const file = await archive(root, "v2-private", {
    publicFiles: { "accounts.json": "[]" },
    version: 2,
    sealed: ["pipeline-runs/runs.sqlite"],
  });
  const target = path.join(root, "target-v2-private");
  await assert.rejects(
    restore.apply({ archive: file, targetDataDir: target, passphrase }),
    {
      message: serverMessages.backups.historyAuthenticationFailed,
    },
  );
  assert.equal(fs.existsSync(target), false);
});

test("beside a version 3 seal record, public private content is refused", async (t) => {
  const { root, restore, publicFiles } = setup(t);
  for (const member of [
    "pipeline-runs/runs.sqlite",
    "assistants/workspaces/home/MEMORY.md",
    "assistants/state/agents/home/sessions/s1.jsonl",
  ]) {
    const name = member.replace(/\W+/g, "-");
    const file = await archive(root, name, {
      publicFiles: { "accounts.json": "[]", [member]: publicFiles[member] },
      version: 3,
      sealed: ["sessions/s2.screen"],
    });
    const target = path.join(root, `target-${name}`);
    await assert.rejects(
      restore.apply({ archive: file, targetDataDir: target, passphrase }),
      { message: serverMessages.backups.unexpectedComponent },
      member,
    );
    assert.equal(fs.existsSync(target), false, member);
  }
  // A sealed member may not take the path of a public one either.
  const file = await archive(root, "overlap", {
    publicFiles: { "accounts.json": "[]", "assistants/state/notes.json": "{}" },
    version: 3,
    sealed: ["assistants/state/notes.json"],
  });
  await assert.rejects(
    restore.apply({
      archive: file,
      targetDataDir: path.join(root, "target-overlap"),
      passphrase,
    }),
    { message: serverMessages.backups.unexpectedComponent },
  );
});
