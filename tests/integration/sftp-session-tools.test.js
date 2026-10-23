import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sshManagementFixture } from "../helpers/ssh-management.js";
import { startSftpServer } from "../helpers/sftp-server.js";
import { partFiles, tree } from "../helpers/sftp-transfer-fixture.js";
import { auditEvent } from "../../server/features/audit/audit-schema.js";
import { SshAccessStore } from "../../server/features/ssh/ssh-access-store.js";
import { SshSessions } from "../../server/features/ssh/ssh-sessions.js";
import { SshTools } from "../../server/features/ssh/ssh-tools.js";
import { sshManagementClient } from "../../server/features/ssh/ssh-management-client.js";
import { SftpSessionTools } from "../../server/features/sftp/sftp-session-tools.js";

const PASSWORD = "pw-secret";

// A coding session with an SFTP host granted, wired like the session MCP process: its
// own store without the catalog writer, management calls over the socket.
async function fixture(t, { remoteRoot, options = {} } = {}) {
  const server = await startSftpServer();
  t.after(() => server.close());
  const audit = [];
  const f = await sshManagementFixture(t, {
    audit: { append: (event) => audit.push(auditEvent(event)) },
  });
  const cli = await f.session("cli");
  const host = await f.management.ui("createHost", {
    name: "Site",
    host: server.host,
    port: server.port,
    username: "deploy",
    hostKey: server.hostKey,
    type: "sftp",
    auth: "password",
    password: PASSWORD,
    ...(remoteRoot ? { remoteRoot } : {}),
  });
  const store = new SshAccessStore({ dataDir: f.dataDir });
  const grants = new SshSessions({ dataDir: f.dataDir, store });
  await grants.set(cli.record, [host.id]);
  const tools = new SshTools({
    dataDir: f.dataDir,
    capability: cli.capability,
    grants,
    store,
  });
  t.after(() => tools.close());
  const sftp = new SftpSessionTools({
    dataDir: f.dataDir,
    capability: cli.capability,
    grants,
    store,
    manage: sshManagementClient(f.dataDir, cli.capability),
    ...options,
  });
  t.after(() => sftp.close());
  const project = cli.record.cwd;
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  return { f, server, cli, host, store, grants, tools, sftp, project, write, audit };
}

async function until(check, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition not reached");
}

test("ssh_list_hosts reports type and remoteRoot", async (t) => {
  const fx = await fixture(t, { remoteRoot: "/www" });
  fs.mkdirSync(path.join(fx.server.root, "www"));
  const { hosts } = await fx.tools.call("ssh_list_hosts", {});
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0].accessId, fx.host.id);
  assert.equal(hosts[0].type, "sftp");
  assert.equal(hosts[0].remoteRoot, "/www");
  assert.doesNotMatch(JSON.stringify(hosts), new RegExp(PASSWORD));
});

test("ssh_execute and ssh_test_host on an SFTP host return SSH_HOST_TYPE", async (t) => {
  const fx = await fixture(t);
  await assert.rejects(
    fx.tools.call("ssh_execute", { accessId: fx.host.id, command: "true" }),
    {
      code: "SSH_HOST_TYPE",
    },
  );
  await assert.rejects(fx.cli.call("ssh_test_host", { accessId: fx.host.id }), {
    code: "SSH_HOST_TYPE",
  });
});

