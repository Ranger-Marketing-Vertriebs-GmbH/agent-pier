import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import express from "express";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { writePrivate, privateDirectory, problem } from "../../lib/storage.js";
import { mcpHttpRouter } from "./http-transport.js";
import { MCP_SCOPES } from "./oauth-provider.js";
import { sessionMcpLaunch } from "./session-launch.js";
import {
  capabilityDirectory,
  privatePath,
  revokeSessionMcp,
  checkSessionCapability,
} from "./session-capability.js";

const fields = {
  projectIds: "projects",
  accountIds: "accounts",
  connectionIds: "connections",
};
export class SessionMcp {
  constructor(services) {
    this.services = services;
    this.dataDir = services.config.dataDir;
    const hash = createHash("sha256")
      .update(path.resolve(this.dataDir))
      .digest("hex")
      .slice(0, 20);
    this.socketPath = `/tmp/agentpier-mcp-${process.getuid?.() ?? "user"}-${hash}/mcp.sock`;
    this.ready = this.start();
  }
  resources() {
    return {
      projects: this.services.memory
        .projects()
        .projects.map(({ id, name }) => ({ id, name })),
      accounts: this.services.accounts
        .list()
        .filter((a) => a.tool !== "shell")
        .map(({ id, name, tool }) => ({ id, name, tool })),
      connections: this.services.providerConnections
        .list()
        .map(({ id, name }) => ({ id, name })),
    };
  }
  validate(selection) {
    if (selection === undefined || selection === false) return null;
    if (
      !selection ||
      typeof selection !== "object" ||
      Array.isArray(selection) ||
      !Array.isArray(selection.scopes) ||
      !selection.scopes.length ||
      selection.scopes.length > MCP_SCOPES.length ||
      selection.scopes.some((scope) => !MCP_SCOPES.includes(scope)) ||
      (selection.currentProject !== undefined &&
        typeof selection.currentProject !== "boolean")
    )
      throw problem("Choose valid AgentPier permissions.");
    const result = {
      scopes: [...new Set(selection.scopes)],
      currentProject: selection.currentProject === true,
    };
    const available = this.resources();
    for (const [field, group] of Object.entries(fields)) {
      const ids = selection[field];
      if (
        !Array.isArray(ids) ||
        ids.length > 1000 ||
        ids.some(
          (id) =>
            typeof id !== "string" ||
            !available[group].some((resource) => resource.id === id),
        )
      )
        throw problem("Choose available AgentPier resources.");
      result[field] = [...new Set(ids)];
    }
    if (!result.currentProject && !result.projectIds.length)
      throw problem("Choose at least one AgentPier project.");
    return result;
  }
  async prepare({
    id,
    account,
    cwd,
    launch,
    purpose,
    pipeline,
    selection,
    replace = false,
  }) {
    // An explicit owner revocation wins over a reload holding an older selection.
    const revoked =
      selection &&
      fs.existsSync(path.join(capabilityDirectory(this.dataDir, id), "revoked.json"));
    if (revoked) {
      if (!replace) throw problem("AgentPier session access was revoked.", 403);
      return {
        ...launch,
        agentpierTools: { enabled: false, selection, expiresAt: Date.now() },
      };
    }
    const choices = this.validate(selection);
    if (!choices) return launch;
    if (
      purpose === "login" ||
      pipeline ||
      !["codex", "claude", "opencode"].includes(account.tool)
    )
      throw problem("AgentPier tools are only available to standalone coding sessions.");
    await this.ready;
    const projectIds = [...choices.projectIds];
    if (choices.currentProject)
      projectIds.push((await this.services.memory.register(cwd)).id);
    const folder = capabilityDirectory(this.dataDir, id);
    this.discard(id);
    privatePath(path.dirname(folder), this.dataDir);
    privateDirectory(folder);
    const generation = randomUUID(),
      token = randomBytes(32).toString("hex");
    const expiresAt = Date.now() + 12 * 60 * 60_000;
    const grant = {
      id: `session-${id}`,
      clientId: `session-${id}`,
      sessionId: id,
      scopes: choices.scopes,
      projectIds: [...new Set(projectIds)],
      accountIds: choices.accountIds,
      connectionIds: choices.connectionIds,
      ownedRunsOnly: true,
    };
    const record = {
      generation,
      token,
      expiresAt,
      accountId: account.id,
      tool: account.tool,
      grant,
    };
    const credential = path.join(folder, `${generation}.json`);
    try {
      writePrivate(path.join(folder, "active.json"), record);
      writePrivate(credential, { token: `${id}.${generation}.${token}` });
      const prepared = sessionMcpLaunch(
        launch,
        account.tool,
        folder,
        credential,
        this.socketPath,
      );
      this.services.audit.append({
        action: "mcp.accepted",
        resourceType: "session",
        resourceId: id,
        source: "user",
        outcome: "success",
        details: { count: grant.projectIds.length },
      });
      return {
        ...prepared,
        agentpierTools: { enabled: true, generation, expiresAt, selection: choices },
      };
    } catch (error) {
      this.discard(id);
      throw error;
    }
  }
  discard(id) {
    revokeSessionMcp(this.dataDir, id);
  }
  check(token) {
    return checkSessionCapability(this.dataDir, token);
  }
  async verify(token) {
    const auth = this.check(token);
    await this.services.sessions.get(auth.sessionId);
    return this.check(token);
  }
  async revoke(id) {
    // Delete first, so an in-flight mutation rechecks a revoked grant immediately.
    this.discard(id);
    writePrivate(path.join(capabilityDirectory(this.dataDir, id), "revoked.json"), {
      revokedAt: Date.now(),
    });
    this.services.audit.append({
      action: "mcp.revoked",
      resourceType: "session",
      resourceId: id,
      source: "user",
      outcome: "success",
    });
    return this.services.sessions.serial(async () => {
      const session = await this.services.sessions.metadata(id);
      if (session.agentpierTools) session.agentpierTools.enabled = false;
      await this.services.sessions.save(session);
      return session;
    });
  }
  async start() {
    const directory = path.dirname(this.socketPath);
    privatePath(directory, "/tmp");
    privateDirectory(directory);
    const active = await new Promise((resolve) => {
      const probe = net.createConnection(this.socketPath);
      probe.once("connect", () => {
        probe.destroy();
        resolve(true);
      });
      probe.once("error", (error) =>
        resolve(!["ENOENT", "ECONNREFUSED"].includes(error.code)),
      );
    });
    if (active) throw Error("AgentPier session MCP broker already running.");
    fs.rmSync(this.socketPath, { force: true });
    // Use the exact same tool registration and authorization rechecks as OAuth MCP.
    const access = {
      status: () => ({ available: true, mcpUrl: "http://localhost/mcp" }),
      publicRouter: (_req, _res, next) => next(),
      verifyAccessToken: (token) => this.verify(token),
      checkAccessToken: (token) => this.check(token),
    };
    this.transport = mcpHttpRouter({
      mcpAccess: access,
      mcpTools: this.services.mcpTools,
    });
    const app = express();
    app.disable("x-powered-by");
    app.use(this.transport.router);
    app.use((_error, _req, res, _next) =>
      res.status(400).json({ error: "Invalid session MCP request." }),
    );
    this.server = http.createServer(app);
    this.server.maxConnections = 64;
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, resolve);
    });
    fs.chmodSync(this.socketPath, 0o600);
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.ready;
    await this.transport.close();
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
    fs.rmSync(this.socketPath, { force: true });
    // Grants survive a web-only restart; session stop/reload handles revocation.
  }
}
