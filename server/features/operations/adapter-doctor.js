import fs from "node:fs";
import path from "node:path";

// Doctor checks for running protocol adapter sessions. Reads counters and fixed enums from
// `sessions/<id>.adapter.json` only; a snapshot of another launch generation is ignored.
const TOOLS = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode" };
// Counter maps: only numeric leaves under short identifier-like keys survive.
const COUNTER_KEYS = [
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
  "estimatedUsage",
  "cacheReadTokens",
];
const PROTOCOLS = ["messages", "responses", "chatCompletions"];
const REASONS = ["listen", "timeout", "aborted", "spawn", "config", "exited"];
// Every known capability with its allowed values (booleans unless listed).
const CAPABILITIES = {
  promptCache: null,
  thinkingBudget: null,
  promptCacheKey: null,
  reasoningEffort: null,
  parallelToolCalls: null,
  streamUsage: null,
  reasoningReplay: null,
  systemMessages: ["merge", "inline"],
  maxTokensField: ["max_tokens", "max_completion_tokens"],
};
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
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const COUNTER_KEY = /^[\w./:-]{1,64}$/;
const time = (value) =>
  typeof value === "string" && ISO.test(value) ? value : undefined;
const oneOf = (value, allowed) => (allowed.includes(value) ? value : undefined);
const counters = (value) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value)
    .filter(([key]) => COUNTER_KEY.test(key))
    .map(([key, item]) => [key, counters(item)])
    .filter(([, item]) => item !== undefined);
  return Object.fromEntries(entries);
};
const compact = (entries) =>
  Object.fromEntries(entries.filter(([, value]) => value !== undefined));
const capabilities = (value) =>
  value && typeof value === "object"
    ? compact(
        Object.entries(CAPABILITIES).map(([name, allowed]) => {
          const item = value[name];
          return [
            name,
            allowed ? oneOf(item, allowed) : typeof item === "boolean" ? item : undefined,
          ];
        }),
      )
    : undefined;
const supervisorOf = (value) =>
  value && typeof value === "object"
    ? compact([
        ["restarts", counters(value.restarts)],
        ["lastReason", oneOf(value.lastReason, REASONS)],
        ["gaveUpAt", time(value.gaveUpAt)],
        ["startFailed", oneOf(value.startFailed, REASONS)],
        ["at", time(value.at)],
      ])
    : undefined;
// The only shape the doctor reports: counters, ISO timestamps and fixed enums.
const details = (snapshot) =>
  compact([
    ["startedAt", time(snapshot.startedAt)],
    ["updatedAt", time(snapshot.updatedAt)],
    [
      "route",
      snapshot.route && typeof snapshot.route === "object"
        ? compact([
            ["client", oneOf(snapshot.route.client, PROTOCOLS)],
            ["upstream", oneOf(snapshot.route.upstream, PROTOCOLS)],
          ])
        : undefined,
    ],
    ...COUNTER_KEYS.map((key) => [key, counters(snapshot[key])]),
    ["capabilities", capabilities(snapshot.capabilities)],
    ["supervisor", supervisorOf(snapshot.supervisor)],
  ]);

export function adapterCheck(session, snapshot) {
  const id = `adapter-session.${session.id}`;
  const head = `"${session.name ?? session.id}": ${TOOLS[session.tool] ?? "Unknown CLI"} via adapter (${
    oneOf(session.provider?.route?.source, PROTOCOLS) ?? "unknown"
  })`;
  if (!snapshot)
    return { id, status: "ok", summary: `${head}: no requests recorded yet.` };
  const supervisor = supervisorOf(snapshot.supervisor) || {};
  const at = supervisor.gaveUpAt ?? supervisor.at ?? "an unknown time";
  if (snapshot.supervisor?.gaveUpAt)
    return {
      id,
      status: "fail",
      summary: `${head}: the protocol adapter stopped after ${count(supervisor.restarts)} restart(s) (${supervisor.lastReason ?? "exited"}) at ${at}; every request of the CLI now gets HTTP 503.`,
      remedy: RELOAD,
      details: details(snapshot),
    };
  if (snapshot.supervisor?.startFailed)
    return {
      id,
      status: "fail",
      summary: `${head}: the protocol adapter failed to start (${supervisor.startFailed ?? "unknown"}) at ${at}.`,
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