test("an SSH host is refused by the sftp tools and the CLI cannot register SFTP hosts", async (t) => {
  const fx = await fixture(t);
  await assert.rejects(
    fx.cli.call("ssh_register_host", {
      name: "Sneaky",
      host: fx.server.host,
      port: fx.server.port,
      username: "deploy",
      hostKey: fx.server.hostKey,
      type: "sftp",
      requestId: "sftp-register",
    }),
    { code: "SSH_INVALID_ARGUMENT" },
  );
  await assert.rejects(
    fx.cli.call("ssh_register_host", {
      name: "Sneaky",
      host: fx.server.host,
      port: fx.server.port,
      username: "deploy",
      hostKey: fx.server.hostKey,
      password: PASSWORD,
      requestId: "sftp-register-password",
    }),
    { code: "SSH_INVALID_ARGUMENT" },
  );
  // An SFTP host's pin is no SSH bootstrap.
  const managed = await fx.cli.call("ssh_generate_key", {
    name: "Session key",
    requestId: "sftp-bootstrap-key",
  });
  await assert.rejects(
    fx.cli.call("ssh_register_host", {
      name: "Bootstrapped",
      host: fx.server.host,
      port: fx.server.port,
      username: "deploy",
      keyId: managed.id,
      hostKey: fx.server.hostKey,
      trustSource: { kind: "existing", accessId: fx.host.id },
      requestId: "sftp-bootstrap",
    }),
    { code: "SSH_HOST_TYPE" },
  );
  // A shell session has no SFTP tools, so it cannot be granted an SFTP host.
  assert.throws(() => fx.grants.set({ ...fx.cli.record, tool: "shell" }, [fx.host.id]), {
    code: "SSH_HOST_TYPE",
  });
  const key = await fx.f.management.ui("createKey", { name: "Deploy key" });
  const ssh = await fx.f.management.ui("createHost", {
    name: "Shell",
    host: "ssh.invalid",
    username: "deploy",
    hostKey: fx.server.hostKey,
    keyId: key.id,
  });
  await fx.grants.set(fx.cli.record, [fx.host.id, ssh.id]);
  await assert.rejects(fx.tools.call("sftp_list", { accessId: ssh.id }), {
    code: "SSH_HOST_TYPE",
  });
  const session = await fx.grants.get(fx.cli.record);
  assert.deepEqual(
    session.commands.map((item) => item.id),
    [ssh.id],
  );
});

test("sftp_upload of a project folder", async (t) => {
  const fx = await fixture(t);
  fx.write(path.join(fx.project, "site", "index.html"), "<h1>hi</h1>");
  fx.write(path.join(fx.project, "site", "css", "a.css"), "body{}");
  fx.write(path.join(fx.project, "site", ".env"), "TOKEN=1");
  const planned = await fx.tools.call("sftp_upload", {
    accessId: fx.host.id,
    localPath: "site",
    remotePath: "/www",
    dryRun: true,
  });
  assert.equal(planned.status, "planned");
  assert.equal(planned.summary.files, 2);
  assert.deepEqual(tree(path.join(fx.server.root)), {});
  const result = await fx.tools.call("sftp_upload", {
    accessId: fx.host.id,
    localPath: "site",
    remotePath: "/www",
  });
  assert.equal(result.status, "completed");
  assert.equal(result.files, 2);
  assert.equal(result.summary.files, 2);
  assert.deepEqual(tree(path.join(fx.server.root, "www")), {
    "index.html": "<h1>hi</h1>",
    "css/a.css": "body{}",
  });
  assert.deepEqual(partFiles(fx.server.root), []);
  const listed = await fx.tools.call("sftp_list", {
    accessId: fx.host.id,
    remotePath: "/www",
  });
  assert.deepEqual(
    listed.entries.map((entry) => entry.name),
    ["css", "index.html"],
  );
  const stat = await fx.tools.call("sftp_stat", {
    accessId: fx.host.id,
    remotePath: "www/index.html",
  });
  assert.equal(stat.type, "file");
  assert.equal(stat.size, 11);
});

test("localPath outside the project refused", async (t) => {
  const fx = await fixture(t);
  for (const localPath of ["../outside", "/etc", path.join(fx.f.dataDir, "ssh")])
    await assert.rejects(
      fx.tools.call("sftp_upload", { accessId: fx.host.id, localPath, remotePath: "/x" }),
      { code: "SFTP_PATH_REFUSED" },
      localPath,
    );
  await assert.rejects(
    fx.tools.call("sftp_upload", {
      accessId: fx.host.id,
      localPath: "a",
      remotePath: "/x",
      bogus: true,
    }),
    { code: "SSH_INVALID_ARGUMENT" },
  );
});

test("sftp_download into the project", async (t) => {
  const fx = await fixture(t);
  fx.write(path.join(fx.server.root, "backup", "db.sql"), "dump");
  fx.write(path.join(fx.server.root, "backup", "logs", "a.log"), "log");
  const result = await fx.tools.call("sftp_download", {
    accessId: fx.host.id,
    remotePath: "/backup",
  });
  assert.equal(result.status, "completed");
  assert.equal(result.files, 2);
  assert.deepEqual(tree(path.join(fx.project, "backup")), {
    "db.sql": "dump",
    "logs/a.log": "log",
  });
  await assert.rejects(
    fx.tools.call("sftp_download", { accessId: fx.host.id, remotePath: "/missing" }),
    { code: "SFTP_NOT_FOUND" },
  );
});

