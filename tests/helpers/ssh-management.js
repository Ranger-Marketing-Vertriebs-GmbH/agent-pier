import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { SshManagement } from "../../server/features/ssh/ssh-management.js";
import { createSshProjectBinding } from "../../server/features/ssh/ssh-project-scope.js";
import { capabilityFile } from "../../server/features/ssh/ssh-capability.js";
import { writePrivate } from "../../server/lib/storage.js";

export async function sshManagementFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-managed-"));
  const dataDir = path.join(root, "data"),
    home = path.join(root, "home");
  fs.mkdirSync(home);
  const management = new SshManagement({ dataDir, home });
  await management.ready;
  t.after(async () => {
    await management.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function session(id, cwd = path.join(root, id)) {
    fs.mkdirSync(cwd, { recursive: true });
    const project = await createSshProjectBinding(cwd);
    const capability = {
      sessionId: id,
      accountId: "account",
      tool: "codex",
      generation: randomUUID(),
      token: randomBytes(32).toString("hex"),
    };
    writePrivate(capabilityFile(dataDir, id), capability);
    const record = {
      id,
      cwd,
      accountId: "account",
      tool: "codex",
      status: "running",
      createdAt: "fixture",
      sshTools: { enabled: true, generation: capability.generation, project, home },
    };
    writePrivate(path.join(dataDir, "sessions", `${id}.json`), record);
    return {
      capability,
      record,
      project,
      call: (name, args) => management.call(capability, name, args),
    };
  }
  return { root, dataDir, home, management, session };
}
