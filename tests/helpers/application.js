import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createApplication } from "../../server/app.js";
import { tmuxSocketPath } from "../../server/features/sessions/tmux-naming.js";
import { writeAssistantFeature } from "../../server/features/assistants/assistant-feature.js";

const execute = promisify(execFile);
const authenticatedOrigins = new Map();
// Explicit authenticated client for suites that exercise raw fetch options.
export function fixtureFetch(input, options = {}) {
  const cookie = authenticatedOrigins.get(new URL(input).origin);
  if (!cookie) throw new Error("No authenticated fixture owns this origin");
  return fetch(input, { ...options, headers: { cookie, ...options.headers } });
}

/** Fixture options for suites that exercise assistants, which are opt-in. */
export const enabledAssistants = {
  prepareDataDir: (dataDir) => writeAssistantFeature(dataDir, { enabled: true }),
};

/**
 * Stands in for running a coding CLI's MCP status command: Codex answers with no
 * servers. A suite opts into running the detected binary (a fake one first on PATH,
 * never the real CLI) with `realCliOAuthStatus: true`.
 */
export const fakeCliOAuthRun = async () => ({ stdout: "[]" });
/** Brokered CLI logins never start a CLI in a fixture unless a suite opts in as above. */
export const refuseCliLogin = () => {
  throw new Error("Fixtures do not start coding CLI logins.");
};

/** Owns one temporary app, its private tmux socket and every fixture it launches. */
export async function applicationFixture(t, overrides = {}) {
  const {
    authenticateFixture = true,
    prepareDataDir,
    realCliOAuthStatus = false,
    ...configuration
  } = overrides;
  if (!realCliOAuthStatus) {
    configuration.cliOAuthRun ??= fakeCliOAuthRun;
    configuration.cliLoginSpawn ??= refuseCliLogin;
  }
  let cookie = "";
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-blackbox-")),
  );
  const dataDir = path.join(root, "data");
  const home = path.join(root, "home");
  await fs.mkdir(home, { mode: 0o700 });
  // The home folder stands for no project, so sessions that need one use this folder.
  const project = path.join(root, "fixture-project");
  await fs.mkdir(project, { mode: 0o700 });
  let application;
  let listOwnedSessions;
  let url;
  let disposed = false;
  const expectedSocket = tmuxSocketPath(dataDir);

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
    // Local brokers keep their sockets in /tmp folders hashed from this data directory;
    // closing removes only the socket, so the fixture removes the folders too.
    const socketFolders = [
      application?.requests?.socketPath,
      application?.sessionMcp?.socketPath,
      application?.sshManagement?.broker?.socketPath,
      application?.memoryIntegration?.broker?.socketPath,
      application?.agentbus?.broker?.transport?.socketPath,
    ]
      .filter(
        (socket) => typeof socket === "string" && socket.startsWith("/tmp/agentpier-"),
      )
      .map((socket) => path.dirname(socket));
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
      for (const folder of socketFolders)
        await fs.rm(folder, { recursive: true, force: true }).catch(() => {});
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }

  t.after(dispose);
  try {
    // Seeds the disposable data directory before the first start, e.g. feature state.
    await prepareDataDir?.(dataDir);
    await start();
  } catch (error) {
    await dispose();
    throw error;
  }

  return {
    root,
    dataDir,
    home,
    project,
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
