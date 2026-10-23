import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { toolError } from "../../server/features/assistants/tool-errors.js";
import { hostId, sftpHostId, waitFor } from "../helpers/agent-ssh-fixture.js";
import { PASSWORD, code, setup, until } from "../helpers/agent-sftp-fixture.js";
import { partFiles, tree } from "../helpers/sftp-transfer-fixture.js";

test("list and stat run in approval mode without a card", async (t) => {
  const f = await setup(t);
  f.access([{ accessId: sftpHostId, mode: "approval" }]);
  f.file(f.server.root, "www/index.html", "<h1>hi</h1>");
  const listed = await f.sftpCall(f.ownTurn(), { action: "list", remotePath: "/www" });
  assert.deepEqual(
    listed.entries.map((e) => [e.name, e.type, e.size]),
    [["index.html", "file", 11]],
  );
  assert.equal(listed.untrusted, true);
  assert.equal(listed.host, "site");
  const stat = await f.sftpCall(f.ownTurn(), {
    action: "stat",
    remotePath: "/www/index.html",
  });
  assert.equal(stat.type, "file");
  assert.equal(stat.size, 11);
  // Reads leave no row and no audit; nothing waits for the owner.
  assert.deepEqual(f.rows(), []);
  assert.deepEqual(f.sftpAudit(), []);
});

test("a download into the workspace runs in approval mode and leaves a row", async (t) => {
  const f = await setup(t);
  f.access([{ accessId: sftpHostId, mode: "approval" }]);
  f.file(f.server.root, "www/a.txt", "a");
  f.file(f.server.root, "www/sub/b.txt", "bb");
  const result = await f.sftpCall(f.ownTurn(), {
    action: "download",
    remotePath: "/www",
    localPath: "backup",
  });
  assert.equal(result.status, "completed");
  assert.equal(result.files, 2);
  assert.equal(result.bytes, 3);
  assert.deepEqual(tree(path.join(f.workspace, "backup")), {
    "a.txt": "a",
    "sub/b.txt": "bb",
  });
  const [row] = f.rows();
  assert.equal(row.state, "completed");
  assert.equal(row.payload.operation, "download");
  assert.deepEqual(row.payload.local, {
    projectId: null,
    projectName: null,
    path: "backup",
  });
  assert.equal(result.jobId, row.id);
  const [event] = f.sftpAudit();
  assert.equal(event.action, "sftp.completed");
  assert.equal(event.details.authorizedBy, "mode");
  assert.equal(event.details.mode, "approval");
});

test("download into a read-only project is refused", async (t) => {
  const f = await setup(t);
  f.access([{ accessId: sftpHostId, mode: "trusted" }], { [f.folderProject.id]: "read" });
  f.file(f.server.root, "a.txt", "a");
  const download = (extra = {}) =>
    f.sftpCall(f.ownTurn(), {
      action: "download",
      remotePath: "/a.txt",
      projectId: f.folderProject.id,
      ...extra,
    });
  assert.equal(await code(download()), "PROJECT_READ_ONLY");
  assert.equal(
    await code(download({ projectId: "unknown-project" })),
    "PROJECT_NOT_GRANTED",
  );
  assert.deepEqual(tree(f.folder), {});
  // An upload only reads the folder, so read access is enough.
  f.file(f.folder, "site/index.html", "x");
  const up = await f.sftpCall(f.ownTurn(), {
    action: "upload",
    localPath: "site",
    remotePath: "/site",
    projectId: f.folderProject.id,
  });
  assert.equal(up.status, "completed");
  assert.equal(fs.readFileSync(path.join(f.server.root, "site/index.html"), "utf8"), "x");
  // With read and write the download lands, but only while the tool guard holds.
  f.access([{ accessId: sftpHostId, mode: "trusted" }], {
    [f.folderProject.id]: "write",
  });
  f.guard.live = false;
  assert.equal(await code(download()), "PROJECT_WRITE_UNAVAILABLE");
  f.guard.live = true;
  assert.equal((await download()).status, "completed");
  assert.equal(fs.readFileSync(path.join(f.folder, "a.txt"), "utf8"), "a");
  assert.equal(f.rows().at(-1).payload.local.projectName, f.folderProject.name);
});

