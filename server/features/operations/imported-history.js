import fs from "node:fs";
import path from "node:path";
import { readFile } from "./files.js";
import { problem } from "../../lib/storage.js";
const directory = (file) => {
  try {
    const stat = fs.lstatSync(file);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
};
export class ImportedHistory {
  constructor(dataDir) {
    this.root = path.join(dataDir, "imported-history/agentbus");
  }
  projects() {
    if (!directory(this.root)) return [];
    return fs
      .readdirSync(this.root)
      .filter((id) => /^[a-f0-9]{64}$/.test(id) && directory(path.join(this.root, id)))
      .map((id) => ({ id, historyOnly: true }));
  }
  messages(id, { page = 1 } = {}) {
    if (!this.projects().some((project) => project.id === id))
      throw problem("Imported AgentBus project not found.", 404);
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000)
      throw problem("Invalid imported history page.");
    const inbox = path.join(this.root, id, "inbox"),
      items = new Map();
    let scanned = 0;
    if (directory(inbox))
      scan: for (const peer of fs.readdirSync(inbox)) {
        if (!/^(codex|claude|opencode)-[A-Za-z0-9_-]+$/.test(peer)) continue;
        const peerRoot = path.join(inbox, peer);
        if (!directory(peerRoot)) continue;
        for (const state of ["pending", "done"]) {
          const folder = path.join(peerRoot, state);
          if (!directory(folder)) continue;
          for (const name of fs.readdirSync(folder)) {
            if (++scanned > 5000) break scan;
            if (!/^[A-Za-z0-9_-]+\.json$/.test(name)) continue;
            try {
              const value = JSON.parse(readFile(path.join(folder, name), 128 * 1024));
              if (
                typeof value.text !== "string" ||
                Buffer.byteLength(value.text) > 16384 ||
                typeof value.id !== "string" ||
                value.id.length > 100 ||
                !Number.isFinite(value.ts)
              )
                continue;
              const tool = ["codex", "claude", "opencode"].includes(value.from?.runtime)
                ? value.from.runtime
                : "unknown";
              items.set(value.id, {
                id: value.id,
                text: value.text,
                createdAt: new Date(value.ts).toISOString(),
                from: { name: tool, tool },
                to: { name: peer, tool: peer.split("-")[0] },
                status: state === "done" ? "read" : "pending-at-backup",
                historyOnly: true,
              });
            } catch {}
          }
        }
      }
    const sorted = [...items.values()].sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    );
    return {
      projectId: id,
      historyOnly: true,
      items: sorted.slice((page - 1) * 20, page * 20),
      total: sorted.length,
      page,
      pageSize: 20,
      truncated: scanned > 5000,
    };
  }
}
