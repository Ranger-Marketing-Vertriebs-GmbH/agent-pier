import fs from "node:fs";
import http from "node:http";
import path from "node:path";

export function agentbusClient(env = process.env) {
  const socketPath = env.AGENTPIER_AGENTBUS_SOCKET;
  const capabilityFile = env.AGENTPIER_AGENTBUS_CAPABILITY_FILE;
  let authorization;
  let fd;
  try {
    if (!path.isAbsolute(socketPath) || !path.isAbsolute(capabilityFile)) throw Error();
    fd = fs.openSync(capabilityFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > 8192 ||
      (stat.mode & 0o777) !== 0o600 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw Error();
    const capability = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (
      capability.version !== 1 ||
      typeof capability.sessionId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(capability.sessionId) ||
      typeof capability.token !== "string" ||
      !/^[a-f0-9]{64}$/.test(capability.token)
    )
      throw Error();
    authorization = `Bearer ${capability.sessionId}.${capability.token}`;
  } catch {
    throw Error("AgentBus transport configuration unavailable.");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return (message, { signal } = {}) =>
    new Promise((resolve, reject) => {
      const body = JSON.stringify(message);
      if (Buffer.byteLength(body) > 65536) {
        reject(Error("AgentBus request too large."));
        return;
      }
      const timeout = message.method === "agentbus/wait" ? 25000 : 10000;
      const request = http.request(
        {
          socketPath,
          path: "/mcp",
          method: "POST",
          agent: false,
          signal,
          headers: {
            authorization,
            // Keep the server from closing while Node flushes a large UDS write.
            // agent:false still disposes this connection after the response.
            connection: "keep-alive",
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
        },
        (response) => {
          const chunks = [];
          let size = 0;
          response.on("data", (chunk) => {
            size += chunk.length;
            if (size > 1048576) response.destroy(Error("AgentBus response too large."));
            else chunks.push(chunk);
          });
          response.once("error", () => reject(Error("AgentBus unavailable.")));
          response.once("end", () => {
            if (response.statusCode === 204) {
              resolve(null);
              return;
            }
            if (response.statusCode !== 200) {
              reject(Error("AgentBus unavailable."));
              return;
            }
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch {
              reject(Error("AgentBus response unavailable."));
            }
          });
        },
      );
      const deadline = setTimeout(
        () => request.destroy(Error("AgentBus request timed out.")),
        timeout,
      );
      request.once("close", () => clearTimeout(deadline));
      request.once("error", () => reject(Error("AgentBus unavailable.")));
      request.end(body);
    });
}
