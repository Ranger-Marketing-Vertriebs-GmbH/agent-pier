// The swap proxy's entry: `node mcp-swap-proxy-main.js <spec file>`. The spec file
// (written by AgentPier) names the server `{ command, args, statusDir }`; the proxy
// starts it, follows changes of the file (a new version swaps the server behind the
// client) and keeps `<statusDir>/<pid>.json` with what it runs and a failed swap.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SwapProxy } from "./mcp-swap-proxy.js";

const specFile = process.argv[2];

function readSpec() {
  try {
    const spec = JSON.parse(fs.readFileSync(specFile, "utf8"));
    if (typeof spec?.command !== "string" || !Array.isArray(spec.args ?? [])) return null;
    return spec;
  } catch {
    return null;
  }
}

const first = readSpec();
if (!first) {
  process.stderr.write(`AgentPier's MCP proxy cannot read ${specFile}.\n`);
  process.exit(1);
}
const statusFile =
  typeof first.statusDir === "string"
    ? path.join(first.statusDir, `${process.pid}.json`)
    : null;

function report(status) {
  if (!statusFile) return;
  const tmp = `${statusFile}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(statusFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, ...status }), {
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(tmp, statusFile);
  } catch {
    fs.rmSync(tmp, { force: true });
  }
}

const proxy = new SwapProxy({
  write: (line) => process.stdout.write(line),
  report,
  exit: (code) => {
    if (statusFile) fs.rmSync(statusFile, { force: true });
    process.exit(code);
  },
});
proxy.start(first);

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim()) proxy.fromClient(line);
  }
});
process.stdin.on("end", () => void proxy.close(0));
process.stdout.on("error", () => void proxy.close(0));
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"])
  process.on(signal, () => void proxy.close(0));

fs.watchFile(specFile, { interval: 1000 }, () => {
  const spec = readSpec();
  if (spec) void proxy.swapTo(spec);
});
