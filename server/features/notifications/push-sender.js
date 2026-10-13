import https from "node:https";
import webpush from "web-push";
import { pushLookup } from "./push-network.js";
import { pushSubscription, pushPayload } from "./push-validation.js";
import { pushRefusalReason } from "./push-failure.js";

/**
 * VAPID contact for the JWT `sub` claim. Apple's push service answers 403
 * BadJwtToken for a subject on a localhost or otherwise unreachable domain, so the
 * project's public repository URL serves as the operator contact.
 */
export const vapidSubject =
  "https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier";
const refusalBodyLimit = 2048;

/** Library-owned Web Push crypto with bounded, non-redirecting HTTPS transport. */
export function createPushSender({ request = https.request } = {}) {
  const active = new Set();
  const send = async (subscription, payload, vapid) => {
    const prepared = webpush.generateRequestDetails(
      pushSubscription(subscription),
      JSON.stringify(pushPayload(payload)),
      {
        vapidDetails: {
          subject: vapidSubject,
          publicKey: vapid.publicKey,
          privateKey: vapid.privateKey,
        },
        // web-push signs a fresh JWT per request that expires after 12 hours; Apple
        // rejects an expiration more than one day ahead (tests pin this ceiling).
        TTL: 300,
        urgency: "normal",
        contentEncoding: "aes128gcm",
      },
    );
    return new Promise((resolve, reject) => {
      let bytes = 0;
      const refusal = [];
      const outgoing = request(
        prepared.endpoint,
        { method: "POST", headers: prepared.headers, lookup: pushLookup, agent: false },
        (incoming) => {
          incoming.on("data", (data) => {
            if (bytes < refusalBodyLimit)
              refusal.push(data.subarray(0, refusalBodyLimit - bytes));
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
                Object.assign(Error("Push service refused delivery."), {
                  statusCode,
                  reason: pushRefusalReason(Buffer.concat(refusal).toString("utf8")),
                }),
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
