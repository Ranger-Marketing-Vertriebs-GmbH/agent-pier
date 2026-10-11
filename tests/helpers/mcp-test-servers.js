import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isMainModule } from "../../server/lib/is-main-module.js";

// Minimal MCP servers for the OpenClaw MCP contract. Each exposes one `echo` tool
// that answers `echo:<text>` and records every call.

/** Run as `<absolute node> <this file> <record file>` for the stdio server. */
export const stdioMcpScript = fileURLToPath(import.meta.url);

function echoServer(name, record) {
  const server = new McpServer({ name, version: "1.0.0" });
  server.registerTool(
    "echo",
    {
      description: "Returns the given text.",
      inputSchema: { text: z.string() },
    },
    async ({ text }) => {
      record({ tool: "echo", text });
      return { content: [{ type: "text", text: `echo:${text}` }] };
    },
  );
  return server;
}

/**
 * A stateless Streamable HTTP MCP server on 127.0.0.1. `calls` holds each tool call
 * with the request headers it arrived with; `requests` counts every HTTP request.
 */
export async function httpMcpServer() {
  const calls = [];
  const state = { requests: 0, methods: [] };
  const listener = http.createServer(async (req, res) => {
    state.requests++;
    state.methods.push(`${req.method} ${req.headers.accept ?? ""}`);
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let bytes = "";
    for await (const part of req) bytes += part;
    const headers = { ...req.headers };
    const server = echoServer("http-echo", (call) => calls.push({ ...call, headers }));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    let body;
    try {
      body = JSON.parse(bytes);
    } catch {
      res.writeHead(400).end();
      return;
    }
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise((r) => listener.listen(0, "127.0.0.1", r));
  return {
    calls,
    state,
    url: `http://127.0.0.1:${listener.address().port}/mcp`,
    close: () =>
      new Promise((r) => {
        listener.closeAllConnections();
        listener.close(r);
      }),
  };
}

/** Reads the stdio server's record file: one `start` line per process, then calls. */
export function stdioRecords(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * Files below `dataDir` that hold any of `values`, except copies of OpenClaw's
 * configuration (openclaw.json, its backups and atomic-write temporaries), which
 * hold them by design, and files below the `exempt` directories.
 */
export function leakedFiles(dataDir, values, exempt = []) {
  const found = [];
  const configuration = (text) => {
    try {
      const parsed = JSON.parse(text);
      return Boolean(parsed.gateway && parsed.mcp);
    } catch {
      return false;
    }
  };
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (exempt.includes(file)) continue;
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) {
        let text;
        try {
          text = fs.readFileSync(file, "utf8");
        } catch {
          continue; // removed while walking
        }
        if (values.some((v) => text.includes(v)) && !configuration(text))
          found.push(file);
      }
    }
  };
  walk(dataDir);
  return found;
}

/**
 * A safety net for t.after: ends every stdio server process recorded in `file` that
 * still runs (the Gateway normally ends them at removal or stop) and waits briefly.
 */
export async function endStdioServers(file) {
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const pids = [
    ...new Set(
      stdioRecords(file)
        .filter((e) => e.event === "start")
        .map((e) => e.pid),
    ),
  ];
  for (const pid of pids.filter(alive))
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* Already gone. */
    }
  for (let n = 0; n < 30 && pids.some(alive); n++)
    await new Promise((r) => setTimeout(r, 100));
  for (const pid of pids.filter(alive))
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* Already gone. */
    }
}

if (isMainModule(import.meta.url)) {
  const file = process.argv[2];
  const write = (entry) =>
    fs.appendFileSync(file, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
  // The environment the Gateway spawned the server with; secret values are reduced
  // to their presence so the record file never holds them.
  write({
    event: "start",
    cwd: process.cwd(),
    ppid: process.ppid,
    env: {
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      PATH: process.env.PATH,
      MCP_FIXTURE_SECRET: process.env.MCP_FIXTURE_SECRET ? "set" : "unset",
    },
  });
  process.on("exit", () => write({ event: "exit" }));
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => {
      write({ event: signal });
      process.exit(0);
    });
  const server = echoServer("stdio-echo", (call) => write({ event: "call", ...call }));
  await server.connect(new StdioServerTransport());
}
