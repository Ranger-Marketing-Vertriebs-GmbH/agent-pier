import { navigateTo } from "./navigation.js";
import { baseURL as base } from "./browser.js";
export const stamp = "2026-09-06T10:00:00Z";
export async function fixture(page) {
  const state = {
    tools: [{ id: "codex", name: "Codex", installed: true }],
    accounts: [
      {
        id: "local-codex",
        name: "Lokal",
        tool: "codex",
        kind: "local",
        hasSecret: false,
        createdAt: stamp,
      },
    ],
    sessions: [],
    home: "/home/test",
    remoteUrl: null,
  };
  const repositories = {
    credentials: [
      {
        id: "personal",
        name: "Persönlich",
        host: "https://github.com",
        hasSecret: true,
        agentDefault: true,
        createdAt: stamp,
      },
    ],
    projects: [],
  };
  const writes = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const body = request.postDataJSON();
    let result = {};
    if (method !== "GET") writes.push({ path, method, body });
    if (path === "/api/state") result = state;
    else if (path === "/api/pipeline-profiles") result = { profiles: [] };
    else if (path === "/api/ssh-accesses") result = { accesses: [] };
    else if (path === "/api/accounts/local-codex/auth-status")
      result = { state: "unauthenticated", checkedAt: Date.now() };
    else if (path === "/api/repositories") result = repositories;
    else if (path === "/api/repositories/discover")
      result = {
        organizations: [],
        repositories: [],
        total: 0,
        page: 1,
        hasMore: false,
        truncated: false,
      };
    else if (path === "/api/git-credentials") {
      result = {
        id: "work",
        name: body.name,
        host: body.host,
        hasSecret: true,
        agentDefault: body.agentDefault,
        createdAt: stamp,
      };
      repositories.credentials.push(result);
    } else if (path.startsWith("/api/git-credentials/")) {
      const id = path.split("/").at(-1);
      const credential = repositories.credentials.find((item) => item.id === id);
      if (method === "DELETE")
        repositories.credentials = repositories.credentials.filter(
          (item) => item.id !== id,
        );
      if (method === "PATCH")
        Object.assign(credential, {
          name: body.name,
          host: body.host,
          agentDefault: body.agentDefault,
        });
      result = credential || {};
    } else if (path === "/api/repositories/clone") {
      result = {
        id: "project",
        name: body.folderName,
        path: `${body.parentDirectory}/${body.folderName}`,
        url: "https://github.com/acme/project.git",
        credentialId: body.credentialId,
        createdAt: stamp,
      };
      repositories.projects.push(result);
    } else if (path === "/api/sessions") {
      result = {
        id: "session-repo",
        ...body,
        tool: "codex",
        status: "running",
        createdAt: stamp,
      };
      state.sessions.push(result);
    } else {
      await route.fulfill({
        status: 500,
        json: { error: `Unexpected fixture request: ${method} ${path}` },
      });
      throw new Error(`Unexpected fixture request: ${method} ${path}`);
    }
    if (path.startsWith("/api/git-credentials") && method !== "GET") {
      if (result?.agentDefault && method !== "DELETE")
        for (const credential of repositories.credentials)
          if (credential.id !== result.id && credential.host === result.host)
            credential.agentDefault = false;
      for (const host of new Set(
        repositories.credentials.map((credential) => credential.host),
      )) {
        const sameHost = repositories.credentials.filter(
          (credential) => credential.host === host,
        );
        if (!sameHost.some((credential) => credential.agentDefault))
          sameHost[0].agentDefault = true;
      }
    }
    await route.fulfill({ json: result });
  });
  await page.routeWebSocket("**/api/sessions/*/terminal", (socket) => {
    socket.send(JSON.stringify({ type: "output", data: "Ready\r\n" }));
  });
  return { repositories, writes, state };
}

export async function openRepositories(page) {
  await page.goto(base);
  if (await page.getByRole("button", { name: "Navigation öffnen" }).isVisible())
    await page.getByRole("button", { name: "Navigation öffnen" }).click();
  await navigateTo(page, "Repositories");
}
