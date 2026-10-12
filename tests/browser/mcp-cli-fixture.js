import { fixture } from "./providers-fixture.js";

/** The central MCP API; `state` records requests and holds what the list returns. */
export async function setup(
  page,
  { language = "en", agents = false, servers = [], finds = [], problems = [] } = {},
) {
  await fixture(page);
  await page.addInitScript(
    (value) => localStorage.setItem("agentpier-language", value),
    language,
  );
  const state = {
    requests: [],
    servers: structuredClone(servers),
    finds: structuredClone(finds),
    problems: structuredClone(problems),
  };
  await page.route("**/api/assistant-feature", (route) =>
    route.fulfill({ json: { enabled: agents, error: null } }),
  );
  await page.route(/\/api\/mcp-servers/, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.postData() ? request.postDataJSON() : undefined;
    state.requests.push({ method: request.method(), path, body });
    if (path === "/api/mcp-servers" && request.method() === "GET")
      return route.fulfill({ json: state.servers });
    if (path === "/api/mcp-servers/cli-finds")
      return route.fulfill({ json: { finds: state.finds, problems: state.problems } });
    if (state.handle) {
      const handled = await state.handle({ route, request, path, body });
      if (handled !== false) return;
    }
    return route.fulfill({ status: 404, json: { error: "unexpected" } });
  });
  return state;
}

export const header = (extra = {}) => ({
  id: "s1",
  name: "docs",
  transport: "http",
  url: "https://mcp.example.test/mcp",
  auth: "headers",
  headerNames: ["Authorization"],
  envNames: [],
  revision: 1,
  ...extra,
});

export const bound = (extra = {}) =>
  header({
    clis: ["claude", "codex"],
    cliSupport: {
      claude: { supported: true },
      codex: { supported: true },
      opencode: { supported: true },
    },
    cliStatus: { claude: { status: "written" }, codex: { status: "conflict" } },
    users: { agents: ["Home"], clis: ["claude", "codex"] },
    ...extra,
  });

export async function openAdd(page) {
  await page
    .getByRole("region", { name: "MCP servers" })
    .getByRole("button", { name: "Add MCP server" })
    .click();
  return page.getByRole("dialog");
}

export const stdioServer = () =>
  bound({
    transport: "stdio",
    url: undefined,
    command: "/usr/bin/true",
    args: [],
    headerNames: [],
    envNames: [],
    cliStatus: { claude: { status: "written" }, codex: { status: "written" } },
  });

export const finds = [
  {
    key: "k1",
    name: "docs",
    clis: ["claude", "codex"],
    adoptable: true,
    transport: "http",
    auth: "headers",
    url: "https://docs.example.test/mcp",
    headerNames: ["Authorization"],
    envNames: [],
  },
  {
    key: "k2",
    name: "my.tool",
    proposedName: "my-tool",
    clis: ["opencode"],
    adoptable: true,
    transport: "stdio",
    auth: "headers",
    command: "true",
    resolvedCommand: "/usr/bin/true",
    headerNames: [],
    envNames: ["TOKEN"],
  },
  {
    key: "k3",
    name: "slow",
    clis: ["codex"],
    adoptable: false,
    reason: "unsupported-fields",
    messageKey: "mcpServers.cliNotAdoptable",
  },
];
