import fs from "node:fs";
import { pidStart } from "../../../vendor/agentbus/core/proc.js";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { once } from "node:events";
import { readJSON, writePrivate } from "../../lib/storage.js";
import { authorizeSsh, capabilityFile } from "./ssh-capability.js";
import { SshAccessStore } from "./ssh-access-store.js";
import { SshSessions } from "./ssh-sessions.js";
import { SshTools, sshTools } from "./ssh-tools.js";
const args = process.argv.slice(2);
if (
  args.length !== 4 ||
  args[0] !== "--data-dir" ||
  !path.isAbsolute(args[1]) ||
  args[2] !== "--capability" ||
  !path.isAbsolute(args[3])
)
  throw Error("Invalid SSH transport arguments.");
const dataDir = args[1];
let capability;
try {
  capability = readJSON(args[3], null);
  if (!capability) throw Error();
} catch {
  process.stderr.write("SSH transport capability unavailable.\n");
  process.exit(1);
}
const readyFile = path.join(
  path.dirname(capabilityFile(dataDir, capability.sessionId)),
  "ready.json",
);
const store = new SshAccessStore({ dataDir });
const grants = new SshSessions({ dataDir, store });
const tools = new SshTools({ dataDir, capability, grants, store });
let initialized = false,
  handshake = false,
  calls = 0,
  buffer = "";
const parent = process.ppid;
const parentStart = pidStart(parent);
const started = pidStart(process.pid);
async function cleanup() {
  await tools.close();
  try {
    const ready = readJSON(readyFile, null);
    if (ready?.pid === process.pid && ready.generation === capability.generation)
      fs.rmSync(readyFile, { force: true });
  } catch {
    /* Already revoked. */
  }
}
let shuttingDown;
function shutdown() {
  shuttingDown ||= cleanup().then(() => process.exit(0));
  return shuttingDown;
}
const watch = setInterval(() => {
  try {
    // A child is reparented when its parent exits; that live parent PID cannot
    // be reused. Keep start-time checks on requests and readiness, not idle ticks.
    if (process.ppid !== parent || !parentStart) throw Error();
    process.kill(parent, 0);
  } catch {
    void shutdown();
  }
}, 500);
watch.unref();
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"])
  process.on(signal, () => {
    void shutdown();
  });
async function send(message) {
  let encoded = JSON.stringify(message) + "\n";
  if (Buffer.byteLength(encoded) > 524288)
    encoded =
      JSON.stringify({
        jsonrpc: "2.0",
        id: message.id ?? null,
        error: { code: -32000, message: "SSH response exceeds output budget." },
      }) + "\n";
  if (!process.stdout.write(encoded)) await once(process.stdout, "drain");
}
async function authorizeStartup() {
  // Session metadata is persisted immediately after the CLI is spawned.
  for (let attempt = 0; ; attempt++) {
    try {
      return authorizeSsh(dataDir, capability);
    } catch (error) {
      if (attempt >= 40) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
async function handle(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return send({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Invalid JSON request." },
    });
  }
  if (
    !request ||
    Array.isArray(request) ||
    request.jsonrpc !== "2.0" ||
    typeof request.method !== "string" ||
    (request.id !== undefined &&
      typeof request.id !== "string" &&
      typeof request.id !== "number")
  )
    return send({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid request." },
    });
  const { id, method } = request;
  try {
    if (process.ppid !== parent || !parentStart || pidStart(parent) !== parentStart)
      throw Error();
    if (method === "initialize") await authorizeStartup();
    else authorizeSsh(dataDir, capability);
    if (id === undefined) {
      if (method === "notifications/initialized" && handshake) {
        initialized = true;
        writePrivate(readyFile, {
          generation: capability.generation,
          pid: process.pid,
          pidStart: started,
          parentPid: parent,
          parentStart,
        });
      }
      return;
    }
    let result;
    if (method === "initialize") {
      handshake = true;
      const requested = request.params?.protocolVersion;
      result = {
        protocolVersion: [
          "2024-11-05",
          "2025-03-26",
          "2025-06-18",
          "2025-11-25",
        ].includes(requested)
          ? requested
          : "2025-11-25",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "agentpier-ssh", version: "1.0.0" },
      };
    } else if (method === "ping") result = {};
    else if (method === "tools/list" && initialized) result = { tools: sshTools };
    else if (method === "tools/call" && initialized) {
      try {
        result = {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                await tools.call(request.params?.name, request.params?.arguments),
              ),
            },
          ],
        };
      } catch (error) {
        result = {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: error.status ? error.message : "SSH operation failed.",
                status: error.status || 500,
              }),
            },
          ],
        };
      }
    } else throw Error("Unsupported method.");
    await send({ jsonrpc: "2.0", id, result });
  } catch (error) {
    if (id !== undefined)
      await send({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: error.status
            ? error.message
            : "SSH transport unavailable or method unsupported.",
        },
      });
  }
}
const decoder = new StringDecoder("utf8");
try {
  for await (const chunk of process.stdin) {
    buffer += decoder.write(chunk);
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      if (Buffer.byteLength(buffer.slice(0, end)) > 65536 || ++calls > 10000)
        throw Error();
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line.trim()) await handle(line);
    }
    if (Buffer.byteLength(buffer) > 65536) throw Error();
  }
} catch {
  process.stderr.write("SSH transport closed: protocol limit exceeded.\n");
  process.exitCode = 1;
} finally {
  clearInterval(watch);
  await cleanup();
}
