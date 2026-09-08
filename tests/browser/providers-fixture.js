import { baseURL } from "../helpers/browser.js";
export async function fixture(page, { account, session } = {}) {
  const providers = ["openrouter", "zai", "zai-coding-plan"].map((id) => ({
    id,
    name: {
      openrouter: "OpenRouter",
      zai: "Z.ai API",
      "zai-coding-plan": "Z.ai Coding Plan",
    }[id],
    tools: ["codex", "claude", "opencode"],
  }));
  const router = {
    providerId: "openrouter",
    modelId: "z-ai/glm-5.3",
    label: "GLM 5.3",
    contextTokens: 1310720,
    routingContextTokens: 1048576,
    outputTokens: 262144,
    tools: ["codex", "claude", "opencode"],
    source: "https://openrouter.ai/api/v1/models",
    fetchedAt: "2026-09-06T10:00:00Z",
  };
  const catalogs = {
    openrouter: [
      router,
      {
        ...router,
        modelId: "example/unknown",
        label: "Unknown limits",
        contextTokens: null,
        routingContextTokens: null,
        outputTokens: null,
      },
    ],
    zai: [
      {
        ...router,
        providerId: "zai",
        modelId: "glm-5.3",
        contextTokens: 1000000,
        routingContextTokens: null,
        outputTokens: 131072,
        codexContextTokens: 1048576,
        source: "https://models.dev/api.json",
      },
    ],
  };
  catalogs["zai-coding-plan"] = catalogs.zai.map((model) => ({
    ...model,
    providerId: "zai-coding-plan",
  }));
  const state = {
    home: "/fixture",
    tools: providers[0].tools.map((id) => ({ id, name: id, installed: true })),
    accounts: account ? [account] : [],
    sessions: session ? [session] : [],
    providerConnections: [],
  };
  const controls = {
    state,
    catalogs,
    calls: [],
    failRefresh: false,
    failCatalog: false,
    holdProvider: null,
    release: null,
    modelState: null,
    failConnection: false,
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname,
      method = request.method();
    const body = method === "GET" ? null : request.postDataJSON();
    controls.calls.push({ path, method, body, tool: url.searchParams.get("tool") });
    if (path === "/api/state") return route.fulfill({ json: state });
    if (path === "/api/ssh-accesses") return route.fulfill({ json: { accesses: [] } });
    if (path.startsWith("/api/provider-connections")) {
      if (method === "GET")
        return route.fulfill({ json: { connections: state.providerConnections } });
      if (controls.failConnection)
        return route.fulfill({
          status: 409,
          json: { error: "Fixture connection conflict" },
        });
      const id = path.split("/").at(-1);
      if (method === "DELETE") {
        state.providerConnections = state.providerConnections.filter(
          (item) => item.id !== id,
        );
        return route.fulfill({ status: 204 });
      }
      const existing =
        method === "PATCH"
          ? state.providerConnections.find((item) => item.id === id)
          : {};
      const connection = {
        ...existing,
        ...body,
        id: existing.id || "connection-one",
        hasSecret: body.removeApiKey ? false : Boolean(body.apiKey || existing.hasSecret),
        tools:
          body.providerId === "openrouter" ||
          existing.providerId === "openrouter" ||
          (body.responsesAccess ?? existing.responsesAccess)
            ? ["codex", "claude", "opencode"]
            : ["claude", "opencode"],
        createdAt: "2026-09-07T12:00:00Z",
        updatedAt: "2026-09-07T12:00:00Z",
      };
      delete connection.apiKey;
      delete connection.removeApiKey;
      state.providerConnections = [
        ...state.providerConnections.filter((item) => item.id !== connection.id),
        connection,
      ];
      return route.fulfill({ status: method === "POST" ? 201 : 200, json: connection });
    }
    if (path === "/api/sessions" && method === "POST") {
      const connection = state.providerConnections.find(
        (item) => item.id === body.providerConnectionId,
      );
      const created = {
        ...body,
        id: "created-session",
        status: "running",
        accountId: connection
          ? "internal-isolated-profile"
          : body.accountId || `local-${body.tool}`,
        ...(connection
          ? {
              access: {
                providerConnectionId: connection.id,
                providerConnectionName: connection.name,
                providerId: connection.providerId,
                providerModelId: body.providerModelId,
              },
            }
          : {}),
      };
      state.sessions.push(created);
      return route.fulfill({ json: created });
    }
    if (path === "/api/providers")
      return route.fulfill({ json: { providers, status: {} } });
    const catalog = /^\/api\/providers\/([^/]+)\/(models|refresh)$/.exec(path);
    if (catalog) {
      if (catalog[2] === "models" && controls.failCatalog)
        return route.fulfill({
          status: 502,
          json: { error: "Fixture catalog unavailable" },
        });
      if (catalog[2] === "refresh" && controls.failRefresh)
        return route.fulfill({
          status: 502,
          json: { error: "Fixture catalog unavailable" },
        });
      if (controls.holdProvider === catalog[1])
        await new Promise((resolve) => {
          controls.release = resolve;
        });
      return route.fulfill({
        json: {
          models: catalogs[catalog[1]],
          status: {
            source: catalog[2] === "refresh" ? "remote" : "bundled",
            stale: catalog[2] !== "refresh",
            fetchedAt: "2026-09-06T10:00:00Z",
            error: null,
          },
        },
      });
    }
    if (path.startsWith("/api/accounts") && ["POST", "PATCH"].includes(method)) {
      const current =
        method === "PATCH" ? state.accounts.find((a) => path.endsWith(a.id)) : {};
      if (
        method === "PATCH" &&
        state.sessions.some(
          (item) => item.accountId === current.id && item.status === "running",
        ) &&
        (body.apiKey || body.removeApiKey || Object.hasOwn(body, "provider"))
      )
        return route.fulfill({
          status: 409,
          json: { error: "Stop before changing provider credentials." },
        });
      const next = {
        ...current,
        ...body,
        id: current.id || "provider-account",
        kind: "managed",
        hasSecret: body.removeApiKey ? false : Boolean(body.apiKey || current.hasSecret),
      };
      delete next.apiKey;
      delete next.removeApiKey;
      if (next.provider === null) delete next.provider;
      state.accounts = [next];
      return route.fulfill({ json: next });
    }
    if (path.endsWith("/chat"))
      return route.fulfill({ json: { availability: "ready", messages: [], tasks: [] } });
    if (path.endsWith("/models/cancel")) {
      controls.modelState = { ...controls.modelState, picker: null, pending: false };
      return route.fulfill({ json: controls.modelState });
    }
    if (path.endsWith("/models"))
      return route.fulfill({
        json: {
          ...controls.modelState,
          currentModel: "native-confirmed-model",
          picker: null,
          pending: false,
          configuration: session?.provider,
          modelChangeRequiresRestart: true,
          ...controls.modelState,
        },
      });
    if (path.endsWith("/auth-status"))
      return route.fulfill({ json: { state: "unknown" } });
    if (path.endsWith("/input"))
      return route.fulfill({
        json: { deliveryId: body.deliveryId, status: "handed-off" },
      });
    throw new Error(`Unexpected provider fixture request: ${method} ${path}`);
  });
  await page.routeWebSocket("**/terminal", (socket) =>
    socket.send(JSON.stringify({ type: "status", status: "running" })),
  );
  return controls;
}

export async function createForm(page, tool = "codex", controls) {
  controls.state.accounts = [
    {
      id: "legacy-gateway",
      name: "Gateway account",
      tool,
      kind: "managed",
      hasSecret: false,
      provider: { id: "zai-coding-plan", modelId: "legacy-model" },
    },
  ];
  await page.goto(baseURL + "/accounts");
  await page
    .getByRole("button", { name: "Gateway account bearbeiten", exact: true })
    .click();
  await page.getByLabel("API-Anbieter", { exact: true }).waitFor();
}
