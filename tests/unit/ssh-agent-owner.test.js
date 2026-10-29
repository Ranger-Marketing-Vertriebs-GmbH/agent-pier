import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { agentHosts } from "../../server/features/ssh/ssh-agent-policy.js";
import {
  AGENT_FOLDER,
  assertOwner,
  ownerKey,
  validOwner,
} from "../../server/features/ssh/ssh-agent-shared.js";
import {
  ownerFolder,
  readOwnerAliases,
  readSessionAliases,
  sessionFolder,
  writeOwnerFiles,
  writeSessionFiles,
} from "../../server/features/ssh/ssh-session-config.js";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier ssh agent owner "));
process.on("exit", () => fs.rmSync(temp, { recursive: true, force: true }));

let counter = 0;
function publicLine() {
  counter += 1;
  const file = path.join(temp, `key-${counter}`);
  execFileSync("ssh-keygen", ["-q", "-N", "", "-t", "ed25519", "-f", file]);
  const [kind, base64] = fs.readFileSync(`${file}.pub`, "utf8").trim().split(" ");
  return `${kind} ${base64}`;
}

const access = {
  id: "0a1b2c3d-0000-4000-8000-000000000001",
  type: "ssh",
  name: "Proxmox 2",
  host: "10.0.0.2",
  port: 2222,
  username: "deploy",
  keyId: "5f0e1d2c-0000-4000-8000-000000000001",
  publicKey: `${publicLine()} comment`,
  hostKey: publicLine(),
  createdAt: "2026-01-01T00:00:00.000Z",
};
const [hostA] = agentHosts([access], [access.id]);
const agentId = "b7c1e2d4-0000-4000-8000-00000000000a";
const socketPath = "/tmp/agent.sock";
const binaries = { ssh: "/usr/bin/ssh" };

function dataDirOf(name) {
  return fs.mkdtempSync(path.join(temp, `${name} `));
}

test("owner folders keep sessions in place and agents under _agents", () => {
  const dataDir = dataDirOf("folders");
  assert.equal(AGENT_FOLDER, "_agents");
  assert.equal(
    ownerFolder(dataDir, { kind: "session", id: "s1" }),
    path.join(dataDir, "ssh-agents", "s1"),
  );
  assert.equal(
    ownerFolder(dataDir, { kind: "agent", id: agentId }),
    path.join(dataDir, "ssh-agents", "_agents", agentId),
  );
  assert.equal(
    sessionFolder(dataDir, "s1"),
    ownerFolder(dataDir, { kind: "session", id: "s1" }),
  );
});

test("invalid owners throw before a path is built", () => {
  const dataDir = dataDirOf("invalid");
  for (const owner of [
    { kind: "agent", id: "../x" },
    { kind: "agent", id: "_agents" },
    { kind: "session", id: "_agents" },
    { kind: "session", id: "" },
    { kind: "agent", id: "a/b" },
    { kind: "agent", id: 7 },
    { kind: "user", id: "a" },
    { id: "a" },
    "agent:a",
    null,
    undefined,
  ]) {
    assert.throws(
      () => ownerFolder(dataDir, owner),
      { code: "SSH_AGENT_OWNER_INVALID" },
      JSON.stringify(owner),
    );
    assert.throws(() => assertOwner(owner), { code: "SSH_AGENT_OWNER_INVALID" });
    assert.throws(() => ownerKey(owner), { code: "SSH_AGENT_OWNER_INVALID" });
    assert.equal(validOwner(owner), false);
    assert.deepEqual(readOwnerAliases(dataDir, owner), {});
  }
  assert.equal(fs.existsSync(path.join(dataDir, "ssh-agents")), false);
  assert.equal(validOwner({ kind: "agent", id: agentId }), true);
  assert.equal(validOwner({ kind: "session", id: "s1" }), true);
  assert.equal(ownerKey({ kind: "agent", id: agentId }), `agent:${agentId}`);
  assert.equal(ownerKey({ kind: "session", id: "s1" }), "session:s1");
});

