import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openSftp } from "../../server/features/sftp/sftp-client.js";
import { localRoot } from "../../server/features/sftp/sftp-local.js";
import { startSftpServer } from "./sftp-server.js";

/**
 * An in-process SFTP server, a session to it and a disposable local project folder.
 * Never touches real hosts, user files or the default tmux server.
 */
export async function transferFixture(t, serverOptions = {}) {
  const server = await startSftpServer(serverOptions);
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sftp-xfer-")));
  const project = path.join(base, "project");
  fs.mkdirSync(project);
  const sessions = [];
  const connect = async () => {
    const session = await openSftp({
      host: server.host,
      port: server.port,
      username: "deploy",
      hostKey: server.hostKey,
      password: "pw-secret",
    });
    sessions.push(session);
    return session;
  };
  const session = await connect();
  t.after(async () => {
    for (const open of sessions) open.close();
    await server.close();
    fs.rmSync(base, { recursive: true, force: true });
  });
  const remote = (relative = "") => path.join(server.root, relative);
  const local = (relative = "") => path.join(project, relative);
  const write = (file, content, mtimeMs) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    if (mtimeMs !== undefined) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  };
  return {
    server,
    session,
    connect,
    project,
    remote,
    local,
    write,
    target: (raw, options = {}) => localRoot({ root: project, raw, ...options }),
  };
}

/** Every file below `dir` as relative POSIX path → content. */
export function tree(dir) {
  const files = {};
  const visit = (relative) => {
    for (const name of fs.readdirSync(path.join(dir, relative))) {
      const child = relative ? `${relative}/${name}` : name;
      const stat = fs.lstatSync(path.join(dir, child));
      if (stat.isDirectory()) visit(child);
      else if (stat.isFile())
        files[child] = fs.readFileSync(path.join(dir, child), "utf8");
    }
  };
  if (fs.existsSync(dir)) visit("");
  return files;
}

/** Leftover `.agentpier-part-` files below `dir`. */
export function partFiles(dir) {
  const found = [];
  const visit = (current) => {
    if (!fs.existsSync(current)) return;
    for (const name of fs.readdirSync(current)) {
      const full = path.join(current, name);
      if (name.includes("agentpier-part")) found.push(full);
      if (fs.lstatSync(full).isDirectory()) visit(full);
    }
  };
  visit(dir);
  return found;
}
