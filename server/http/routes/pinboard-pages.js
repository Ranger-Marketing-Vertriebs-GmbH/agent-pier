import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { PAGE_CSP, PAGE_GRANT } from "../../features/assistants/agent-pinboard-pages.js";
import { principalOf } from "../../features/users/identity.js";
import { sendFileRange } from "../byte-ranges.js";
import { notFoundBody } from "../responses.js";
import { tailnetLogin } from "../tailscale-request.js";

/** Requests one page grant may make per minute: a large gallery and some browsing. */
export const PAGE_REQUESTS_PER_MINUTE = 1200;

/**
 * Who asks, as a page grant remembers it (agent-pinboard-pages.js): the host branch
 * authorizeRequest chose and, on the Tailscale branch, the tailnet login Serve names,
 * otherwise the client's address. A grant answers only the client it was issued to.
 */
export function pageClient(req) {
  const branch = req.trustBranch || "unknown";
  if (branch === "tailscale") return `tailscale:${tailnetLogin(req.headers) ?? ""}`;
  return `${branch}:${req.socket?.remoteAddress ?? ""}`;
}

/**
 * The files of a pinned HTML page, for the reader's sandboxed frame: mounted ahead of
 * the session check, since the frame's opaque origin sends no session cookie;
 * authorizeRequest admits its cross-site requests on this path only (security.js).
 * The grant in the path stands in for the cookie: it names one entry and the client
 * it was issued to, and its session must still be the owner's, signed in, and allowed
 * to read the agent (the owner's privacy window). A response in flight ends when
 * that session ends or the window closes. Every refusal is a plain not found; only
 * a known grant counts against a limit, its own.
 */
export function pinboardPageRoutes(services, { limit = PAGE_REQUESTS_PER_MINUTE } = {}) {
  const router = Router();
  const refuse = (res) => res.status(404).json(notFoundBody());
  // The responses in flight; one privacy listener rechecks them all.
  const streams = new Set();
  let listening = false;
  const recheck = () => {
    for (const { res, readable } of streams) {
      let open = false;
      try {
        open = readable();
      } catch {
        // An agent that is gone is not readable.
      }
      if (!open) res.destroy();
    }
  };
  const perGrant = rateLimit({
    windowMs: 60_000,
    limit,
    keyGenerator: (req) => `grant:${req.params.grant}`,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).set("Cache-Control", "no-store").end(),
  });
  // AgentPier's own headers give way to the page's (it may be framed by the app), and
  // an unknown or foreign grant goes no further.
  const known = (req, res, next) => {
    res.removeHeader("X-Frame-Options");
    res.set({
      "Content-Security-Policy": PAGE_CSP,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "private, no-store",
    });
    const token = req.params.grant;
    const grant = PAGE_GRANT.test(token)
      ? services.assistants?.pinboard?.pages.grants.resolve(token)
      : null;
    if (!grant || grant.client !== pageClient(req)) return refuse(res);
    res.locals.grant = grant;
    next();
  };
  router.get("/pinboard-pages/:grant/*path", known, perGrant, async (req, res) => {
    const grant = res.locals.grant;
    const { assistants, identity, ownerPrivacy } = services;
    if (assistants.closed || assistants.recovering || assistants.maintenance)
      return refuse(res);
    // The path as sent, still encoded: pageFilePath decodes each segment itself.
    const rest = /^\/pinboard-pages\/[^/]+\/(.+)$/.exec(req.path)?.[1] ?? "";
    const readable = () =>
      !ownerPrivacy ||
      ownerPrivacy.agentContent(assistants.store.getAssistant(grant.assistantId));
    let session, file;
    try {
      session = identity.require(grant.session);
      if (principalOf(session).role !== "owner" || !readable()) return refuse(res);
      file = await assistants.pinboard.pages.file(
        grant.assistantId,
        grant.entryId,
        rest.split("/"),
      );
    } catch {
      return refuse(res);
    }
    // Signing out, or the owner's window on a user's agent closing, cuts it off.
    const unwatch = identity.watch(session, () => res.destroy());
    const sending = { res, readable };
    streams.add(sending);
    if (ownerPrivacy && !listening) {
      ownerPrivacy.on("changed", recheck);
      listening = true;
    }
    res.once("close", () => {
      unwatch?.();
      streams.delete(sending);
    });
    res.set({ "Content-Type": file.type, "Content-Disposition": "inline" });
    // A font is fetched in CORS mode from the frame's opaque origin ("null").
    if (file.font) res.set("Access-Control-Allow-Origin", "null");
    await sendFileRange(req, res, file);
  });
  return router;
}
