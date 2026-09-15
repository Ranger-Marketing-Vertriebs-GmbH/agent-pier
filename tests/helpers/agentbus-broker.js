import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { AgentBus } from "../../server/features/agentbus/agent-bus.js";
import { AccountStore } from "../../server/features/accounts/account-store.js";

export async function busFixture(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-broker-")),
  );
  const home = path.join(root, "home"),
    cwd = path.join(root, "project"),
    dataDir = path.join(root, "data");
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  const accounts = new AccountStore({ dataDir, home });
  const rows = new Map(),
    children = [];
  const sessions = {
    list: async () => [...rows.values()],
    get: async (id) => {
      const row = rows.get(id);
      if (!row) throw Error("Missing fixture session");
      return row;
    },
    target: (id) => id,
    tmux: async (args) =>
      String(rows.get(args[args.indexOf("-t") + 1].split(":")[0])?.pid || ""),
  };
  const f = { root, home, cwd, dataDir, accounts, sessions, rows, children };
  f.bus = new AgentBus({ dataDir, home, accounts, sessions });
  t.after(async () => {
    await f.bus.close();
    for (const child of children) {
      child.kill();
      await child.done;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  await f.bus.ready;
  f.prepare = async (id, tool = "opencode", project = cwd) => {
    const account = accounts.create({ name: id, tool });
    const native = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
      env: { PATH: process.env.PATH },
    });
    native.done = once(native, "exit");
    children.push(native);
    await once(native, "spawn");
    const launch = await f.bus.prepare({
      id,
      account,
      cwd: project,
      launch: {
        command: process.execPath,
        args: [],
        env: { HOME: home, PATH: process.env.PATH },
      },
    });
    rows.set(id, {
      id,
      accountId: account.id,
      tool,
      cwd: project,
      status: "running",
      agentbus: launch.agentbus,
      pid: native.pid,
    });
    return { launch, native, id };
  };
  return f;
}

export function requestBus(env, method, params = {}, tokenOverride) {
  const credential =
    tokenOverride || JSON.parse(fs.readFileSync(env.AGENTPIER_AGENTBUS_CAPABILITY_FILE));
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
    const req = http.request(
      {
        socketPath: env.AGENTPIER_AGENTBUS_SOCKET,
        agent: false,
        path: "/mcp",
        method: "POST",
        headers: {
          connection: "keep-alive",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          authorization: `Bearer ${credential.sessionId}.${credential.token}`,
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(Error(`HTTP ${res.statusCode}`));
          }
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
