/**
 * A minimal stdio MCP server for the swap proxy's tests:
 *
 *   node tests/helpers/fake-swap-mcp.mjs <version> [tool,tool,...] [--fail]
 *
 * It answers `initialize` (serverInfo.version = <version>, tools capability),
 * `tools/list` (the named tools, default "echo") and `tools/call`:
 * - `whoami` → `{ version, pid, initialized }`;
 * - `slow` → the same after `arguments.ms`;
 * - `crash` → exits at once without an answer;
 * - `ask` → sends `roots/list` to the client and answers with the client's reply.
 * `--fail` exits before answering anything. Every line it receives is appended to
 * $FAKE_SWAP_LOG (when set) as `<pid> <line>`.
 */
import fs from "node:fs";

const [version = "1", names = "echo", flag] = process.argv.slice(2);
if (flag === "--fail") process.exit(3);
const tools = names.split(",").map((name) => ({ name, inputSchema: { type: "object" } }));
let initialized = false;
let asked = 0;
const waiting = new Map();
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const result = (id, value) =>
  send({
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text: JSON.stringify(value) }], value },
  });

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (process.env.FAKE_SWAP_LOG)
      fs.appendFileSync(process.env.FAKE_SWAP_LOG, `${process.pid} ${line}\n`);
    handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));

function handle(msg) {
  if (msg.method === undefined) {
    const reply = waiting.get(msg.id);
    waiting.delete(msg.id);
    return reply?.(msg.result);
  }
  if (msg.method === "notifications/initialized") initialized = true;
  if (msg.id === undefined) return;
  if (msg.method === "initialize")
    return send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-swap", version },
      },
    });
  if (msg.method === "tools/list")
    return send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
  if (msg.method !== "tools/call")
    return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "nope" } });
  const me = { version, pid: process.pid, initialized };
  const name = msg.params?.name;
  if (name === "crash") process.exit(1);
  if (name === "slow")
    return setTimeout(() => result(msg.id, me), msg.params.arguments.ms);
  if (name === "ask") {
    const id = asked++;
    waiting.set(id, (roots) => result(msg.id, { ...me, roots }));
    return send({ jsonrpc: "2.0", id, method: "roots/list" });
  }
  result(msg.id, me);
}
