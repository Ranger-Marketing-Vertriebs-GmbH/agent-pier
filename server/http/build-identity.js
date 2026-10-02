import fs from "node:fs";
import path from "node:path";
import { projectDir } from "../lib/config.js";

const pattern = /<meta name="agentpier-build" content="([a-f0-9]{16})">/;

// Source checkouts rebuild dist/ in place while the server runs; re-read on change.
export function buildIdentity(file = path.join(projectDir, "dist", "index.html")) {
  let cached = { key: "", id: "" };
  return () => {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return "";
    }
    const key = `${stat.mtimeMs}:${stat.size}`;
    if (key !== cached.key) {
      let id = "";
      try {
        id = pattern.exec(fs.readFileSync(file, "utf8"))?.[1] || "";
      } catch {
        // An unreadable document only disables update detection.
      }
      cached = { key, id };
    }
    return cached.id;
  };
}

export function buildHeader(read = buildIdentity()) {
  return (_req, res, next) => {
    const id = read();
    if (id) res.setHeader("X-AgentPier-Build", id);
    next();
  };
}