test("trusted upload runs and leaves one row and one audit event", async (t) => {
  const f = await setup(t);
  f.access([{ accessId: sftpHostId, mode: "trusted" }]);
  f.file(f.workspace, "site/index.html", "<h1>new</h1>");
  f.file(f.workspace, "site/.env", "SECRET=1");
  const result = await f.sftpCall(f.ownTurn(), {
    action: "upload",
    localPath: "site",
    remotePath: "/www",
  });
  assert.equal(result.status, "completed");
  assert.equal(result.files, 1);
  assert.equal(result.created, 1);
  assert.deepEqual(tree(f.server.root), { "www/index.html": "<h1>new</h1>" });
  const rows = f.rows();
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.state, "completed");
  assert.equal(row.settled, true);
  assert.equal(row.payload.trusted, true);
  assert.equal(row.payload.operation, "upload");
  assert.equal(row.payload.direction, "up");
  assert.equal(row.payload.accessId, sftpHostId);
  assert.equal(row.payload.hostName, "site");
  assert.equal(row.payload.remotePath, "/www");
  assert.equal(row.payload.originClass, "owner");
  assert.equal(row.payload.summary.files, 1);
  assert.equal(row.result.files, 1);
  assert.ok(row.chatNotes.started.at > 0);
  assert.ok(row.chatNotes.result.at >= row.chatNotes.started.at);
  const events = f.sftpAudit();
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "sftp.completed");
  assert.equal(events[0].resourceType, "ssh");
  assert.equal(events[0].details.assistantId, f.id);
  assert.equal(events[0].details.originClass, "owner");
  assert.equal(events[0].details.authorizedBy, "mode");
  assert.equal(events[0].details.mode, "trusted");
  assert.equal(events[0].details.operation, "upload");
  assert.equal(events[0].details.files, 1);
  // A dry run plans without a row.
  const planned = await f.sftpCall(f.ownTurn(), {
    action: "upload",
    localPath: "site",
    remotePath: "/www",
    dryRun: true,
  });
  assert.equal(planned.status, "planned");
  assert.equal(planned.summary.files, 1);
  assert.equal(f.rows().length, 1);
  // mkdir and rename are trusted writes too.
  assert.equal(
    (await f.sftpCall(f.ownTurn(), { action: "mkdir", remotePath: "/www/img" })).status,
    "completed",
  );
  const renamed = await f.sftpCall(f.ownTurn(), {
    action: "rename",
    remotePath: "/www/index.html",
    toPath: "/www/home.html",
  });
  assert.equal(renamed.status, "completed");
  assert.deepEqual(tree(f.server.root), { "www/home.html": "<h1>new</h1>" });
  assert.equal(f.rows().length, 3);
});

test("trusted mode never runs a delete directly", async (t) => {
  const f = await setup(t);
  f.access([{ accessId: sftpHostId, mode: "trusted" }]);
  f.file(f.server.root, "keep.txt", "k");
  await assert.rejects(
    f.sftpCall(f.ownTurn(), { action: "delete", remotePath: "/keep.txt" }),
    { status: 503 },
  );
  f.file(f.workspace, "site/a.txt", "a");
  await assert.rejects(
    f.sftpCall(f.ownTurn(), {
      action: "sync",
      direction: "up",
      localPath: "site",
      remotePath: "/",
      deleteExtra: true,
    }),
    // Until the owner can decide SFTP cards, a call that would ask never runs.
    { status: 503 },
  );
  assert.equal(fs.readFileSync(path.join(f.server.root, "keep.txt"), "utf8"), "k");
  assert.equal(fs.existsSync(path.join(f.server.root, "a.txt")), false);
  // In approval mode every write asks; until the owner can decide it never runs.
  f.access([{ accessId: sftpHostId, mode: "approval" }]);
  await assert.rejects(
    f.sftpCall(f.ownTurn(), { action: "upload", localPath: "site", remotePath: "/" }),
    { status: 503 },
  );
  assert.equal(fs.existsSync(path.join(f.server.root, "a.txt")), false);
  assert.deepEqual(f.rows(), []);
});

