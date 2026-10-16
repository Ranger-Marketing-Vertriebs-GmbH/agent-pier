import { expect } from "@playwright/test";
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

/** A PyPI release list: PEP 440 versions, one of them yanked by its author. */
export const pypiVersions = {
  latest: "0.4.1",
  versions: [
    {
      version: "0.5.0rc1",
      publishedAt: "2026-09-02T00:00:00Z",
      prerelease: true,
      deprecated: false,
      yanked: false,
    },
    {
      version: "0.4.1",
      publishedAt: "2026-08-19T00:00:00Z",
      prerelease: false,
      deprecated: false,
      yanked: false,
    },
    {
      version: "0.4.0",
      publishedAt: "2026-07-01T00:00:00Z",
      prerelease: false,
      deprecated: false,
      yanked: true,
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
    { name: "helper", version: "1.0.0", path: "helper" },
    { name: "server-x", version: "1.1.0", path: "server-x" },
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
    return state.preview.status
      ? route.fulfill(state.preview)
      : route.fulfill({ json: state.preview });
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

/** POST /mcp-servers answers 202 with an installing packaged server. */
export const acceptCreate = (state) => {
  state.reply = ({ path, method, body }) => {
    if (path !== "/api/mcp-servers" || method !== "POST") return null;
    const server = packagedServer("installing", {
      name: body.name,
      args: body.args || [],
      source: { ...body.source, status: "installing", leadingArgs: 0, errorCode: null },
    });
    state.servers = [server];
    state.packageStatus = {
      source: server.source,
      job: { kind: "install", state: "running", code: null, log: "" },
      error: null,
    };
    return { status: 202, json: server };
  };
};

/** Chooses the package path on the wizard's Source step. */
export async function choosePackage(wizard) {
  await wizard.getByRole("radio", { name: "Package from npm or PyPI" }).check();
  await wizard.getByRole("button", { name: "Continue", exact: true }).click();
}

/** From the package step through Settings to the inline install confirmation. */
export async function toInstall(wizard) {
  const next = wizard.getByRole("button", { name: "Continue", exact: true });
  await next.click();
  await expect(wizard.page()).toHaveURL(/step=settings/);
  await next.click();
  return wizard.getByRole("region", { name: "Install this package?" });
}