test("sftp_sync dryRun lists deletes without changing anything", async (t) => {
  const fx = await fixture(t);
  fx.write(path.join(fx.project, "site", "keep.txt"), "new");
  fx.write(path.join(fx.server.root, "www", "keep.txt"), "old!");
  fx.write(path.join(fx.server.root, "www", "stale.txt"), "stale");
  const before = tree(fx.server.root);
  const planned = await fx.tools.call("sftp_sync", {
    accessId: fx.host.id,
    direction: "up",
    localPath: "site",
    remotePath: "/www",
    deleteExtra: true,
    dryRun: true,
  });
  assert.equal(planned.status, "planned");
  assert.deepEqual(planned.summary.delete, ["stale.txt"]);
  assert.deepEqual(planned.summary.update, ["keep.txt"]);
  assert.deepEqual(tree(fx.server.root), before);
  const synced = await fx.tools.call("sftp_sync", {
    accessId: fx.host.id,
    direction: "up",
    localPath: "site",
    remotePath: "/www",
    deleteExtra: true,
  });
  assert.equal(synced.status, "completed");
  assert.equal(synced.deleted, 1);
  assert.deepEqual(tree(path.join(fx.server.root, "www")), { "keep.txt": "new" });
});

test("mkdir, rename and delete run as write jobs confined to the allowed folder", async (t) => {
  const fx = await fixture(t, { remoteRoot: "/www" });
  fx.write(path.join(fx.server.root, "www", "a.txt"), "a");
  fx.write(path.join(fx.server.root, "secret.txt"), "s");
  const made = await fx.tools.call("sftp_mkdir", {
    accessId: fx.host.id,
    remotePath: "deep/er",
    parents: true,
  });
  assert.equal(made.status, "completed");
  assert.ok(fs.statSync(path.join(fx.server.root, "www", "deep", "er")).isDirectory());
  const renamed = await fx.tools.call("sftp_rename", {
    accessId: fx.host.id,
    remotePath: "a.txt",
    toPath: "deep/b.txt",
  });
  assert.equal(renamed.status, "completed");
  assert.equal(
    fs.readFileSync(path.join(fx.server.root, "www", "deep", "b.txt"), "utf8"),
    "a",
  );
  for (const remotePath of ["/secret.txt", "../secret.txt", "/"])
    await assert.rejects(
      fx.tools.call("sftp_delete", { accessId: fx.host.id, remotePath }),
      { code: "SFTP_PATH_REFUSED" },
      remotePath,
    );
  await assert.rejects(
    fx.tools.call("sftp_delete", { accessId: fx.host.id, remotePath: "/www" }),
    { code: "SFTP_PATH_REFUSED" },
  );
  await assert.rejects(
    fx.tools.call("sftp_delete", { accessId: fx.host.id, remotePath: "deep" }),
    { code: "SFTP_TYPE_CONFLICT" },
  );
  const deleted = await fx.tools.call("sftp_delete", {
    accessId: fx.host.id,
    remotePath: "deep",
    recursive: true,
  });
  assert.equal(deleted.status, "completed");
  assert.equal(deleted.files, 1);
  assert.equal(deleted.dirs, 2);
  assert.deepEqual(tree(fx.server.root), { "secret.txt": "s" });
});

test("revoking the grant stops a running job", async (t) => {
  const fx = await fixture(t, { options: { waitMs: 50, authorizeEveryMs: 20 } });
  fx.write(path.join(fx.project, "big.bin"), "x".repeat(65536));
  fx.server.stallNext("WRITE");
  const started = await fx.sftp.call("sftp_upload", {
    accessId: fx.host.id,
    localPath: "big.bin",
    remotePath: "/big.bin",
  });
  assert.equal(started.status, "running");
  assert.ok(started.jobId);
  await fx.grants.set(fx.cli.record, []);
  const ended = await until(async () => {
    try {
      const job = await fx.sftp.call("sftp_job", { jobId: started.jobId });
      return job.status === "running" ? null : job;
    } catch (error) {
      return error;
    }
  });
  assert.equal(ended.code, "SSH_ACCESS_REVOKED");
  assert.deepEqual(partFiles(fx.server.root), []);
});

