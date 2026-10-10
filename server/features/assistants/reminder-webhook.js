import http from "node:http";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readJSON, writePrivate } from "../../lib/storage.js";
import { assistantProblem } from "./assistant-validation.js";
export class ReminderWebhook {
  constructor({ dataDir, receive }) {
    this.file = path.join(dataDir, "assistants", "reminder-webhook.json");
    this.receive = receive;
    this.jobs = new Set();
  }
  start() {
    if (this.server?.listening) return Promise.resolve(this.connection);
    if (this.starting) return this.starting;
    this.starting = this.listen().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }
  async listen() {
    const saved = readJSON(this.file, null);
    if (
      saved &&
      (!Number.isInteger(saved.port) ||
        saved.port < 1 ||
        saved.port > 65535 ||
        !/^[a-f0-9]{64}$/.test(saved.token))
    )
      throw assistantProblem("unavailable", 503);
    const token = saved?.token || randomBytes(32).toString("hex");
    const server = (this.server = http.createServer((req, res) => {
      const job = this.handle(req, res, token);
      this.jobs.add(job);
      job.finally(() => this.jobs.delete(job));
    }));
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(saved?.port || 0, "127.0.0.1", resolve);
    });
    const port = server.address().port;
    writePrivate(this.file, { port, token });
    return (this.connection = { url: `http://127.0.0.1:${port}`, token });
  }
  async handle(req, res, token) {
    try {
      if (req.headers.origin || req.headers["sec-fetch-site"])
        throw assistantProblem("invalid", 403);
      const supplied = Buffer.from(req.headers.authorization || ""),
        expected = Buffer.from(`Bearer ${token}`);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
        throw assistantProblem("invalid", 401);
      const match = /^\/complete\/([a-f0-9-]{36})$/.exec(req.url || "");
      if (req.method !== "POST" || !match) throw assistantProblem("invalid", 404);
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 262144) throw assistantProblem("invalid", 413);
        chunks.push(chunk);
      }
      let event;
      try {
        event = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        throw assistantProblem("invalid");
      }
      await this.receive(match[1], event);
      res.writeHead(204).end();
    } catch (error) {
      res
        .writeHead(error.status || 503, { "content-type": "application/json" })
        .end(JSON.stringify({ error: "REMINDER_DELIVERY_UNAVAILABLE" }));
    }
  }
  async close() {
    await this.starting?.catch(() => {});
    const server = this.server;
    this.server = null;
    server?.closeAllConnections();
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    await Promise.allSettled([...this.jobs]);
  }
}
