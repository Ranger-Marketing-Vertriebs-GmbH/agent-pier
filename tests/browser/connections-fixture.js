import { setupAssistantSettings } from "../helpers/assistant-settings-browser.js";

// Zugänge with agents on: SSH/SFTP accesses (any number), keys and projects, the usage
// and problem summaries derived from the agent's live access policy, connection tests
// that pass or fail per host, and the MCP server list. Agent grants go through the
// assistant settings fixture (`state.access`, `state.work`), so both sides read the
// same policy.

export const now = new Date();
const minutesAgo = (minutes) => new Date(now.getTime() - minutes * 60_000).toISOString();
const daysAgo = (days) => new Date(now.getTime() - days * 86_400_000).toISOString();
export const hostId = (index) =>
  `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

/**
 * `count` synthetic accesses: every 50th failed its last test, host 7 reports a
 * changed host key, every 3rd is SFTP, projects rotate over app/docs/global.
 */
export function syntheticHosts(count) {
  return Array.from({ length: count }, (_, index) => {
    const failed = index % 50 === 3;
    return {
      id: hostId(index),
      name: `server-${String(index).padStart(3, "0")}`,
      host: `10.0.${Math.floor(index / 250)}.${index % 250}`,
      port: 22,
      username: index % 4 ? "deploy" : "admin",
      // Each access signs in with the key of its own project, as the server requires.
      keyId: ["key-app", "key-docs", "key-one"][index % 3],
      keyName: "Deployment key",
      publicKey: "ssh-ed25519 public-fixture",
      hostKey: "ssh-ed25519 host-fixture",
      hostFingerprint: `SHA256:host-${index}`,
      createdAt: daysAgo(400 - (index % 300)),
      ...(index % 9 === 0 ? { updatedAt: daysAgo(index % 30) } : {}),
      projectId: ["project-app", "project-docs", null][index % 3],
      type: index % 3 === 2 ? "sftp" : "ssh",
      auth: "key",
      remoteRoot: index % 3 === 2 ? "/srv/data" : null,
      lastTest:
        index === 7
          ? {
              ok: false,
              at: minutesAgo(90),
              commandRejected: false,
              code: null,
              hostKeyMismatch: true,
              detail: "Host key verification failed.",
              error: "Die Verbindung zum SSH-Host ist fehlgeschlagen.",
              messageKey: "ssh.connectionFailed",
            }
          : failed
            ? {
                ok: false,
                at: minutesAgo(600),
                commandRejected: false,
                code: null,
                hostKeyMismatch: false,
                detail: "deploy@10.0.0.3: Permission denied (publickey).",
                error: "Die Verbindung zum SSH-Host ist fehlgeschlagen.",
                messageKey: "ssh.connectionFailed",
              }
            : index % 5
              ? { ok: true, at: minutesAgo(30), commandRejected: false }
              : null,
    };
  });
}

/** GET /connections/usage from the agent's current grants and the fixture's hooks. */
function usage(state) {
  const grants = state.access.sshAccesses || [];
  return {
    agentsEnabled: true,
    lastUseCovers: ["agentSsh", "agentSftp", "sessionSftp"],
    ssh: Object.fromEntries(
      state.hosts.map((host, index) => {
        const grant = grants.find((g) => g.accessId === host.id);
        const hook = state.hooks.find((h) => h.hostId === host.id);
        return [
          host.id,
          {
            type: host.type,
            agents: [
              ...(grant
                ? [
                    {
                      id: "home",
                      name: "Home",
                      kind: "agent",
                      via: "grant",
                      mode: grant.mode,
                    },
                  ]
                : []),
              ...(hook
                ? [{ id: "home", name: "Home", kind: "agent", via: "hook", mode: null }]
                : []),
            ],
            hooks: hook ? [{ agentId: "home", hookId: hook.id, name: hook.name }] : [],
            sessions: index % 11 === 0 ? 1 : 0,
            lastUsedAt: index === 1 ? minutesAgo(5) : index % 6 === 0 ? daysAgo(3) : null,
          },
        ];
      }),
    ),
    secrets: {},
    github: {},
    mcp: {},
  };
}

function problems(state) {
  const failed = state.hosts.filter((host) => host.lastTest && !host.lastTest.ok);
  return {
    agentsEnabled: true,
    models: { total: 0, problems: [], warnings: [], unknown: [] },
    services: { total: 1, problems: [], warnings: [], unknown: [] },
    mcp: { total: state.mcpServers.length, problems: [], warnings: [], unknown: [] },
    ssh: {
      total: state.hosts.length,
      problems: failed.map((host) => ({
        id: host.id,
        reasons: [host.lastTest.hostKeyMismatch ? "hostKeyMismatch" : "testFailed"],
      })),
      warnings: [],
      unknown: [],
    },
    secrets: { total: 0, problems: [], warnings: [], unknown: [] },
    github: { total: 0, problems: [], warnings: [], unknown: [] },
  };
}

export async function connectionsFixture(page, { hosts = 12, ...options } = {}) {
  const state = await setupAssistantSettings(page, {
    access: { revision: 0, projectIds: [], pipelineIds: [], sshAccesses: [] },
    catalog: { projects: [], pipelines: [], sshHosts: [] },
    ...options,
  });
  state.hosts = typeof hosts === "number" ? syntheticHosts(hosts) : hosts;
  state.catalog.sshHosts = state.hosts;
  state.hooks = [{ id: "hook-1", name: "Monitoring", hostId: hostId(0) }];
  state.mcpServers = options.mcpServers || [];
  state.failingTests = new Set();
  state.failingDeletes = new Set();
  state.sshCalls = [];
  await page.route("**/api/ssh-projects**", (route) =>
    route.fulfill({
      json: {
        projects: [
          { id: "project-app", name: "Agent app", cwd: "/work/app" },
          { id: "project-docs", name: "Docs", cwd: "/work/docs" },
        ],
      },
    }),
  );
  await page.route("**/api/ssh-keys**", (route) =>
    route.fulfill({
      json: {
        keys: [
          ["key-one", null],
          ["key-app", "project-app"],
          ["key-docs", "project-docs"],
        ].map(([id, projectId]) => ({
          id,
          name: "Deployment key",
          publicKey: "ssh-ed25519 public-fixture",
          fingerprint: "SHA256:public",
          projectId,
          hosts: [],
        })),
      },
    }),
  );
  await page.route("**/api/ssh-accesses**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const body = request.postData() ? request.postDataJSON() : null;
    state.sshCalls.push({ path, method, body });
    const id = path.split("/").at(path.endsWith("/test") ? -2 : -1);
    if (path.endsWith("/scan"))
      return route.fulfill({
        json: { hostKey: "ssh-ed25519 new-host-key", hostFingerprint: "SHA256:new-host" },
      });
    if (path.endsWith("/test")) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      const host = state.hosts.find((item) => item.id === id);
      if (state.failingTests.has(id)) {
        host.lastTest = {
          ok: false,
          at: new Date().toISOString(),
          hostKeyMismatch: false,
          detail: "deploy@host: Permission denied (publickey).",
          error: "Die Verbindung zum SSH-Host ist fehlgeschlagen.",
          messageKey: "ssh.connectionFailed",
        };
        return route.fulfill({
          status: 502,
          json: {
            error: "Die Verbindung zum SSH-Host ist fehlgeschlagen.",
            messageKey: "ssh.connectionFailed",
          },
        });
      }
      host.lastTest = { ok: true, at: new Date().toISOString(), commandRejected: false };
      return route.fulfill({ json: { ok: true } });
    }
    if (method === "DELETE") {
      if (state.failingDeletes.has(id))
        return route.fulfill({ status: 409, json: { error: "Host is busy" } });
      state.hosts = state.hosts.filter((item) => item.id !== id);
      return route.fulfill({ status: 204 });
    }
    if (method === "PATCH") {
      const index = state.hosts.findIndex((item) => item.id === id);
      state.hosts[index] = {
        ...state.hosts[index],
        ...body,
        ...(body.hostKey ? { hostFingerprint: "SHA256:new-host", lastTest: null } : {}),
        updatedAt: new Date().toISOString(),
      };
      return route.fulfill({ json: state.hosts[index] });
    }
    return route.fulfill({ json: { accesses: state.hosts } });
  });
  await page.route("**/api/connections/usage", (route) =>
    route.fulfill({ json: usage(state) }),
  );
  await page.route("**/api/connections/problems", (route) =>
    route.fulfill({ json: problems(state) }),
  );
  await page.route("**/api/mcp-servers", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: state.mcpServers })
      : route.fallback(),
  );
  await page.route(/\/api\/mcp-servers\/[^/]+$/, (route) => {
    const request = route.request();
    const id = new URL(request.url()).pathname.split("/").at(-1);
    if (request.method() !== "DELETE") return route.fallback();
    if (id === state.failingMcpRemove)
      return route.fulfill({ status: 409, json: { error: "Server is installing" } });
    state.mcpServers = state.mcpServers.filter((server) => server.id !== id);
    return route.fulfill({ json: {} });
  });
  return state;
}

export const mcpServer = (id, name, extra = {}) => ({
  id,
  name,
  transport: "http",
  url: `https://${id}.example.test/mcp`,
  auth: "headers",
  headerNames: [],
  envNames: [],
  clis: [],
  cliSupport: {},
  cliStatus: {},
  users: { agents: [], clis: [] },
  revision: 1,
  ...extra,
});
