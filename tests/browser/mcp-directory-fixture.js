import { wizardSetup } from "./mcp-wizard-fixture.js";

/** A registry entry as PR 3's DTO, built from the server-side normaliser's fixtures. */
export const dto = {
  opnsense: {
    name: "io.github.example/opnsense-mcp-server",
    title: "OPNsense",
    description: "Manage an OPNsense firewall: rules, aliases, DHCP and diagnostics.",
    version: "0.4.1",
    namespace: "io.github.example",
    status: "active",
    statusMessage: "",
    publishedAt: "2025-10-01T10:00:00Z",
    repositoryUrl: "https://github.com/example/opnsense-mcp-server",
    websiteUrl: null,
    installable: true,
    options: [
      {
        kind: "npm",
        identifier: "opnsense-mcp-server",
        version: "0.4.1",
        transport: "stdio",
        url: null,
        urlVariables: [],
        packageArgs: [],
        ignored: ["runtimeHint"],
        unsupportedReason: null,
        headers: [],
        env: [
          {
            name: "OPNSENSE_URL",
            description: "Address of your OPNsense",
            required: true,
            secret: false,
            format: "string",
            default: null,
            choices: [],
            value: null,
            variables: [],
          },
          {
            name: "OPNSENSE_API_KEY",
            description: "API key from OPNsense",
            required: true,
            secret: true,
            format: "string",
            default: null,
            choices: [],
            value: null,
            variables: [],
          },
          {
            name: "OPNSENSE_ALLOW_WRITES",
            description: "Allow write access",
            required: false,
            secret: false,
            format: "boolean",
            default: "false",
            choices: [],
            value: null,
            variables: [],
          },
        ],
      },
      {
        kind: "unsupported",
        registryType: "oci",
        identifier: "ghcr.io/example/opnsense-mcp-server",
        version: "0.4.1",
        transport: "stdio",
        url: null,
        urlVariables: [],
        packageArgs: [],
        ignored: [],
        env: [],
        headers: [],
        unsupportedReason: "registryType",
      },
    ],
  },
  container: {
    name: "io.github.example/container-only",
    title: "",
    description: "Runs only as a container.",
    version: "1.0.0",
    namespace: "io.github.example",
    status: "deprecated",
    statusMessage: "Moved.",
    publishedAt: null,
    repositoryUrl: null,
    websiteUrl: null,
    installable: false,
    options: [
      {
        kind: "unsupported",
        registryType: "oci",
        identifier: "docker.io/example/server",
        version: "1.0.0",
        transport: "stdio",
        url: null,
        urlVariables: [],
        packageArgs: [],
        ignored: [],
        env: [],
        headers: [],
        unsupportedReason: "registryType",
      },
    ],
  },
  files: {
    name: "com.pulsemcp/remote-filesystem",
    title: "",
    description: "Read and write files in a hosted workspace.",
    version: "1.2.0",
    namespace: "com.pulsemcp",
    status: "active",
    statusMessage: "",
    publishedAt: "2025-11-01T00:00:00Z",
    repositoryUrl: null,
    websiteUrl: null,
    installable: true,
    options: [
      {
        kind: "remote-http",
        identifier: "",
        version: "",
        transport: "http",
        url: "https://{tenant}.files.example.test/mcp",
        urlVariables: [
          {
            name: "tenant",
            description: "Your tenant id",
            required: true,
            secret: false,
            default: null,
            choices: [],
          },
        ],
        packageArgs: [],
        ignored: [],
        env: [],
        headers: [
          {
            name: "Authorization",
            description: "Bearer token",
            required: true,
            secret: true,
            format: "string",
            default: null,
            choices: [],
            value: "Bearer {token}",
            variables: [],
          },
        ],
        unsupportedReason: null,
      },
    ],
  },
};

/** The wizard fixture plus /api/mcp-directory/*. `state.directory` drives the answers. */
export async function directorySetup(page, options = {}) {
  const state = await wizardSetup(page, options);
  state.directory = {
    status: { enabled: true, host: "registry.modelcontextprotocol.io", reachable: true },
    pages: { "": [[dto.opnsense, dto.container, dto.files]] },
    fail: null,
    updates: [],
    ...options.directory,
  };
  await page.route(/\/api\/mcp-directory\//, (route) => {
    const url = new URL(route.request().url());
    state.requests.push({
      method: "GET",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
    });
    const d = state.directory;
    if (url.pathname === "/api/mcp-directory/status")
      return route.fulfill({ json: d.status });
    if (url.pathname === "/api/mcp-directory/updates")
      return route.fulfill({ json: { updates: d.updates } });
    if (d.fail) return route.fulfill(d.fail);
    if (url.pathname === "/api/mcp-directory/servers") {
      const pages = d.pages[url.searchParams.get("search")] ?? d.pages[""] ?? [[]];
      const index = Number(url.searchParams.get("cursor") || 0);
      return route.fulfill({
        json: {
          entries: pages[index] ?? [],
          nextCursor: index + 1 < pages.length ? String(index + 1) : null,
        },
      });
    }
    const name = decodeURIComponent(
      url.pathname.slice("/api/mcp-directory/servers/".length),
    );
    const entry = Object.values(dto).find((item) => item.name === name);
    return route.fulfill(
      entry
        ? { json: entry }
        : {
            status: 404,
            json: {
              code: "MCP_DIRECTORY_NOT_FOUND",
              error: "x",
              messageKey: "mcpDirectory.notFound",
            },
          },
    );
  });
  return state;
}
