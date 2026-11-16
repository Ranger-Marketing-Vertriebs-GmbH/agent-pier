import fs from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { validSession } from "../requests/request-validation.js";

const equal = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.length === b.length &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * The Claude Code launch a bridge mod request belongs to, checked like a native
 * channel's hello and the pushes after it; remembered for a second, as the mod
 * reports about ten times a second. `file(id)` is the launch file of session `id`,
 * `sessions` the session store. `owner(id, token)` resolves the launch, null (not
 * this launch: 401) or `{ status: 410 }` (the session no longer runs there).
 */
export function createModOwner({ file, sessions }) {
  const cache = new Map();
  return {
    async owner(id, token) {
      if (!validSession(id)) return null;
      const cached = cache.get(id);
      if (cached && Date.now() - cached.at < 1000 && equal(token, cached.owner.token))
        return cached.owner;
      let launch;
      try {
        launch = JSON.parse(await fs.readFile(file(id), "utf8"));
      } catch {
        return null;
      }
      if (launch.tool !== "claude" || !equal(token, launch.token)) return null;
      const session = await sessions.get(id).catch(() => null);
      if (
        session?.status !== "running" ||
        session.accountId !== launch.accountId ||
        session.tool !== launch.tool
      )
        return { status: 410 };
      if (cache.size > 256) cache.clear();
      cache.set(id, { owner: launch, at: Date.now() });
      return launch;
    },
    forget(id) {
      cache.delete(id);
    },
    clear() {
      cache.clear();
    },
  };
}
