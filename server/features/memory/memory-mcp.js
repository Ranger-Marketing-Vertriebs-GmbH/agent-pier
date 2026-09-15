import { StringDecoder } from "node:string_decoder";
import { once } from "node:events";
import { memoryClient } from "./memory-client.js";

const args = process.argv.slice(2);
let relay;
try {
  if (args.length !== 4 || args[0] !== "--socket" || args[2] !== "--capability")
    throw Error();
  relay = memoryClient(args[1], args[3]);
} catch {
  process.stderr.write(
    "Memory transport configuration unavailable. Reload this session.\n",
  );
  process.exit(1);
}
let initialized = false,
  calls = 0,
  buffer = "";
const decoder = new StringDecoder("utf8");
async function send(message) {
  if (message && !process.stdout.write(JSON.stringify(message) + "\n"))
    await once(process.stdout, "drain");
}
async function handle(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    await send({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Invalid JSON request." },
    });
    return;
  }
  try {
    if (request?.method === "tools/call" && !initialized) throw Error();
    const response = await relay(request);
    if (request?.method === "initialize" && response?.result) initialized = true;
    await send(response);
  } catch {
    if (request?.id !== undefined)
      await send({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32000,
          message:
            "Memory unavailable. Check AgentPier and session access, then retry. Writes are not automatically retried; reuse requestId for an identical write retry.",
        },
      });
  }
}
try {
  for await (const chunk of process.stdin) {
    buffer += decoder.write(chunk);
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      if (Buffer.byteLength(buffer.slice(0, end)) > 65536 || ++calls > 10000)
        throw Error();
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line.trim()) await handle(line);
    }
    if (Buffer.byteLength(buffer) > 65536) throw Error();
  }
} catch {
  process.stderr.write("Memory transport closed: input or output limit exceeded.\n");
  process.exitCode = 1;
}
