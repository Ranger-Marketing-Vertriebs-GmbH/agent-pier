import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

// Balances browser specs over CI shards and over the Playwright processes of one
// shard by their recorded seconds (scripts/browser-shard-timings.json, refreshed
// by scripts/browser-shard-timings.mjs). The split is greedy longest-first into
// the lightest shard, ties broken by path, so every job computes the same
// assignment; a spec without a measurement weighs the median.
//
//   node scripts/browser-shards.mjs --browser chromium --shard 1 --total 4 \
//     --processes 2 --out <dir> [spec...]
//
// writes <dir>/process-<k>.args, one Playwright argument per line, for each
// process with work. Named specs are this shard's own list and are only split
// over the processes; without specs the shard takes its part of every spec. When
// the timing file is missing, each process falls back to Playwright's --shard.

export const timingsFile = new URL("./browser-shard-timings.json", import.meta.url);
const root = path.resolve(import.meta.dirname, "..");

export function loadTimings(browser, file = timingsFile) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))[browser] || {};
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function median(values) {
  const sorted = values.filter((value) => value > 0).sort((a, b) => a - b);
  if (!sorted.length) return 1;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function weigher(seconds = {}) {
  const fallback = median(Object.values(seconds));
  return (spec) => {
    const known = seconds[spec];
    return Number.isFinite(known) && known > 0 ? known : fallback;
  };
}

export function splitSpecs(specs, total, seconds = {}) {
  if (!Number.isInteger(total) || total < 1) throw new Error(`Invalid total ${total}`);
  if (new Set(specs).size !== specs.length) throw new Error("Duplicate spec");
  const weight = weigher(seconds);
  const shards = Array.from({ length: total }, () => ({ specs: [], seconds: 0 }));
  const ordered = [...specs].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b));
  for (const spec of ordered) {
    const lightest = shards.reduce((best, shard) =>
      shard.seconds < best.seconds ? shard : best,
    );
    lightest.specs.push(spec);
    lightest.seconds += weight(spec);
  }
  for (const shard of shards) {
    shard.specs.sort();
    shard.seconds = Math.round(shard.seconds * 10) / 10;
  }
  return shards;
}

// Every spec Playwright runs (testDir tests/browser, testMatch **/*.spec.js).
export function allSpecs(directory = path.join(root, "tests/browser")) {
  return fs
    .readdirSync(directory, { recursive: true })
    .map((file) => path.join("tests/browser", file).split(path.sep).join("/"))
    .filter((file) => file.endsWith(".spec.js"))
    .sort();
}

// The Playwright arguments of each process of one shard job.
export function shardProcesses({ shard, total, processes, specs, seconds }) {
  if (!Number.isInteger(shard) || shard < 1 || shard > total)
    throw new Error(`Invalid shard ${shard} of ${total}`);
  if (!Number.isInteger(processes) || processes < 1)
    throw new Error(`Invalid process count ${processes}`);
  if (!specs.length && !seconds)
    return Array.from({ length: processes }, (_, index) => [
      `--shard=${(shard - 1) * processes + index + 1}/${total * processes}`,
    ]);
  const own = specs.length
    ? specs
    : splitSpecs(allSpecs(), total, seconds)[shard - 1].specs;
  return splitSpecs(own, processes, seconds || {})
    .map((part) => part.specs)
    .filter((part) => part.length);
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      browser: { type: "string" },
      shard: { type: "string" },
      total: { type: "string" },
      processes: { type: "string", default: "1" },
      out: { type: "string" },
    },
  });
  if (!values.browser || !values.out) throw new Error("Name --browser and --out");
  const seconds = loadTimings(values.browser);
  const processes = shardProcesses({
    shard: Number(values.shard),
    total: Number(values.total),
    processes: Number(values.processes),
    specs: positionals,
    seconds,
  });
  if (!seconds) console.error("No browser shard timings: falling back to --shard.");
  fs.mkdirSync(values.out, { recursive: true });
  const weight = weigher(seconds || {});
  processes.forEach((args, index) => {
    const estimate = args[0].startsWith("--shard")
      ? args[0]
      : `${args.length} specs, about ${Math.round(args.reduce((sum, spec) => sum + weight(spec), 0))} s`;
    console.error(`Process ${index + 1}: ${estimate}`);
    fs.writeFileSync(
      path.join(values.out, `process-${index + 1}.args`),
      `${args.join("\n")}\n`,
    );
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
