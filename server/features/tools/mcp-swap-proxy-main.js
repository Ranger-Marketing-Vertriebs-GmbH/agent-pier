// The swap proxy's entry: `node mcp-swap-proxy-main.js <spec file> <variant>`. The
// spec file (written by AgentPier) names the server: `{ command, variants: { <variant>:
// args }, env, statusDir }`. The proxy runs `command` with its variant's args (a mode
// chosen when the session started never changes underneath it), follows the file and
// swaps the server when `command` changes (another version), and keeps
// `<statusDir>/<pid>.json` with the command it runs and a failed swap's code.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SwapProxy } from "./mcp-swap-proxy.js";

const [specFile, variant] = process.argv.slice(2);

function readSpec() {
  try {
    const spec = JSON.parse(fs.readFileSync(specFile, "utf8"));
    const args = spec?.variants?.[variant];
    if (typeof spec?.command !== "string" || !Array.isArray(args)) return null;
    const env = spec.env && typeof spec.env === "object" ? spec.env : {};
    return { command: spec.command, args, env, statusDir: spec.statusDir };
  } catch {
    return null;
  }
}

const first = readSpec();
const statusFile =
  typeof first?.statusDir === "string"
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
  readSpec,
  report,
  exit: (code) => {
    if (statusFile) fs.rmSync(statusFile, { force: true });
    process.exit(code);
  },
});
if (!first) process.stderr.write(`AgentPier's MCP proxy cannot read ${specFile}.\n`);
proxy.start();

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => proxy.fromClientLine(chunk));
process.stdin.on("end", () => void proxy.close(0));
process.stdout.on("error", () => void proxy.close(0));
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"])
  process.on(signal, () => void proxy.close(0));

fs.watchFile(specFile, { interval: 1000 }, () => void proxy.reconcile());
