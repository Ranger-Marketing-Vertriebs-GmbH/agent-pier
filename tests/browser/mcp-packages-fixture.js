import { setup } from "./mcp-cli-fixture.js";

export const versions = {
  latest: "1.1.0",
  versions: [
    {
      version: "2.0.0-rc.1",
      publishedAt: "2026-10-01T00:00:00Z",
      prerelease: true,
      deprecated: false,
    },
    {
      version: "1.1.0",
      publishedAt: "2026-09-01T00:00:00Z",
      prerelease: false,
      deprecated: false,
    },
    {
      version: "1.0.0",
      publishedAt: "2026-08-01T00:00:00Z",
      prerelease: false,
      deprecated: true,
    },
  ],
};

export const preview = (extra = {}) => ({
  previewId: "p1",
  registry: "npm",
  name: "server-x",
  version: "1.1.0",
  integrity: "sha512-abcdefghijklmnopqrstuvwxyz0123456789",
  dependencyCount: 2,
  dependencies: [
    { name: "helper", version: "1.0.0", path: "node_modules/helper" },
    { name: "server-x", version: "1.1.0", path: "node_modules/server-x" },
  ],
  programs: ["server-x"],
  needsScripts: false,
  diff: null,
  ...extra,
});

/** A packaged stdio server as GET /mcp-servers reports it. */
export const packagedServer = (status, extra = {}) => ({
  id: "s1",
  name: "pkg",
  transport: "stdio",
  command: "/data/toolchains/node/bin/node",
  args: ["/data/mcp-packages/installs/i1/node_modules/server-x/index.js", "--owner"],
  headerNames: [],
  envNames: [],
  revision: 3,
  clis: [],
  cliStatus: {},
  source: {
    registry: "npm",
    name: "server-x",
    version: "1.0.0",
    program: "server-x",
    allowScripts: false,
    status,
    errorCode: status === "failed" ? "MCP_PACKAGE_INSTALL_FAILED" : null,
    leadingArgs: 1,
  },
  ...extra,
});

/**
 * The MCP fixture plus the package routes. `state.packageStatus` answers
 * GET /mcp-servers/:id/package; `state.reply(path, method, body)` may answer writes.
 */
export async function packageSetup(page, options = {}) {
  const state = await setup(page, options);
  state.versions = versions;
  state.preview = preview();
  state.packageStatus = null;
  await page.route(/\/api\/mcp-packages\//, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.postData() ? request.postDataJSON() : undefined;
    state.requests.push({ method: request.method(), path, body });
    if (path.endsWith("/versions"))
      return state.versions.status
        ? route.fulfill(state.versions)
        : route.fulfill({ json: state.versions });
    return route.fulfill({ json: state.preview });
  });
  state.handle = async ({ route, request, path, body }) => {
    if (path.endsWith("/package") && request.method() === "GET")
      return route.fulfill({
        json: state.packageStatus ?? {
          source: state.servers[0]?.source ?? null,
          job: null,
          error: null,
        },
      });
    const reply = await state.reply?.({ path, method: request.method(), body });
    if (reply) return route.fulfill(reply);
    return false;
  };
  return state;
}

export const writes = (state, path) =>
  state.requests.filter((r) => r.method !== "GET" && r.path === path);
