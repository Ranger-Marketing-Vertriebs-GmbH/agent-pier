import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { timingsFile } from "./browser-shards.mjs";

// Refreshes scripts/browser-shard-timings.json, the seconds per browser spec that
// scripts/browser-shards.mjs balances the CI shards by:
//
//   node scripts/browser-shard-timings.mjs [--limit 3] [--run <id>...] [--dry-run]
//
// It reads the logs of successful browser shard jobs through the GitHub CLI: by
// default the latest --limit successful merge-queue and nightly runs, or the named
// --run ids. A spec's seconds per run are the time between the list reporter's
// test lines (hooks, retries and fixtures included); the file keeps the median
// over the runs that ran the spec.

// The merge queue runs every Chromium spec; the nightly full suite runs both
// browsers (WebKit through webkit.yml, whose jobs appear in the full.yml run).
const workflows = [
  ["verify.yml", "merge_group"],
  ["full.yml", "schedule"],
];
const jobName = /\bbrowser \((chromium|webkit)\) shard \d+\/\d+$/;
// ESC [ ... final byte; built from a code so no control character sits in the source.
const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");
const stamp = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) (?:\[(p\d+)\] )?(.*)$/;
const testLine =
  /^\s*(?:✓|✘|-|°|ok|x)\s+\d+ \[[^\]]+\] › (tests\/browser\/\S+?\.spec\.js):\d+/;

// Seconds per spec in one job log; parallel Playwright processes print with a
// "[pN] " prefix and are timed separately.
export function specSeconds(log) {
  const seconds = {};
  const last = new Map();
  for (const raw of log.split("\n")) {
    const match = stamp.exec(raw.replace(ansi, "").trimEnd());
    if (!match) continue;
    const [, time, process = "", text] = match;
    const at = Date.parse(time);
    if (/^Running \d+ tests? using/.test(text.trim())) {
      last.set(process, at);
      continue;
    }
    const test = testLine.exec(text);
    if (!test || !last.has(process)) continue;
    seconds[test[1]] = (seconds[test[1]] || 0) + (at - last.get(process)) / 1000;
    last.set(process, at);
  }
  return seconds;
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

// { browser: { spec: [seconds per run] } } into rounded medians, sorted by path.
export function medianTimings(samples) {
  const result = {};
  for (const browser of Object.keys(samples).sort()) {
    result[browser] = {};
    for (const spec of Object.keys(samples[browser]).sort())
      result[browser][spec] = Math.round(median(samples[browser][spec]) * 10) / 10;
  }
  return result;
}

const gh = (args) =>
  execFileSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

function recentRuns(limit) {
  const ids = [];
  for (const [workflow, event] of workflows) {
    try {
      const runs = JSON.parse(
        gh([
          "run",
          "list",
          "--workflow",
          workflow,
          "--event",
          event,
          "--status",
          "success",
          "--limit",
          String(limit),
          "--json",
          "databaseId",
        ]),
      );
      ids.push(...runs.map((run) => String(run.databaseId)));
    } catch {
      console.error(`No runs of ${workflow}`);
    }
  }
  return ids;
}

function collect(runIds) {
  const samples = {};
  for (const run of runIds) {
    const jobs = gh([
      "api",
      "--paginate",
      `repos/{owner}/{repo}/actions/runs/${run}/jobs`,
      "--jq",
      '.jobs[] | select(.conclusion == "success") | "\\(.id)\\t\\(.name)"',
    ]);
    const perRun = {};
    for (const line of jobs.split("\n").filter(Boolean)) {
      const [id, name] = line.split("\t");
      const browser = jobName.exec(name)?.[1];
      if (!browser) continue;
      const log = gh([
        "api",
        "--allow-escape-sequences",
        `repos/{owner}/{repo}/actions/jobs/${id}/logs`,
      ]);
      perRun[browser] ??= {};
      for (const [spec, seconds] of Object.entries(specSeconds(log)))
        perRun[browser][spec] = (perRun[browser][spec] || 0) + seconds;
    }
    for (const [browser, specs] of Object.entries(perRun)) {
      console.error(`Run ${run}: ${Object.keys(specs).length} ${browser} specs`);
      samples[browser] ??= {};
      for (const [spec, seconds] of Object.entries(specs))
        (samples[browser][spec] ??= []).push(seconds);
    }
  }
  return samples;
}

function main() {
  const { values } = parseArgs({
    options: {
      limit: { type: "string", default: "3" },
      run: { type: "string", multiple: true },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const runs = values.run?.length ? values.run : recentRuns(Number(values.limit));
  const timings = medianTimings(collect(runs));
  for (const browser of ["chromium", "webkit"])
    if (!Object.keys(timings[browser] || {}).length)
      throw new Error(`No ${browser} shard log found in runs ${runs.join(", ")}`);
  const text = `${JSON.stringify(timings, null, 2)}\n`;
  if (values["dry-run"]) process.stdout.write(text);
  else fs.writeFileSync(timingsFile, text);
  for (const [browser, specs] of Object.entries(timings)) {
    const total = Object.values(specs).reduce((sum, value) => sum + value, 0);
    console.error(
      `${browser}: ${Object.keys(specs).length} specs, ${Math.round(total)} s`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
