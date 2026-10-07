import fs from "node:fs";
import path from "node:path";

const root = new URL("../fixtures/protocol-adapter/", import.meta.url);

/** Reads a fixture relative to tests/fixtures/protocol-adapter/; JSON files are parsed. */
export function loadFixture(relPath) {
  const text = fs.readFileSync(new URL(relPath, root), "utf8");
  return relPath.endsWith(".json") ? JSON.parse(text) : text;
}

/** Cuts text into chunks of the given sizes; the remainder becomes the last chunk. */
export function splitChunks(text, sizes) {
  const chunks = [];
  let offset = 0;
  for (const size of sizes) {
    if (offset >= text.length) break;
    chunks.push(text.slice(offset, offset + size));
    offset += size;
  }
  if (offset < text.length) chunks.push(text.slice(offset));
  return chunks;
}

export async function collect(iterable) {
  const items = [];
  for await (const item of iterable) items.push(item);
  return items;
}

export async function* fromChunks(chunks) {
  for (const chunk of chunks) yield chunk;
}

/** Lists the fixtures in a directory as paths usable with loadFixture, sorted by name. */
export const fixtureList = (dir) =>
  fs
    .readdirSync(new URL(dir.endsWith("/") ? dir : `${dir}/`, root))
    .sort()
    .map((name) => path.posix.join(dir, name));
