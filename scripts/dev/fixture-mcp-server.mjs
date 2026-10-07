#!/usr/bin/env node
// Minimal stdio MCP server used only by capture-cli-requests.mjs. It offers one tool
// with a deliberately long name so recorded client requests show how CLIs namespace
// MCP tools. Newline-delimited JSON-RPC 2.0 on stdin/stdout; no network access.
import readline from "node:readline";

const tool = {
  name: "lookup_project_documentation_with_a_deliberately_long_tool_name",
  description: "Returns a fixed documentation snippet for a topic.",
  inputSchema: {
    type: "object",
    properties: { topic: { type: "string", description: "Topic to look up" } },
    required: ["topic"],
  },
};

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function fail(id, code, message) {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`,
  );
}

const handlers = {
  initialize: (params) => ({
    protocolVersion: params?.protocolVersion ?? "2025-06-18",
    capabilities: { tools: {} },
    serverInfo: { name: "fixture", version: "1.0.0" },
  }),
  ping: () => ({}),
  "tools/list": () => ({ tools: [tool] }),
  "tools/call": (params) => ({
    content: [{ type: "text", text: `Documentation for ${params?.arguments?.topic}.` }],
  }),
};

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined) return;
  const handler = handlers[message.method];
  if (handler) reply(message.id, handler(message.params));
  else fail(message.id, -32601, `Method not found: ${message.method}`);
});
