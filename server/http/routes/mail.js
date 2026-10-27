import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { serverMessages } from "../../lib/i18n/de.js";
import { messageIdentity } from "../../lib/i18n/message-identity.js";
import { problem } from "../../lib/storage.js";
import {
  accountInputKeys,
  mailPresets,
} from "../../features/mail/mail-account-fields.js";

const testKeys = [...accountInputKeys, "accountId"];

/** Rejects a body that is no object or carries a key outside `allowed`. */
function body(req, allowed) {
  const input = req.body ?? {};
  if (
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !allowed.includes(key))
  )
    throw problem(serverMessages.mail.invalidAccount, 400);
  return input;
}

// Every answer may name an account or a server: nothing of it belongs in a cache.
const noStore = (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
};

/**
 * The owner's email accounts for agents (owner-only by route-access.js). Passwords go
 * in and never come out: views carry `hasPassword`, never the password, its revision
 * or its file.
 */
export function mailRoutes({ mailAccounts }) {
  const router = Router();
  // A test opens connections to the hosts the body names; one shared owner budget
  // covers every login, like the SSH key downloads.
  const testLimit = rateLimit({
    windowMs: 60_000,
    limit: 30,
    keyGenerator: () => "owner",
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) =>
      res
        .status(429)
        .set("Cache-Control", "no-store")
        .json({
          code: "MAIL_TEST_RATE_LIMITED",
          error: serverMessages.mail.testRateLimited,
          ...messageIdentity(serverMessages.mail.testRateLimited),
        }),
  });
  router.get("/mail/accounts", noStore, (_req, res) =>
    res.json({ accounts: mailAccounts.list(), presets: mailPresets }),
  );
  router.post("/mail/accounts", noStore, (req, res) =>
    res.status(201).json(mailAccounts.create(body(req, accountInputKeys), req.principal)),
  );
  router.patch("/mail/accounts/:id", noStore, (req, res) =>
    res.json(
      mailAccounts.update(req.params.id, body(req, accountInputKeys), req.principal),
    ),
  );
  router.delete("/mail/accounts/:id", noStore, (req, res) => {
    mailAccounts.remove(req.params.id, req.principal);
    res.status(204).end();
  });
  router.post("/mail/accounts/:id/test", noStore, testLimit, async (req, res) => {
    body(req, []);
    res.json(await mailAccounts.test(req.params.id, req.principal));
  });
  router.post("/mail/test", noStore, testLimit, async (req, res) =>
    res.json(await mailAccounts.testInput(body(req, testKeys))),
  );
  // The shared handler hides every 500; this one names the unreadable account list,
  // whose message never quotes the file.
  router.use("/mail", (error, _req, res, next) => {
    if (error?.code !== "MAIL_CATALOG_UNREADABLE") return next(error);
    res
      .status(500)
      .set("Cache-Control", "no-store")
      .json({
        code: error.code,
        error: serverMessages.mail.catalogUnreadable,
        ...messageIdentity(serverMessages.mail.catalogUnreadable),
      });
  });
  return router;
}
