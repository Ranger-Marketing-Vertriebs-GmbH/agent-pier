// Representative Gateway starts for the golden compile test
// (tests/unit/openclaw-config-golden.test.js). Each scenario holds what a start reads
// from AgentPier's stores (the same shape the composition root gathers: profiles,
// MCP and Telegram inputs, web tools, team plugin and native settings) plus the
// start's own facts (existing file, paths, port, token, TLS, owner PATH, skill
// shadows). The expected openclaw.json of each was written by the compiler as it was
// before the desired-state model (tests/fixtures/openclaw-golden/), so a refactor of
// the compile path must reproduce it byte for byte.

const root = "/golden/assistants";
export const goldenPaths = Object.freeze({
  root,
  home: `${root}/home`,
  state: `${root}/state`,
  workspaces: `${root}/workspaces`,
  logs: `${root}/logs`,
  runtimes: `${root}/runtimes`,
  tmp: `${root}/tmp`,
  config: `${root}/state/openclaw.json`,
  skillCatalog: `${root}/skill-catalog`,
  catalogSkills: `${root}/skill-catalog/skills`,
});

const plugin = {
  directory: "/golden/plugin",
  connection: { url: "http://127.0.0.1:1235", token: "bridge-token" },
  hostMaxConcurrent: 4,
  native: { token: "hook-token" },
};
const agent = (id, extra = {}) => ({
  id,
  name: `Agent ${id}`,
  runtimeAgentId: `ap-${id}`,
  revision: 1,
  ...extra,
});
const webTools = (extra = {}) => ({
  search: { provider: null },
  browser: { available: false },
  browserAllowPrivateNetwork: false,
  searchPlugins: {},
  images: { ready: false },
  pdf: { ready: false },
  documentExtract: false,
  ...extra,
});
const noMcp = { servers: [], bindings: {}, secrets: {}, redirectUrl: null };
const noTelegram = { accounts: [], speech: null, unreadable: false };

// The file an earlier start and the agents' creation left: the start compiles the
// entries it finds (agents.create adds them, never the start).
const roster = (profiles) => ({
  agents: {
    defaults: {},
    entries: Object.fromEntries([
      ["main", {}],
      ...profiles.map((profile) => [profile.runtimeAgentId, {}]),
    ]),
  },
});
const base = (teams, extra = {}) => ({
  existing: roster(teams.profiles || []),
  port: 18000,
  token: "golden-token",
  overrides: [],
  maintenance: false,
  tls: null,
  shell: { pathPrepend: [] },
  skillShadows: {},
  teams: {
    ...plugin,
    profiles: [],
    sshAgents: new Set(),
    githubShell: {},
    sshShell: {},
    mcp: noMcp,
    telegram: noTelegram,
    webTools: webTools(),
    dreaming: { enabled: false },
    ...teams,
  },
  ...extra,
});

