import fs from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

// Splits the deterministic native contracts of the `native-contracts` CI job into
// balanced shards:
//   node scripts/assistant-contract-shards.mjs --shard N --total T
// prints the files of shard N (1-based) of T, one per line. The file list and the
// measured seconds per file (on the slowest of ubuntu-latest, ubuntu-24.04-arm and
// macos-latest) live in assistant-contract-shards.json; a listed file without a
// measurement weighs the median. The split is greedy longest-first, ties broken by
// path, so every shard of every runner sees the same deterministic assignment.
export const contractShards = JSON.parse(
  fs.readFileSync(new URL("./assistant-contract-shards.json", import.meta.url), "utf8"),
);

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 1;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function weightOf(file, seconds = contractShards.seconds) {
  const known = seconds[file];
  return Number.isFinite(known) && known > 0 ? known : median(Object.values(seconds));
}

export function splitShards(total, { files, seconds } = contractShards) {
  if (!Number.isInteger(total) || total < 1) throw new Error(`Invalid total ${total}`);
  if (new Set(files).size !== files.length) throw new Error("Duplicate contract file");
  const shards = Array.from({ length: total }, () => ({ files: [], seconds: 0 }));
  const ordered = [...files].sort(
    (a, b) => weightOf(b, seconds) - weightOf(a, seconds) || a.localeCompare(b),
  );
  for (const file of ordered) {
    const lightest = shards.reduce((best, shard) =>
      shard.seconds < best.seconds ? shard : best,
    );
    lightest.files.push(file);
    lightest.seconds += weightOf(file, seconds);
  }
  // Within a shard, keep the order of the list.
  for (const shard of shards)
    shard.files.sort((a, b) => files.indexOf(a) - files.indexOf(b));
  return shards;
}

function main() {
  const { values } = parseArgs({
    options: { shard: { type: "string" }, total: { type: "string" } },
  });
  const total = Number(values.total);
  const shard = Number(values.shard);
  const shards = splitShards(total);
  if (!Number.isInteger(shard) || shard < 1 || shard > total)
    throw new Error(`Invalid shard ${values.shard} of ${total}`);
  const { files, seconds } = shards[shard - 1];
  if (!files.length) throw new Error(`Shard ${shard} of ${total} has no contract`);
  console.error(`Shard ${shard}/${total}: ${files.length} files, about ${seconds} s`);
  for (const file of files) {
    if (!fs.existsSync(file)) throw new Error(`Missing contract ${file}`);
    console.log(file);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
