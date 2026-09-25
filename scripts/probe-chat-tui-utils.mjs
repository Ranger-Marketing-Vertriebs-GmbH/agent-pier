import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export async function waitFor(read, predicate, timeout = 15000) {
  const started = performance.now();
  while (performance.now() - started < timeout) {
    const value = await read();
    if (predicate(value)) return value;
    await sleep(20);
  }
  throw new Error("Probe observation timed out; no submit is retried");
}

export function summary(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: sorted.at(-1),
  };
}

export async function waitForProbeBinding({ fixture, session, tool, capture, env }) {
  await waitFor(
    () => fixture.application.bindings.verifiedReceipt(session),
    Boolean,
  ).catch(async (error) => {
    const scrub = (value) =>
      value
        .replaceAll(fixture.root, "<temporary-root>")
        .replace(/[a-f0-9]{48}/g, "<fixture-token>");
    console.error("BOUND_STARTUP", scrub(await capture()));
    const launchFile = fixture.application.bindings.file(session.id);
    const bindingReceipt = await fs
      .readFile(launchFile.replace(/\.launch\.json$/, ".receipt.json"), "utf8")
      .then(JSON.parse)
      .catch((error) => ({ missing: error.code }));
    const launchRecord = JSON.parse(await fs.readFile(launchFile, "utf8"));
    console.error(
      "BOUND_RECEIPT",
      JSON.stringify(
        bindingReceipt.missing
          ? bindingReceipt
          : {
              idMatch: bindingReceipt.id === session.id,
              accountMatch: bindingReceipt.accountId === session.accountId,
              cwdMatch: bindingReceipt.cwd === launchRecord.cwd,
              toolMatch: bindingReceipt.tool === tool,
              tokenMatch: bindingReceipt.token === launchRecord.token,
              pid: bindingReceipt.pid,
              pidStart: bindingReceipt.pidStart,
              updatedAt: bindingReceipt.updatedAt,
            },
      ),
    );
    if (tool === "claude") {
      const debug = await fs
        .readFile(path.join(fixture.root, "claude-debug.log"), "utf8")
        .catch(() => "");
      console.error(
        "CLAUDE_HOOK_LOG",
        scrub(
          debug
            .split("\n")
            .filter((line) => /hook|plugin|agentpier/i.test(line))
            .slice(-40)
            .join("\n"),
        ),
      );
    }
    const logDirectory = path.join(env.CODEX_HOME, "log");
    const names = await fs.readdir(logDirectory).catch(() => []);
    for (const name of names)
      if (name.endsWith(".log")) {
        const content = await fs.readFile(path.join(logDirectory, name), "utf8");
        console.error(
          "BOUND_HOOK_LOG",
          scrub(
            content
              .split("\n")
              .filter((line) => /hook|binding/i.test(line))
              .slice(-15)
              .join("\n"),
          ),
        );
      }
    throw error;
  });
}
