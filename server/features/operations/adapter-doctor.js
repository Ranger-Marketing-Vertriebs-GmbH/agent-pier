import fs from "node:fs";
import path from "node:path";

// Doctor checks for running protocol adapter sessions. Reads counters and fixed enums from
// `sessions/<id>.adapter.json` only; a snapshot of another launch generation is ignored.
const TOOLS = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode" };
const DETAIL_KEYS = [
  "startedAt",
  "updatedAt",
  "route",
  "restarts",
  "requests",
  "unauthorized",
  "upstreamStatus",
  "errors",
  "forbidden",
  "clientDisconnects",
  "shutdownAborts",
  "dropped",
  "adjustments",
  "compactionDropped",
  "capabilityFallbacks",
  "capabilities",
  "estimatedUsage",
  "cacheReadTokens",
  "supervisor",
];
const RELOAD = "Reload the session to restart the protocol adapter.";

const read = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
const count = (value) =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : value && typeof value === "object"
      ? Object.values(value).reduce((sum, item) => sum + count(item), 0)
      : 0;
const details = (snapshot) =>
  Object.fromEntries(
    DETAIL_KEYS.filter((key) => key in snapshot).map((key) => [key, snapshot[key]]),
  );

export function adapterCheck(session, snapshot) {
  const id = `adapter-session.${session.id}`;
  const head = `"${session.name ?? session.id}": ${TOOLS[session.tool] ?? session.tool} via adapter (${
    session.provider?.route?.source ?? "unknown"
  })`;
  if (!snapshot)
    return { id, status: "ok", summary: `${head}: no requests recorded yet.` };
  const supervisor = snapshot.supervisor || {};
  if (supervisor.gaveUpAt)
    return {
      id,
      status: "fail",
      summary: `${head}: the protocol adapter stopped after ${count(supervisor.restarts)} restart(s) (${supervisor.lastReason ?? "exited"}) at ${supervisor.gaveUpAt}; every request of the CLI now gets HTTP 503.`,
      remedy: RELOAD,
      details: details(snapshot),
    };
  if (supervisor.startFailed)
    return {
      id,
      status: "fail",
      summary: `${head}: the protocol adapter failed to start (${supervisor.startFailed}) at ${supervisor.at ?? "an unknown time"}.`,
      remedy: `${RELOAD} If it fails again, test the connection and check its address.`,
      details: details(snapshot),
    };
  const requests = count(snapshot.requests);
  const errors = count(snapshot.errors);
  const restarts = count(snapshot.restarts);
  const compaction = count(snapshot.compactionDropped);
  const fallbacks = count(snapshot.capabilityFallbacks);
  const estimated = count(snapshot.estimatedUsage);
  return {
    id,
    status: restarts || errors || compaction ? "warn" : "ok",
    summary:
      `${head}: ${requests} request(s), ${errors} error(s), ${restarts} restart(s), ` +
      `${fallbacks} capability fallback(s), ${estimated} estimated usage report(s), ` +
      `${compaction} compaction item(s) dropped.` +
      (compaction
        ? " Remotely compacted history was dropped on this route; start a new session if the model lacks earlier context."
        : ""),
    details: details(snapshot),
  };
}

export function adapterSessionChecks(dataDir) {
  const directory = path.join(dataDir, "sessions");
  let names;
  try {
    names = fs.readdirSync(directory);
  } catch {
    return [];
  }
  const checks = [];
  for (const name of names
    .filter((n) => n.endsWith(".json") && n.split(".").length === 2)
    .sort()) {
    const session = read(path.join(directory, name));
    if (!session?.adapterGeneration || session.status !== "running") continue;
    const snapshot = read(path.join(directory, name.replace(/\.json$/, ".adapter.json")));
    const current =
      snapshot?.version === 1 && snapshot.generation === session.adapterGeneration
        ? snapshot
        : null;
    checks.push(adapterCheck(session, current));
  }
  return checks;
}
