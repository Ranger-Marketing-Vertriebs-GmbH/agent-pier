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
export function remoteLocked(req, config) {
  const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
    req.socket.remoteAddress,
  );
  const local = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`]);
  const tailscale =
    config.remoteUrl && new URL(config.remoteUrl).host === req.headers.host;
  return !(loopback && (local.has(req.headers.host) || tailscale));
}

export function remoteRoutes(services, { restart = restartService } = {}) {
  const { config, audit, networkState } = services;
  const effective = services.effectiveConfig;
  const router = Router();
  const view = (req) => {
    const current = effective();
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
        locked: remoteLocked(req, current),
      },
    };
  };
  router.get("/remote", (req, res) => res.json(view(req)));
  router.put("/remote", (req, res) => {
    const network = normalizeNetworkConfig(req.body?.network);
    const current = readNetworkConfig(config.dataDir).network;
    if (
      remoteLocked(req, effective()) &&
      !isDeepStrictEqual(network, { ...current, enabled: false })
    )
      throw problem(serverMessages.settings.networkLocked, 403);
    writeNetworkConfig(config.dataDir, network);
    audit?.append({
      action: "setting.updated",
      resourceType: "setting",
      resourceId: "network-access",
      outcome: "success",
      // The audit vocabulary allows only user, system and mcp: settings changes are "user".
      source: "user",
      details: { count: network.hosts.length },
    });
    res.json(view(req));
  });
  router.post("/remote/restart", (req, res) => {
    res.status(202).json({ restarting: true, instanceId: services.instanceId });
    res.once("finish", () =>
      setTimeout(async () => {
        try {
          await restart();
        } catch (error) {
          // Warning codes are short identifiers like the existing "event-storage".
          services.operationalWarnings.add("service-restart");
          audit?.append({
            action: "setting.failed",
            resourceType: "setting",
            resourceId: "network-access",
            outcome: "failure",
            source: "user",
          });
          services.onError?.(error);
        }
      }, 300),
    );
  });
  return router;
}
