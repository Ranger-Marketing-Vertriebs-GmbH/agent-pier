import { assistantWorkflowRoutes } from "./assistant-workflows.js";
import { assistantRuntimeUpdateRoutes } from "./assistant-runtime-updates.js";
import { assistantRoutineRoutes } from "./assistant-routines.js";
import { assistantTeamRoutes } from "./assistant-teams.js";
import { assistantCapabilityRoutes } from "./assistant-capabilities.js";
import { assistantChannelRoutes } from "./assistant-channels.js";
import { assistantAccountRoutes } from "./assistant-accounts.js";
import { Router } from "express";
import path from "node:path";
import { writePrivate } from "../../lib/storage.js";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";
import { assistantFeatureRoutes } from "./assistant-feature.js";
import { serverMessages } from "../../lib/i18n/de.js";
import { messageIdentity } from "../../lib/i18n/message-identity.js";
import { ASSISTANT_STORAGE_UNSAFE } from "../../features/assistants/assistant-feature.js";
import { runtimeStatus } from "../../features/assistants/team-bridge.js";

const assistantPath = /^\/assistants?(?:[-/]|$)/;
const reply = (res, status, code, message) =>
  res.status(status).json({ code, error: message, ...messageIdentity(message) });
/**
 * Assistant routes exist only while the opt-in feature has created its services;
 * the inner router is rebuilt whenever the feature creates a new service set.
 */
export function assistantRoutes(services) {
  const router = Router();
  let built = null;
  let routes = null;
  router.use(assistantFeatureRoutes(services));
  router.use((req, res, next) => {
    if (!assistantPath.test(req.path) || req.path === "/assistant-feature") return next();
    const { assistantFeature, assistants } = services;
    if (!assistants) {
      if (!assistantFeature?.enabled)
        return reply(res, 404, "ASSISTANTS_DISABLED", serverMessages.assistants.disabled);
      const code = assistantFeature.error || "ASSISTANTS_UNAVAILABLE";
      return reply(
        res,
        503,
        code,
        code === ASSISTANT_STORAGE_UNSAFE
          ? serverMessages.assistants.storageUnsafe
          : serverMessages.assistants.unavailable,
      );
    }
    if (built !== assistants) {
      routes = activeAssistantRoutes(services);
      built = assistants;
    }
    return routes(req, res, next);
  });
  return router;
}
function activeAssistantRoutes(services) {
  const { assistants, assistantRuntime, audit } = services;
  const router = Router();
  router.use((req, _res, next) => {
    if (
      assistants.maintenance &&
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      !req.path.startsWith("/assistant-runtime/updates/")
    )
      return next(assistantProblem("active", 409));
    next();
  });
  router.use(assistantCapabilityRoutes(services));
  router.use(assistantRoutineRoutes(services));
  router.use(assistantWorkflowRoutes(services));
  router.use(assistantRuntimeUpdateRoutes(services));
  router.use(assistantChannelRoutes(services));
  router.use(assistantTeamRoutes(services));
  router.use(assistantAccountRoutes(services));
  router.get("/assistants", (_req, res) => res.json(assistants.list()));
  router.post("/assistants", async (req, res) => {
    const result = await assistants.create(req.body);
    audit.append({
      action: "assistant.created",
      resourceType: "assistant",
      resourceId: result.id,
      outcome: "success",
      source: "user",
    });
    res.status(201).json(result);
  });
  router.patch("/assistants/:id", async (req, res) => {
    const { revision, ...patch } = req.body;
    res.json(await assistants.update(req.params.id, patch, revision));
  });
  router.post("/assistants/:id/conversations", async (req, res) =>
    res.json(await assistants.openConversation(req.params.id)),
  );
  router.get("/assistant-conversations/:id/messages", async (req, res) =>
    res.json(
      await assistants.history(req.params.id, {
        before: req.query.before,
        limit: req.query.limit ? Number(req.query.limit) : 100,
      }),
    ),
  );
  router.post("/assistant-conversations/:id/messages", async (req, res) =>
    res.status(202).json(await assistants.send(req.params.id, req.body)),
  );
  router.post("/assistant-attempts/:id/cancel", async (req, res) =>
    res.json(await assistants.cancel(req.params.id)),
  );
  router.post("/assistant-attempts/:id/recover", async (req, res) =>
    res.json(await assistants.recover(req.params.id, req.body)),
  );
  router.get("/assistant-runtime", (_req, res) =>
    res.json(
      runtimeStatus(assistantRuntime, assistants, services.assistantTeams?.bridge),
    ),
  );
  router.post("/assistant-runtime/:action", async (req, res) =>
    assistants.admit(async () => {
      if (
        assistants.maintenance ||
        services.assistantUpdates?.status().recoveryRequired ||
        services.assistantUpdates?.status().busy
      )
        throw assistantProblem("active", 409);
      const action = req.params.action;
      if (!["enable", "start", "stop", "restart"].includes(action))
        throw assistantProblem("invalid");
      if (
        ["stop", "restart"].includes(action) &&
        (assistants.ledger.pending().length ||
          (assistantRuntime.client?.ready && (await assistants.reminders?.hasRunning())))
      )
        throw assistantProblem("active", 409);
      writePrivate(path.join(assistantRuntime.paths.root, "settings.json"), {
        enabled: action !== "stop",
      });
      if (action === "stop") await assistantRuntime.stop();
      else
        (action === "restart"
          ? assistantRuntime.restart()
          : assistantRuntime.start()
        ).catch(() => {});
      res.status(202).json(assistantRuntime.status());
    }),
  );
  router.get("/assistant-events", (req, res) => {
    res.status(200).set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    const send = (event) => {
      if (res.writableLength > 1024 * 1024) return res.end();
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.flush?.();
    };
    send({ type: "connected" });
    const unsubscribe = assistants.events.subscribe(send);
    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n");
      res.flush?.();
    }, 15000);
    heartbeat.unref();
    const close = () => res.end();
    assistants.events.once("close", close);
    req.on("close", () => {
      unsubscribe();
      clearInterval(heartbeat);
      assistants.events.off("close", close);
    });
  });
  router.use((error, _req, res, next) => {
    if (error.code === "REVIEW_REQUIRED")
      return reply(res, error.status, error.code, error.message);
    next(
      error.status === 503 && error.code ? assistantProblem("unavailable", 503) : error,
    );
  });
  return router;
}
