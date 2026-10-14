import { createHash } from "node:crypto";
import { packageProblem } from "./package-errors.js";

export const lockDigest = (text) => createHash("sha256").update(text).digest("hex");
const foreign = () => packageProblem("MCP_PACKAGE_FOREIGN_SOURCE", 400);
const nameOf = (key) =>
  key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);

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
    if (!key.startsWith("node_modules/") || key.split("/").includes(".."))
      throw foreign();
    if (!entry || typeof entry !== "object" || entry.link) throw foreign();
    if (entry.hasInstallScript) needsScripts = true;
    if (entry.inBundle) {
      const parent = [...trusted].some((owner) =>
        key.startsWith(`${owner}/node_modules/`),
      );
      if (!parent || entry.resolved) throw foreign();
    } else {
      if (typeof entry.resolved !== "string" || !entry.resolved.startsWith(prefix))
        throw foreign();
      if (typeof entry.integrity !== "string" || !entry.integrity.startsWith("sha512-"))
        throw foreign();
    }
    trusted.add(key);
    dependencies.push({ name: nameOf(key), version: String(entry.version) });
  }
  const top = lock.packages[`node_modules/${ref.name}`];
  if (!top || top.version !== ref.version || top.integrity !== integrity)
    throw packageProblem("MCP_PACKAGE_INTEGRITY_MISMATCH", 502);
  dependencies.sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
  return { digest: lockDigest(text), dependencies, needsScripts };
}

export function lockDiff(before = [], after = []) {
  const map = (list) => new Map(list.map((d) => [d.name, d.version]));
  const old = map(before);
  const next = map(after);
  const added = after.filter((d) => !old.has(d.name));
  const removed = before.filter((d) => !next.has(d.name));
  const changed = after
    .filter((d) => old.has(d.name) && old.get(d.name) !== d.version)
    .map((d) => ({ name: d.name, from: old.get(d.name), to: d.version }));
  return { added, removed, changed };
}
