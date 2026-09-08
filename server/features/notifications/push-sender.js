import https from "node:https";
import webpush from "web-push";
import { pushLookup } from "./push-network.js";
import { pushSubscription, pushPayload } from "./push-validation.js";

/** Library-owned Web Push crypto with bounded, non-redirecting HTTPS transport. */
export function createPushSender({ request = https.request } = {}) {
  const active = new Set();
  const send = async (subscription, payload, vapid) => {
    const prepared = webpush.generateRequestDetails(
      pushSubscription(subscription),
      JSON.stringify(pushPayload(payload)),
      {
        vapidDetails: { subject: "mailto:agentpier@localhost", ...vapid },
        TTL: 300,
        urgency: "normal",
        contentEncoding: "aes128gcm",
      },
    );
    return new Promise((resolve, reject) => {
      let bytes = 0;
      const outgoing = request(
        prepared.endpoint,
        { method: "POST", headers: prepared.headers, lookup: pushLookup, agent: false },
        (incoming) => {
          incoming.on("data", (data) => {
            bytes += data.length;
            if (bytes > 65536)
              outgoing.destroy(Error("Push response exceeded its limit."));
          });
          incoming.once("error", reject);
          incoming.once("end", () => {
            const statusCode = incoming.statusCode;
            if (statusCode >= 200 && statusCode < 300) resolve({ statusCode });
            else
              reject(
                Object.assign(Error("Push service refused delivery."), { statusCode }),
              );
          });
        },
      );
      active.add(outgoing);
      const timer = setTimeout(
        () => outgoing.destroy(Error("Push delivery timed out.")),
        10000,
      );
      outgoing.once("close", () => {
        clearTimeout(timer);
        active.delete(outgoing);
      });
      outgoing.once("error", reject);
      outgoing.end(prepared.body);
    });
  };
  send.close = () => {
    for (const request of active) request.destroy(Error("Push sender closed."));
  };
  return send;
}
