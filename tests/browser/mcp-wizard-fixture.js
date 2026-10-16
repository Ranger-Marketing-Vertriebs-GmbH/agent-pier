import { expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { setup } from "./mcp-cli-fixture.js";
import { preview, versions } from "./mcp-packages-fixture.js";

export const phone = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
};

/** A server as POST /mcp-servers answers it, built from the request body. */
export function createdServer(state, body) {
  const stdio = body.transport === "stdio";
  return {
    id: `s${state.nextId++}`,
    name: body.name,
    transport: body.transport,
    revision: 1,
    auth: body.auth ?? "headers",
    ...(stdio
      ? {
          ...(body.source
            ? {}
            : { command: state.commands[body.command] ?? body.command }),
          args: body.args ?? [],
          ...(body.cwd ? { cwd: body.cwd } : {}),
        }
      : { url: body.url.split("?")[0] }),
    ...(body.source
      ? { source: { ...body.source, status: "installing", leadingArgs: 0 } }
      : {}),
    headerNames: Object.keys(body.headers ?? {}),
    envNames: Object.keys(body.env ?? {}),
    clis: [],
    cliSupport: {
      claude: { supported: !(stdio && body.cwd) },
      codex: { supported: body.transport !== "sse" },
      opencode: { supported: true },
    },
    cliStatus: {},
    users: { agents: [], clis: [] },
  };
}

const stdioRefusal = {
  status: 409,
  json: {
    code: "MCP_STDIO_CONFIRMATION_REQUIRED",
    error: "Bestätigung nötig",
    messageKey: "mcpServers.stdioConfirmationRequired",
  },
};

/** mcp-cli-fixture plus what the wizard calls: versions, preview, resolve, create, update. */
export async function wizardSetup(page, options = {}) {
  const state = await setup(page, options);
  Object.assign(state, {
    versions: options.versions ?? {
      ...versions,
      publisher: "Jane Doe, jdoe",
      repositoryUrl: "https://github.com/jdoe/server-x",
    },
    preview: options.preview ?? preview(),
    commands: options.commands ?? {
      uvx: "/opt/homebrew/bin/uvx",
      node: "/usr/local/bin/node",
    },
    nextId: 1,
    refuseCreate: null,
    refusePut: null,
  });
  await page.route(/\/api\/mcp-commands\/resolve/, (route) => {
    const name = new URL(route.request().url()).searchParams.get("name");
    state.requests.push({ method: "GET", path: "/api/mcp-commands/resolve", name });
    const found = state.commands[name];
    return route.fulfill({
      json: found ? { found: true, path: found } : { found: false },
    });
  });
  await page.route(/\/api\/mcp-packages\//, (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.postData() ? request.postDataJSON() : undefined;
    state.requests.push({ method: request.method(), path, body });
    if (path === "/api/mcp-packages/versions")
      return route.fulfill({ json: state.versions });
    if (state.refusePreview) return route.fulfill(state.refusePreview);
    return route.fulfill({ json: state.preview });
  });
  state.finishInstall = (status = "ready") => {
    for (const server of state.servers)
      if (server.source) server.source = { ...server.source, status };
  };
  state.handle = async ({ route, request, path, body }) => {
    const method = request.method();
    if (path === "/api/mcp-servers" && method === "POST") {
      if (state.refuseCreate) return route.fulfill(state.refuseCreate);
      if (body.transport === "stdio" && !body.source && body.confirmStdio !== true)
        return route.fulfill(stdioRefusal);
      const created = createdServer(state, body);
      state.servers.push(created);
      return route.fulfill({ status: body.source ? 202 : 201, json: created });
    }
    const server = state.servers.find((item) =>
      path.startsWith(`/api/mcp-servers/${item.id}`),
    );
    if (server && path.endsWith("/package"))
      return route.fulfill({
        json: { source: server.source, job: null, error: null, programs: [] },
      });
    if (server && method === "PUT") {
      if (state.refusePut) return route.fulfill(state.refusePut);
      if (body.revision !== server.revision)
        return route.fulfill({
          status: 409,
          json: { error: "changed", messageKey: "mcpServers.conflict" },
        });
      const added = (body.clis ?? []).filter((cli) => !server.clis.includes(cli));
      if (server.transport === "stdio" && added.length && body.confirmStdio !== true)
        return route.fulfill(stdioRefusal);
      const { revision: _r, confirmStdio: _c, headers, env, ...rest } = body;
      Object.assign(server, rest, { revision: server.revision + 1 });
      if (headers)
        server.headerNames = Object.keys(headers).filter((k) => headers[k] !== null);
      if (env) server.envNames = Object.keys(env).filter((k) => env[k] !== null);
      if (body.clis) {
        server.cliStatus = Object.fromEntries(
          body.clis.map((cli) => [cli, { status: "written" }]),
        );
        server.users = { ...server.users, clis: body.clis };
      }
      return route.fulfill({ json: server });
    }
    return false;
  };
  return state;
}

export async function openWizard(page, query = "") {
  await page.goto(`${baseURL}/accounts?section=mcp-servers&item=new${query}`);
  const wizard = page.locator(".mcp-wizard");
  await expect(wizard.getByRole("heading", { level: 1 })).toBeVisible();
  return wizard;
}

export async function chooseSource(wizard, label) {
  await wizard.getByRole("radio", { name: label }).check();
  await wizard.getByRole("button", { name: "Continue", exact: true }).click();
}

export const primary = (wizard) => wizard.locator(".mcp-wizard-bar .button.primary");
export const writes = (state) => state.requests.filter((r) => r.method !== "GET");

export async function fits(page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
}
