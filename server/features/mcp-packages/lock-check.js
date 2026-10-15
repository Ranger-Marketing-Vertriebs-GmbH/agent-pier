import { createHash } from "node:crypto";
import { packageProblem } from "./package-errors.js";

export const lockDigest = (text) => createHash("sha256").update(text).digest("hex");
// One SRI sha512 value: 64 bytes are 86 base64 characters plus "==".
const sha512 = /^sha512-[A-Za-z0-9+/]{86}==$/;
const foreign = () => packageProblem("MCP_PACKAGE_FOREIGN_SOURCE", 400);
const nameOf = (key) =>
  key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
/** Where a package sits in the graph, by package names (`a > b`): no folder names. */
const pathOf = (key) =>
  key
    .split("/node_modules/")
    .map((part) => part.replace(/^node_modules\//, ""))
    .join(" > ");

/**
 * Validates an npm lockfileVersion 3 resolved by AgentPier: every package comes from
 * `registry` with a sha512 hash, except bundled children inside a hashed parent;
 * the top-level package matches the reference and the registry's integrity.
 */
export function checkNpmLock(text, { ref, integrity, registry }) {
  let lock;
  try {
    lock = JSON.parse(text);
  } catch {
    throw packageProblem("MCP_PACKAGE_INSTALL_FAILED", 502);
  }
  if (
    lock?.lockfileVersion !== 3 ||
    typeof lock.packages !== "object" ||
    lock.packages === null
  )
    throw packageProblem("MCP_PACKAGE_INSTALL_FAILED", 502);
  const prefix = `${registry}/`;
  const trusted = new Set();
  const dependencies = [];
  let needsScripts = false;
  const keys = Object.keys(lock.packages)
    .filter((key) => key !== "")
    .sort((a, b) => a.length - b.length);
  for (const key of keys) {
    const entry = lock.packages[key];
    if (
      !key.startsWith("node_modules/") ||
      key.includes("\\") ||
      key.split("/").some((part) => part === "" || part === "." || part === "..")
    )
      throw foreign();
    if (!entry || typeof entry !== "object" || entry.link) throw foreign();
    if (typeof entry.version !== "string") throw foreign();
    if (entry.hasInstallScript) needsScripts = true;
    if (entry.inBundle) {
      const parent = [...trusted].some((owner) =>
        key.startsWith(`${owner}/node_modules/`),
      );
      if (!parent || entry.resolved) throw foreign();
    } else {
      if (typeof entry.resolved !== "string" || !entry.resolved.startsWith(prefix))
        throw foreign();
      if (typeof entry.integrity !== "string" || !sha512.test(entry.integrity))
        throw foreign();
    }
    trusted.add(key);
    dependencies.push({ name: nameOf(key), version: entry.version, path: pathOf(key) });
  }
  const top = lock.packages[`node_modules/${ref.name}`];
  if (!top || top.version !== ref.version || top.integrity !== integrity)
    throw packageProblem("MCP_PACKAGE_INTEGRITY_MISMATCH", 502);
  dependencies.sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      a.version.localeCompare(b.version) ||
      a.path.localeCompare(b.path),
  );
  return { digest: lockDigest(text), dependencies, needsScripts };
}

/** Added, removed and changed packages; nested copies of one name stay apart by path. */
export function lockDiff(before = [], after = []) {
  const keyOf = (d) => `${d.name}\u0000${d.path}`;
  const old = new Map(before.map((d) => [keyOf(d), d.version]));
  const next = new Set(after.map(keyOf));
  const added = after.filter((d) => !old.has(keyOf(d)));
  const removed = before.filter((d) => !next.has(keyOf(d)));
  const changed = after
    .filter((d) => old.has(keyOf(d)) && old.get(keyOf(d)) !== d.version)
    .map((d) => ({ name: d.name, path: d.path, from: old.get(keyOf(d)), to: d.version }));
  return { added, removed, changed };
}
