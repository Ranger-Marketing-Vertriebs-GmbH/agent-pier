import http from "node:http";
import path from "node:path";
import { identifier, privateFile } from "./memory-validation.js";

export function memoryClient(socketPath, capabilityFile) {
  if (!path.isAbsolute(socketPath) || !path.isAbsolute(capabilityFile))
    throw Error("Invalid Memory transport configuration.");
  const capability = JSON.parse(privateFile(capabilityFile));
  identifier(capability.sessionId);
  if (
    capability.version !== 1 ||
    typeof capability.token !== "string" ||
    !/^[a-f0-9]{64}$/.test(capability.token)
  )
    throw Error("Invalid Memory credential.");
  const authorization = `Bearer ${capability.sessionId}.${capability.token}`;
  return (message) =>
    new Promise((resolve, reject) => {
      const body = JSON.stringify(message);
      if (Buffer.byteLength(body) > 65536) {
        reject(Error("Memory request too large."));
        return;
      }
      const request = http.request(
        {
          socketPath,
          path: "/mcp",
          method: "POST",
          agent: false,
          timeout: 5000,
          headers: {
            authorization,
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
        },
        (response) => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            text += chunk;
            if (Buffer.byteLength(text) > 262144)
              response.destroy(Error("Memory response too large."));
          });
          response.once("error", reject);
          response.once("end", () => {
            if (response.statusCode === 204) {
              resolve(null);
              return;
            }
            if (response.statusCode !== 200) {
              reject(Error("Memory access unavailable."));
              return;
            }
            try {
              resolve(JSON.parse(text));
            } catch {
              reject(Error("Invalid Memory response."));
            }
          });
        },
      );
      request.once("error", reject);
      request.once("timeout", () => request.destroy(Error("Memory request timed out.")));
      request.end(body);
    });
}
