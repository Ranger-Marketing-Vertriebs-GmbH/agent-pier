import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createApplication } from "../../server/app.js";

const execute = promisify(execFile);
const authenticatedOrigins = new Map();
// Explicit authenticated client for suites that exercise raw fetch options.
export function fixtureFetch(input, options = {}) {
  const cookie = authenticatedOrigins.get(new URL(input).origin);
  if (!cookie) throw new Error("No authenticated fixture owns this origin");
  return fetch(input, { ...options, headers: { cookie, ...options.headers } });
}

/** Owns one temporary app, its private tmux socket and every fixture it launches. */
export async function applicationFixture(t, overrides = {}) {
  const { authenticateFixture = true, ...configuration } = overrides;
  let cookie = "";
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-blackbox-")),
  );
  const dataDir = path.join(root, "data");
  const home = path.join(root, "home");
  await fs.mkdir(home, { mode: 0o700 });
  let application;
  let listOwnedSessions;
  let url;
  let disposed = false;
  const hash = createHash("sha256").update(dataDir).digest("hex").slice(0, 24);
  const expectedSocket = `/tmp/tuiui-${process.getuid?.() ?? "user"}-${hash}/tmux.sock`;

  async function start() {
    application = await createApplication({ ...configuration, dataDir, home, port: 0 });
    listOwnedSessions = application.sessions.list.bind(application.sessions);
    if (application.sessions.socketPath !== expectedSocket) {
      await application.close();
      throw new Error("Fixture refuses a tmux socket outside its unique data directory.");
    }
    await new Promise((resolve, reject) => {
      application.server.once("error", reject);
      application.server.listen(0, "127.0.0.1", () => {
        application.server.removeListener("error", reject);
        resolve();
      });
    });
    url = `http://127.0.0.1:${application.server.address().port}`;
    if (authenticateFixture) {
      if (!application.login.configured) {
        const token = await application.login.setup({
          username: "fixture",
          password: randomBytes(24).toString("hex"),
        });
        cookie = `agentpier_session=${token}`;
      }
      authenticatedOrigins.set(url, cookie);
    }
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    authenticatedOrigins.delete(url);
    try {
      if (application) {
        try {
          for (const session of await listOwnedSessions()) {
            if (session.status === "running") await application.sessions.stop(session.id);
          }
        } finally {
          await application.close();
        }
      }
    } finally {
      // Never use the default tmux server or a socket discovered outside this fixture.
      if (application?.sessions.socketPath === expectedSocket) {
        await execute(
          application.sessions.tmuxPath,
          ["-S", expectedSocket, "kill-server"],
          {
            timeout: 3000,
          },
        ).catch(() => {});
        await fs.rm(path.dirname(expectedSocket), {
          recursive: true,
          force: true,
        });
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  t.after(dispose);
  try {
    await start();
  } catch (error) {
    await dispose();
    throw error;
  }

  return {
    root,
    dataDir,
    home,
    get application() {
      return application;
    },
    get cookie() {
      return cookie;
    },
    get url() {
      return url;
    },
    async request(
      endpoint,
      { method = "GET", body, origin = url, headers = {}, ...options } = {},
    ) {
      const target = new URL(endpoint, url);
      if (target.origin !== url || target.username || target.password) {
        throw new Error("Fixture requests must target their own application origin.");
      }
      return fetch(target, {
        signal: AbortSignal.timeout(10000),
        ...options,
        method,
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(origin === null ? {} : { origin }),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    },
    async restart() {
      authenticatedOrigins.delete(url);
      await application.close();
      await start();
    },
    dispose,
  };
}
