import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

/**
 * Stands in for `child_process.spawn` running `codex mcp login <name> --no-browser`
 * the way Codex 0.160.1 does (docs/cli-mcp-qualification.md): it prints an
 * authorization URL whose `redirect_uri` is the configured callback URL plus a
 * per-server path segment, then waits for the full callback URL on stdin. A line
 * carrying its own state and a code exits 0; anything else exits 1. `runs` records
 * every start; `behave(run)` may replace the default behaviour.
 */
export function fakeCodexLogin({ behave } = {}) {
  const runs = [];
  let count = 0;
  const spawn = (file, args, options) => {
    count += 1;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.signals = [];
    child.exitCode = null;
    const run = { file, args, options, child, written: "", state: `state-${count}` };
    const exit = (code, signal = null) => {
      if (child.exitCode !== null || run.exited) return;
      run.exited = true;
      child.exitCode = code;
      setImmediate(() => child.emit("exit", code, signal));
    };
    run.exit = exit;
    child.kill = (signal = "SIGTERM") => {
      child.signals.push(signal);
      exit(null, signal);
      return true;
    };
    child.stdin.on("data", (data) => {
      run.written += String(data);
      if (!run.written.includes("\n")) return;
      const url = new URL(run.written.trim());
      exit(
        url.searchParams.get("state") === run.state && url.searchParams.has("code")
          ? 0
          : 1,
      );
    });
    const base = args
      .find((arg) => arg.startsWith("mcp_oauth_callback_url="))
      ?.slice("mcp_oauth_callback_url=".length);
    run.redirect = `${JSON.parse(base ?? '""')}/SEGMENT12345`;
    run.authorize = () =>
      `https://as.example.test/authorize?response_type=code&state=${run.state}&redirect_uri=${encodeURIComponent(run.redirect)}`;
    runs.push(run);
    setImmediate(() => {
      if (behave?.(run) !== undefined) return;
      child.stdout.write(
        `Authorize the MCP server by opening this URL in your browser:\n${run.authorize()}\n`,
      );
      child.stderr.write("Callback URL (input hidden): ");
    });
    return child;
  };
  return { spawn, runs };
}
