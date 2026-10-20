import http from "node:http";
import fs from "node:fs/promises";
import { claudeModEvents } from "./claude-mod-events.js";

// The bridge mod's way in: HTTP over a private Unix socket beside the request
// broker's (the mod runtime only speaks HTTP, `$.http.fetch` with `socketPath`).
// Every request authenticates like a native channel does: the launch token of
// `requests/<id>.launch.json`, for a Claude Code session that still runs on the same
// profile. Nothing here logs a body; a refused request says only its status.
export const claudeModPath = "/claude-mod/v1/events";
const maxBody = 1024 * 1024;

const reply = (res, status, body) => {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    connection: "close",
  });
  res.end(body ? JSON.stringify(body) : "{}");
};

/**
 * `authenticate(sessionId, token)` resolves the owner or `{status}` (401: not this
 * launch, 410: the session no longer runs); `deliver(owner, events)` returns what the
 * mod should know (`{resync: true}` when text offsets no longer fit).
 */
export async function listenClaudeMod({ socketPath, authenticate, deliver }) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    let size = 0;
    let refused = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBody && !refused) {
        refused = true;
        reply(res, 413);
        req.destroy();
      } else if (!refused) chunks.push(chunk);
    });
    req.on("error", () => {});
    req.on("end", async () => {
      if (refused) return;
      try {
        if (req.method !== "POST" || req.url !== claudeModPath) return reply(res, 404);
        const token = /^Bearer ([a-f0-9]{64})$/.exec(
          req.headers.authorization || "",
        )?.[1];
        const sessionId = req.headers["x-agentpier-session"];
        const owner = token && (await authenticate(sessionId, token));
        if (!owner || owner.status) return reply(res, owner?.status || 401);
        let events;
        try {
          events = claudeModEvents(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          return reply(res, 400);
        }
        reply(res, 200, (await deliver(owner, events)) || {});
      } catch {
        reply(res, 500);
      }
    });
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  server.maxConnections = 64;
  await fs.rm(socketPath, { force: true });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await fs.chmod(socketPath, 0o600);
  return {
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      await fs.rm(socketPath, { force: true });
    },
  };
}