test("agent files are written below a pinned chain and refuse a planted link", () => {
  const dataDir = dataDirOf("agent");
  const root = path.join(dataDir, "ssh-agents");
  const elsewhere = dataDirOf("elsewhere");
  const owner = { kind: "agent", id: agentId };
  const folder = ownerFolder(dataDir, owner);
  const files = {
    hosts: [hostA],
    aliases: { [hostA.accessId]: "proxmox-2" },
    socketPath,
    binaries,
    shellEnv: "export X=1\n",
  };
  assert.deepEqual(writeOwnerFiles(root, folder, files), { skipped: [] });
  assert.equal(fs.statSync(path.join(folder, "shell-env.sh")).mode & 0o777, 0o600);
  assert.equal(
    fs.readFileSync(path.join(folder, "shell-env.sh"), "utf8"),
    "export X=1\n",
  );
  for (const dir of [root, path.join(root, "_agents"), folder])
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700, dir);
  assert.ok(fs.existsSync(path.join(folder, "bin", "ssh")));
  assert.match(fs.readFileSync(path.join(folder, "ssh_config"), "utf8"), /proxmox-2/);
  assert.deepEqual(readOwnerAliases(dataDir, owner), {
    [hostA.accessId]: "proxmox-2",
  });
  fs.rmSync(path.join(root, "_agents"), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(root, "_agents"));
  assert.throws(() => writeOwnerFiles(root, folder, files), {
    code: "SSH_FOLDER_UNSAFE",
  });
  assert.deepEqual(fs.readdirSync(elsewhere), []);
  assert.deepEqual(readOwnerAliases(dataDir, owner), {});
});

test("a planted link for the owner folder below _agents is refused", () => {
  const dataDir = dataDirOf("planted owner");
  const root = path.join(dataDir, "ssh-agents");
  const elsewhere = dataDirOf("elsewhere");
  const folder = ownerFolder(dataDir, { kind: "agent", id: agentId });
  fs.mkdirSync(path.dirname(folder), { recursive: true, mode: 0o700 });
  fs.symlinkSync(elsewhere, folder);
  assert.throws(
    () => writeOwnerFiles(root, folder, { hosts: [], aliases: {}, socketPath, binaries }),
    { code: "SSH_FOLDER_UNSAFE" },
  );
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test("a folder that is not below the root is refused before anything is written", () => {
  const dataDir = dataDirOf("outside");
  const root = path.join(dataDir, "ssh-agents");
  for (const folder of [root, dataDir, path.join(dataDir, "other", "x")])
    assert.throws(
      () =>
        writeOwnerFiles(root, folder, { hosts: [], aliases: {}, socketPath, binaries }),
      { code: "SSH_FOLDER_UNSAFE" },
      folder,
    );
  assert.deepEqual(fs.readdirSync(dataDir), []);
});

test("a session folder has no shell-env.sh", () => {
  const dataDir = dataDirOf("session");
  writeSessionFiles(sessionFolder(dataDir, "s1"), {
    hosts: [hostA],
    aliases: { [hostA.accessId]: "proxmox-2" },
    socketPath,
    binaries,
  });
  assert.equal(
    fs.existsSync(path.join(sessionFolder(dataDir, "s1"), "shell-env.sh")),
    false,
  );
  assert.deepEqual(readSessionAliases(dataDir, "s1"), { [hostA.accessId]: "proxmox-2" });
  assert.deepEqual(readOwnerAliases(dataDir, { kind: "session", id: "s1" }), {
    [hostA.accessId]: "proxmox-2",
  });
  assert.deepEqual(readOwnerAliases(dataDir, { kind: "agent", id: "s1" }), {});
});

test("a non-string shellEnv writes no shell-env.sh", () => {
  const dataDir = dataDirOf("no env");
  const root = path.join(dataDir, "ssh-agents");
  const folder = ownerFolder(dataDir, { kind: "agent", id: agentId });
  for (const shellEnv of [undefined, null, 1, { x: 1 }])
    writeOwnerFiles(root, folder, {
      hosts: [],
      aliases: {},
      socketPath,
      binaries,
      shellEnv,
    });
  assert.equal(fs.existsSync(path.join(folder, "shell-env.sh")), false);
});