test("sftp_job reports progress and cancels", async (t) => {
  const fx = await fixture(t, { options: { waitMs: 50 } });
  fx.write(path.join(fx.project, "big.bin"), "x".repeat(65536));
  fx.server.stallNext("WRITE");
  const started = await fx.sftp.call("sftp_upload", {
    accessId: fx.host.id,
    localPath: "big.bin",
    remotePath: "/big.bin",
  });
  assert.equal(started.status, "running");
  const running = await fx.sftp.call("sftp_job", { jobId: started.jobId });
  assert.equal(running.status, "running");
  assert.equal(running.progress.files, 1);
  assert.equal(running.progress.bytes, 65536);
  await assert.rejects(
    fx.sftp.call("sftp_upload", {
      accessId: fx.host.id,
      localPath: "big.bin",
      remotePath: "/big.bin",
    }),
    { code: "SFTP_BUSY" },
  );
  const cancelled = await fx.sftp.call("sftp_job", {
    jobId: started.jobId,
    cancel: true,
  });
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(partFiles(fx.server.root), []);
  await assert.rejects(fx.sftp.call("sftp_job", { jobId: "unknown" }), {
    code: "SFTP_JOB_NOT_FOUND",
  });
});

test("no tool result contains the password", async (t) => {
  const fx = await fixture(t);
  fx.write(path.join(fx.project, "site", "a.txt"), "a");
  const results = [];
  const record = async (name, input) => {
    try {
      results.push(await fx.tools.call(name, input));
    } catch (error) {
      results.push({ error: String(error), json: JSON.stringify(error), ...error });
    }
  };
  const accessId = fx.host.id;
  await record("ssh_list_hosts", {});
  await record("sftp_list", { accessId });
  await record("sftp_stat", { accessId, remotePath: "/missing" });
  await record("sftp_upload", { accessId, localPath: "site", remotePath: "/www" });
  await record("sftp_download", { accessId, remotePath: "/www", localPath: "back" });
  await record("sftp_sync", { accessId, direction: "down", remotePath: "/www" });
  await record("sftp_mkdir", { accessId, remotePath: "/new" });
  await record("sftp_rename", { accessId, remotePath: "/new", toPath: "/newer" });
  await record("sftp_delete", { accessId, remotePath: "/newer" });
  await record("sftp_execute", { accessId });
  await record("ssh_execute", { accessId, command: "true" });
  assert.equal(results.length, 11);
  assert.doesNotMatch(JSON.stringify(results), new RegExp(PASSWORD));
  assert.doesNotMatch(JSON.stringify(fx.audit), new RegExp(PASSWORD));
});

test("writes are audited by the application with source mcp", async (t) => {
  const fx = await fixture(t);
  fx.write(path.join(fx.project, "site", "a.txt"), "FILE-CONTENT");
  await fx.tools.call("sftp_upload", {
    accessId: fx.host.id,
    localPath: "site",
    remotePath: "/www",
  });
  await fx.tools.call("sftp_list", { accessId: fx.host.id });
  await assert.rejects(
    fx.tools.call("sftp_rename", {
      accessId: fx.host.id,
      remotePath: "/missing",
      toPath: "/other",
    }),
    { code: "SFTP_NOT_FOUND" },
  );
  const rows = await until(() => (fx.audit.length >= 2 ? fx.audit : null));
  assert.deepEqual(
    rows.map((row) => row.action),
    ["sftp.completed", "sftp.failed"],
  );
  const [done, failed] = rows;
  assert.equal(done.source, "mcp");
  assert.equal(done.resourceType, "ssh");
  assert.equal(done.resourceId, fx.host.id);
  assert.equal(done.sessionId, "cli");
  assert.equal(done.details.operation, "upload");
  assert.equal(done.details.files, 1);
  assert.equal(done.details.bytes, 12);
  assert.equal(done.details.remotePath, "/www");
  assert.equal(done.details.localPath, "site");
  assert.equal(failed.details.code, "SFTP_NOT_FOUND");
  assert.equal(failed.outcome, "failure");
  const text = JSON.stringify(rows);
  assert.doesNotMatch(text, new RegExp(PASSWORD));
  assert.doesNotMatch(text, /FILE-CONTENT/);
  // A record for a host this session holds no grant for is refused and audited.
  await assert.rejects(
    fx.cli.call("sftp_record", {
      accessId: "00000000-0000-4000-8000-000000000000",
      operation: "upload",
      state: "completed",
    }),
  );
  assert.equal(fx.audit.at(-1).action, "sftp.denied");
});