test("routine with routines mode uploads; delete refused", async (t) => {
  const f = await setup(t);
  const conversation = f.store.getConversation(f.channel.conversationId);
  f.assistants.routines = {
    runOrigin: () => ({ binding: { id: "binding-1", definition: {} }, conversation }),
    writable: () => false,
    noteRefusal() {},
  };
  f.access([{ accessId: sftpHostId, mode: "routines" }]);
  f.file(f.workspace, "report.txt", "r");
  const result = await f.sftpCall(f.routineTurn(), {
    action: "upload",
    localPath: "report.txt",
    remotePath: "/report.txt",
  });
  assert.equal(result.status, "completed");
  assert.equal(f.rows()[0].payload.originClass, "routine");
  assert.equal(
    await code(
      f.sftpCall(f.routineTurn(), { action: "delete", remotePath: "/report.txt" }),
    ),
    "SFTP_ROUTINE_DELETE",
  );
  assert.ok(fs.existsSync(path.join(f.server.root, "report.txt")));
  const denied = f.sftpAudit().find((e) => e.action === "sftp.denied");
  assert.equal(denied.details.code, "SFTP_ROUTINE_DELETE");
  assert.equal(denied.details.originClass, "routine");
  assert.equal(
    (await f.call(f.routineTurn(), { action: "hosts" })).hosts[0].usable,
    true,
  );
  // A trusted host does not run in routines at all.
  f.access([{ accessId: sftpHostId, mode: "trusted" }]);
  const [listed] = (await f.call(f.routineTurn(), { action: "hosts" })).hosts;
  assert.deepEqual([listed.usable, listed.reason], [false, "ROUTINE_NOT_TRUSTED"]);
  assert.equal(
    await code(f.sftpCall(f.routineTurn(), { action: "list" })),
    "SSH_ROUTINE_NOT_TRUSTED",
  );
});

test("execute on an SFTP host returns SSH_HOST_TYPE", async (t) => {
  const f = await setup(t);
  f.access([{ accessId: sftpHostId, mode: "trusted" }]);
  assert.equal(
    await code(f.execute(f.ownTurn(), "process.stdout.write('x')", sftpHostId)),
    "SSH_HOST_TYPE",
  );
  assert.equal(f.catalog.connections, 0);
  const denied = f.audit.find((e) => e.action === "ssh.denied");
  assert.equal(denied.details.code, "SSH_HOST_TYPE");
});

test("file action on an SSH host returns SSH_HOST_TYPE", async (t) => {
  const f = await setup(t);
  f.access([{ accessId: hostId, mode: "trusted" }]);
  assert.equal(
    await code(f.call(f.ownTurn(), { action: "list", accessId: hostId })),
    "SSH_HOST_TYPE",
  );
  assert.equal(f.catalog.connections, 0);
  const { hosts } = await f.call(f.ownTurn(), { action: "hosts" });
  assert.deepEqual(
    hosts.map((h) => [h.accessId, h.type, h.remoteRoot]),
    [[hostId, "ssh", null]],
  );
});

test("hosts names the type and allowed folder of SFTP hosts", async (t) => {
  const f = await setup(t, { remoteRoot: "/www" });
  f.access([
    { accessId: hostId, mode: "approval" },
    { accessId: sftpHostId, mode: "trusted" },
  ]);
  const { hosts } = await f.call(f.ownTurn(), { action: "hosts" });
  assert.deepEqual(
    hosts.map((h) => [h.accessId, h.type, h.remoteRoot]),
    [
      [hostId, "ssh", null],
      [sftpHostId, "sftp", "/www"],
    ],
  );
});

async function longUpload(f) {
  f.sftp.holdMs = 50;
  f.access([{ accessId: sftpHostId, mode: "trusted" }]);
  f.file(f.workspace, "big.bin", "x".repeat(65536));
  f.server.stallNext("WRITE");
  const inv = f.ownTurn();
  const started = await f.sftpCall(inv, {
    action: "upload",
    localPath: "big.bin",
    remotePath: "/big.bin",
  });
  assert.equal(started.status, "running");
  return started;
}
const job = (f, jobId, action = "job") => f.call(f.ownTurn(), { action, jobId });

test("long upload returns running with jobId and job reports progress", async (t) => {
  const f = await setup(t);
  const started = await longUpload(f);
  const [row] = f.rows();
  assert.equal(started.jobId, row.id);
  assert.equal(row.state, "executing");
  assert.equal(row.followUp, true);
  const running = await job(f, started.jobId);
  assert.equal(running.status, "running");
  assert.equal(running.progress.files, 1);
  assert.equal(running.progress.bytes, 65536);
  await waitFor(() => f.rows()[0].progress?.bytes === 65536);
  assert.equal(await code(job(f, "unknown-job")), "SFTP_JOB_NOT_FOUND");
  // Another agent never reads this job.
  const other = f.member();
  assert.equal(
    await code(
      f.call(f.turn(other.conversationId, { kind: "owner" }), {
        action: "job",
        jobId: started.jobId,
      }),
    ),
    "SFTP_JOB_NOT_FOUND",
  );
  await job(f, started.jobId, "cancel");
});

