import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { createHash } from "node:crypto";
import { privateFolder } from "../features/memory/memory-validation.js";

export class LocalRpcBroker {
  constructor({ root, name, respond, maxResponse = 262144, timeout = 10000 }) {
    if (!/^[a-z]+$/.test(name)) throw Error("Invalid local broker name");
    this.respond = respond;
    this.maxResponse = maxResponse;
    this.timeout = timeout;
    const hash = createHash("sha256").update(root).digest("hex").slice(0, 20);
    this.socketPath = `/tmp/agentpier-${name}-${process.getuid?.() ?? "user"}-${hash}/mcp.sock`;
    this.ready = this.start();
  }
  async start() {
    privateFolder(path.dirname(this.socketPath));
    let previous;
    try {
      previous = fs.lstatSync(this.socketPath);
      if (!previous.isSocket() || (process.getuid && previous.uid !== process.getuid()))
        throw Error("Unsafe Local socket.");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (previous) {
      const stale = await new Promise((resolve) => {
        const probe = net.createConnection(this.socketPath);
        probe.once("connect", () => {
          probe.destroy();
          resolve(false);
        });
        probe.once("error", (error) => resolve(error.code === "ECONNREFUSED"));
        probe.setTimeout(1000, () => {
          probe.destroy();
          resolve(false);
        });
      });
      if (!stale) throw Error("Local broker already running.");
      const current = fs.lstatSync(this.socketPath);
      if (previous.ino !== current.ino || previous.dev !== current.dev)
        throw Error("Local broker socket changed.");
      fs.unlinkSync(this.socketPath);
    }
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.maxConnections = 64;
    this.server.requestTimeout = this.timeout;
    this.server.headersTimeout = this.timeout;
    this.server.setTimeout(this.timeout, (socket) => socket.destroy());
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, resolve);
    });
    this.listening = true;
    try {
      fs.chmodSync(this.socketPath, 0o600);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
  async handle(req, res) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.once("close", abort);
    try {
      if (
        req.method !== "POST" ||
        req.url !== "/mcp" ||
        req.headers.origin ||
        req.headers["content-type"] !== "application/json"
      ) {
        res.writeHead(400).end();
        req.resume();
        return;
      }
      const bearer = /^Bearer ([A-Za-z0-9][A-Za-z0-9_-]{0,99})\.([a-f0-9]{64})$/.exec(
        req.headers.authorization || "",
      );
      if (!bearer) {
        res.writeHead(403).end();
        req.resume();
        return;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 65536) {
          res.writeHead(413).end();
          req.destroy();
          return;
        }
        chunks.push(chunk);
      }
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const response = await this.respond(
        { sessionId: bearer[1], token: bearer[2] },
        request,
        controller.signal,
      );
      if (!response) {
        res.writeHead(204).end();
        return;
      }
      let body = JSON.stringify(response);
      if (Buffer.byteLength(body) > this.maxResponse)
        body = JSON.stringify({
          jsonrpc: "2.0",
          id: response.id ?? null,
          error: { code: -32000, message: "Local response exceeds its output budget." },
        });
      res
        .writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        })
        .end(body);
    } catch {
      if (!res.headersSent) res.writeHead(400);
      res.end();
    } finally {
      res.removeListener("close", abort);
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.ready.catch(() => {});
    await this.stop();
  }
  async stop() {
    if (!this.listening) return;
    this.listening = false;
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
    // Node removes its Unix socket when the listener closes. Do not unlink again:
    // another process may already be starting a replacement broker.
    // Session grants survive a web-only restart.
  }
}