export const goldenScenarios = {
  // No team plugin at all: only session_status, no plugins.
  "no-teams": () => ({ ...base({}), existing: null, teams: undefined }),
  // The team plugin without native tools (reminders not started).
  "teams-without-native": () =>
    base({ native: undefined, profiles: [agent("a1", { capabilities: {} })] }),
  // An agent that switched nothing on.
  "no-tools": () => base({ profiles: [agent("a1", { capabilities: {} })] }),
  // Shell on approval and full, with GitHub and SSH folders on the PATH.
  shell: () =>
    base(
      {
        profiles: [
          agent("a1", { shell: "approval", capabilities: { memory: true } }),
          agent("a2", { shell: "full", capabilities: { reminders: true } }),
          agent("a3", { shell: "off" }),
        ],
        sshAgents: new Set(["a2"]),
        githubShell: { a1: ["/golden/github/a1/bin"] },
        sshShell: { a2: ["/golden/ssh/a2/bin"] },
      },
      { shell: { pathPrepend: ["/opt/homebrew/bin", "/usr/local/bin"] } },
    ),
  // A stdio and a streamable HTTP server, an OAuth server and an unusable one.
  mcp: () =>
    base({
      profiles: [
        agent("a1", { capabilities: { memory: true } }),
        agent("a2", { capabilities: {} }),
        agent("a3", { archivedAt: "2026-10-01T00:00:00.000Z" }),
      ],
      mcp: {
        servers: [
          {
            id: "s1",
            name: "files",
            transport: "stdio",
            command: "/usr/bin/node",
            args: ["server.js", "--root", "/tmp"],
            cwd: "/srv/files",
          },
          { id: "s2", name: "remote", transport: "http", url: "https://mcp.example/x" },
          {
            id: "s3",
            name: "login",
            transport: "sse",
            url: "https://oauth.example/sse",
            auth: "oauth",
            oauthScope: "read",
          },
          { id: "s4", name: "broken", transport: "stdio", command: "relative" },
        ],
        bindings: { a1: ["s1", "s2", "s3"], a2: ["s2", "s4"], a3: ["s1"] },
        secrets: {
          s1: { headers: {}, env: { TOKEN: "stdio-secret" } },
          s2: { headers: { Authorization: "Bearer http-secret" }, env: {} },
          s4: { headers: {}, env: {} },
        },
        redirectUrl: "https://agentpier.example/api/mcp/oauth/callback",
      },
    }),
  // Bundled and catalog skills, the built-in shopping skill and a shadowed name.
  skills: () =>
    base(
      {
        profiles: [
          agent("a1", {
            skills: ["weather", "github", "agentpier-shopping"],
            capabilities: { memory: true, browser: true },
          }),
          agent("a2", { skills: ["summarize"], capabilities: { memory: true } }),
        ],
        webTools: webTools({
          browser: { available: true, executablePath: "/golden/chromium" },
        }),
      },
      { skillShadows: { "ap-a1": ["github"] } },
    ),
  // Each web search provider the runtime may bundle, fetch, images and PDFs.
  "web-search": () =>
    base({
      profiles: [
        agent("a1", {
          capabilities: {
            webSearch: true,
            webFetch: true,
            documents: true,
            readPdfs: true,
            createImages: true,
            memory: true,
          },
        }),
        agent("a2", { capabilities: { webSearch: true } }),
      ],
      webTools: webTools({
        search: { provider: "brave", key: "brave-key" },
        searchPlugins: {
          brave: { id: "brave", directory: "/golden/plugins/brave" },
          tavily: { id: "tavily", directory: "/golden/plugins/tavily" },
        },
        images: { ready: true },
        pdf: { ready: true, connectionId: "c1", modelId: "gpt-pdf" },
        documentExtract: true,
      }),
    }),
  "web-search-unavailable": () =>
    base({
      profiles: [agent("a1", { capabilities: { webSearch: true } })],
      webTools: webTools({
        search: { provider: "tavily", key: "k", unavailable: true },
        searchPlugins: { tavily: { id: "tavily", directory: "/golden/plugins/tavily" } },
      }),
    }),
  // The browser with a visible window, a released one and a member slot map.
  browser: () =>
    base({
      profiles: [
        agent("a1", { capabilities: { browser: true }, browserVisible: true }),
        agent("a2", {
          capabilities: {},
          userAccess: { mode: "shared", released: ["browser"] },
        }),
        agent("a3", { capabilities: { browser: true } }),
      ],
      webTools: webTools({
        browser: {
          available: true,
          executablePath: "/golden/chromium",
          visible: { available: true },
        },
        browserAllowPrivateNetwork: true,
      }),
    }),
  // Agents' own Telegram bots with voice notes; an ineligible one is skipped.
  telegram: () =>
    base(
      {
        profiles: [
          agent("a1", { capabilities: { memory: true } }),
          agent("a2", { shell: "full" }),
          agent("a3", { capabilities: {} }),
        ],
        telegram: {
          accounts: [
            {
              assistantId: "a3",
              botId: "b3",
              token: "333:tok",
              tokenRevision: 2,
              people: ["300", "301"],
            },
            {
              assistantId: "a1",
              botId: "b1",
              token: "111:tok",
              tokenRevision: 1,
              people: ["100", "x"],
            },
            {
              assistantId: "a2",
              botId: "b2",
              token: "222:tok",
              tokenRevision: 1,
              people: ["200"],
            },
          ],
          speech: { apiKey: "dg-key", keyRevision: 4, model: "nova-3", language: "de" },
          unreadable: false,
        },
      },
      // A bot of an agent the file does not define yet waits for the next start.
      { existing: roster([agent("a1"), agent("a3")]) },
    ),
  // A lead, its permanent member and a temporary member running on its grants, and a
  // user agent under the hard lock.
  team: () =>
    base({
      profiles: [
        agent("lead", {
          capabilities: { memory: true, reminders: true, webFetch: true },
          shell: "approval",
          skills: ["weather"],
        }),
        agent("perm", {
          teamMemberId: "lead",
          lifetime: "permanent",
          capabilities: { memory: true },
          leadCapabilities: { documents: true },
        }),
        agent("temp", {
          teamMemberId: "lead",
          lifetime: "temporary",
          inherited: {
            capabilities: { webFetch: true },
            shell: "approval",
            skills: ["weather"],
            ssh: true,
          },
        }),
        agent("user", {
          capabilities: { memory: true, reminders: true },
          shell: "full",
          userAccess: { mode: "own" },
        }),
      ],
      sshAgents: new Set(["temp", "lead"]),
      dreaming: { enabled: true, hour: 3, timeZone: "Europe/Berlin" },
    }),
  // A restored file with legacy roster shapes, foreign keys and a TLS listener.
  "existing-legacy": () =>
    base(
      { profiles: [agent("a1", { capabilities: { memory: true } })] },
      {
        existing: {
          agents: {
            list: [
              { id: "main", default: true },
              {
                id: "ap-a1",
                tools: { allow: ["exec", "write"], exec: { mode: "full" } },
              },
            ],
          },
          models: { providers: { p: { baseUrl: "http://127.0.0.1:9" } } },
          mcp: { servers: { stale: { url: "https://stale.example" } } },
          secrets: { x: 1 },
          custom: { kept: true },
          gateway: { auth: { token: "old" } },
        },
        tls: { certPath: "/golden/tls/cert.pem", keyPath: "/golden/tls/key.pem" },
        maintenance: true,
        overrides: [{ path: "agents.defaults.timeoutSeconds", value: 3600 }],
      },
    ),
};
