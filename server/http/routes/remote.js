import { Router } from "express";
import { isDeepStrictEqual } from "node:util";
import { problem } from "../../lib/storage.js";
import { serverMessages } from "../../lib/i18n/de.js";
import {
  normalizeNetworkConfig,
  readNetworkConfig,
  writeNetworkConfig,
  networkUrls,
} from "../../features/remote/network-access.js";
import { restartService } from "../../features/operations/release-service.js";

/** True when the request itself arrived through the plain network branch. */
export function remoteLocked(req) {
  return req.trustBranch === "network";
}

export function remoteRoutes(services) {
  const { config, audit, networkState } = services;
  const effective = services.effectiveConfig;
  const router = Router();
  const view = (req, current) => {
    const saved = readNetworkConfig(config.dataDir).network;
    const running = current.network;
    return {
      local: { url: `http://127.0.0.1:${current.port}` },
      tailscale: { url: current.remoteUrl || null },
      network: {
        saved,
        running,
        detected: networkState.detected,
        urls: networkUrls(saved, current.port, networkState.detected),
        restartRequired: !isDeepStrictEqual(saved, running),
        locked: remoteLocked(req),
      },
    };
  };
  router.get("/remote", (req, res) => res.json(view(req, effective())));
  router.put("/remote", (req, res) => {
    const current = effective();
    if (req.body?.network === undefined || req.body?.network === null)
      throw problem(serverMessages.settings.invalidNetworkConfig);
    const network = normalizeNetworkConfig(req.body.network);
    const saved = readNetworkConfig(config.dataDir).network;
    if (remoteLocked(req) && !isDeepStrictEqual(network, { ...saved, enabled: false }))
      throw problem(serverMessages.settings.networkLocked, 403);
    writeNetworkConfig(config.dataDir, network);
    audit?.append({
      action: "setting.updated",
      resourceType: "setting",
      resourceId: "network-access",
      outcome: "success",
      // The audit vocabulary allows only user, system and mcp: settings changes are "user".
      source: "user",
      details: {
        enabled: network.enabled,
        bind: network.bind,
        count: network.hosts.length,
      },
    });
    res.json(view(req, current));
  });
  router.post("/remote/restart", (_req, res) => {
    audit?.append({
      action: "setting.updated",
      resourceType: "setting",
      resourceId: "service-restart",
      outcome: "success",
      source: "user",
    });
    res.status(202).json({ restarting: true, instanceId: services.instanceId });
    res.once("finish", () =>
      setTimeout(async () => {
        try {
          // Read at call time so a test can replace the adapter after the application exists.
          await (services.restartService || restartService)();
        } catch (error) {
          // Warning codes are short identifiers like the existing "event-storage".
          services.operationalWarnings.add("service-restart");
          audit?.append({
            action: "setting.failed",
            resourceType: "setting",
            resourceId: "service-restart",
            outcome: "failure",
            source: "user",
          });
          console.error(serverMessages.settings.restartFailed, error.message);
        }
      }, 300),
    );
  });
  return router;
}