test("cancel stops the job", async (t) => {
  const f = await setup(t);
  const started = await longUpload(f);
  // A forwarded message's turn never stops it.
  assert.equal(
    await code(
      f.call(f.ownTurn({ kind: "owner", forwarded: true }), {
        action: "cancel",
        jobId: started.jobId,
      }),
    ),
    "SSH_ORIGIN_REFUSED",
  );
  assert.equal((await job(f, started.jobId)).status, "running");
  const cancelled = await job(f, started.jobId, "cancel");
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(partFiles(f.server.root), []);
  assert.equal(fs.existsSync(path.join(f.server.root, "big.bin")), false);
  const [row] = f.rows();
  assert.equal(row.state, "cancelled");
  assert.equal((await job(f, started.jobId)).status, "cancelled");
  assert.deepEqual(
    f.sftpAudit().map((e) => [e.action, e.details.code]),
    [
      ["sftp.denied", "SSH_ORIGIN_REFUSED"],
      ["sftp.failed", "SFTP_CANCELLED"],
    ],
  );
});

test("host edit stops a running job", async (t) => {
  const f = await setup(t);
  const started = await longUpload(f);
  // A new password or pin changes the connection revision.
  f.catalog.rows.get(sftpHostId).revision = "r2";
  const ended = await until(async () => {
    const view = await job(f, started.jobId);
    return view.status === "running" ? null : view;
  });
  assert.equal(ended.status, "revoked");
  assert.equal(ended.code, "SSH_REVOKED");
  assert.deepEqual(partFiles(f.server.root), []);
  const [row] = f.rows();
  assert.equal(row.state, "failed");
  assert.equal(row.diagnostic, "SSH_REVOKED");
  const [event] = f.sftpAudit();
  assert.equal(event.action, "sftp.failed");
  assert.equal(event.details.code, "SSH_REVOKED");
});

test("temporary member uses lead's SFTP grant only while shell and SSH are shared", async (t) => {
  const f = await setup(t);
  f.access([{ accessId: sftpHostId, mode: "trusted" }]);
  f.file(f.server.root, "a.txt", "a");
  const member = f.member({ lifetime: "task" });
  const share = { on: true };
  const grants = f.store.memberGrants;
  f.store.memberGrants = (record) =>
    record.id === member.id
      ? { grants: { ssh: true }, shellSsh: share.on }
      : grants(record);
  const list = () =>
    f.sftpCall(f.turn(member.conversationId, { kind: "team-member" }), {
      action: "list",
    });
  assert.deepEqual(
    (await list()).entries.map((e) => e.name),
    ["a.txt"],
  );
  share.on = false;
  await assert.rejects(list(), { status: 403 });
});

test("no result, row or audit contains the password", async (t) => {
  const f = await setup(t);
  f.access([{ accessId: sftpHostId, mode: "trusted" }]);
  f.file(f.workspace, "site/a.txt", "a");
  f.file(f.server.root, "r.txt", "r");
  const results = [];
  const record = async (input) => {
    try {
      results.push(await f.sftpCall(f.ownTurn(), input));
    } catch (error) {
      results.push({
        error: String(error),
        json: JSON.stringify(error),
        ...toolError(error),
      });
    }
  };
  await record({ action: "list" });
  await record({ action: "stat", remotePath: "/r.txt" });
  await record({ action: "upload", localPath: "site", remotePath: "/site" });
  await record({ action: "download", remotePath: "/r.txt" });
  await record({
    action: "sync",
    direction: "up",
    localPath: "site",
    remotePath: "/site",
  });
  await record({ action: "delete", remotePath: "/r.txt" });
  await record({ action: "stat", remotePath: "/missing" });
  results.push(await f.call(f.ownTurn(), { action: "hosts" }));
  // A wrong password fails the sign-in without echoing either password.
  f.catalog.rows.get(sftpHostId).secret.password = "wrong-secret";
  await record({ action: "list" });
  assert.equal(results.at(-1).code, "SFTP_AUTH_FAILED");
  const text = JSON.stringify([results, f.rows(), f.audit]);
  assert.equal(text.includes(PASSWORD), false);
  assert.equal(text.includes("wrong-secret"), false);
  assert.equal(text.includes(f.server.hostKey.split(" ")[1]), false);
});
