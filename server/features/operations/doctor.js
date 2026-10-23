import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { applicationVersion } from "./version.js";
import { readJson } from "./files.js";
import { detectTools } from "../accounts/account-store.js";
import { toolBinDirectories } from "../tools/tool-paths.js";
import { problem } from "../../lib/storage.js";
import { validateEndpoint } from "../providers/endpoint-config.js";
import { toolRoutes } from "../providers/endpoint-routing.js";
import { adapterSessionChecks } from "./adapter-doctor.js";
import { nodeCheckStatus } from "../../lib/node-support.js";
const execute = promisify(execFile);
// English remedy text for CLI and API readers; the UI translates the stable remedy id.
const REMEDIES = {
  platform: "Use a supported macOS or Linux host.",
  pty: "Reinstall dependencies for this Node runtime and platform.",
  tool: "Install the tool or correct the service PATH.",
  project: "Restore or map the project checkout on this host.",
  node: "Update Node.js to 22.23.4, 24.22.1, 26.12.1 or later (security fixes).",
};
// A remedy only belongs to a check that needs action.
const needsRemedy = (status) => status === "warn" || status === "fail";
export async function inertCommand(command, args) {
  try {
    const result = await execute(command, args, {
      timeout: 3000,
      maxBuffer: 32768,
      encoding: "utf8",
      env: { PATH: process.env.PATH || "/usr/bin:/bin", LANG: "C" },
    });
    return { code: 0, stdout: result.stdout };
  } catch {
    return { code: 1, stdout: "" };
  }
}
export class Doctor {
  constructor({
    dataDir,
    home = os.homedir(),
    platform = process.platform,
    command = inertCommand,
    ptyCheck = () => import("node-pty"),
    serving = false,
  }) {
    Object.assign(this, { dataDir, home, platform, command, ptyCheck, serving });
  }
  async run({ scope = "host", projectId, deep = false } = {}) {
    if (
      !["host", "project"].includes(scope) ||
      typeof deep !== "boolean" ||
      (scope === "project" && typeof projectId !== "string")
    )
      throw problem(serverMessages.operations.invalidDiagnosticScope);
    const checks = [],
      push = ({ id, status, summary, remedy, remedyId, details }) =>
        checks.push({
          id,
          status,
          summary,
          ...(remedy && needsRemedy(status) ? { remedy, remedyId } : {}),
          ...(details ? { details } : {}),
        }),
      add = (id, status, summary, remedyId, details) =>
        push({ id, status, summary, remedy: REMEDIES[remedyId], remedyId, details });
    add(
      "platform",
      ["darwin", "linux"].includes(this.platform) ? "ok" : "fail",
      `${this.platform}/${process.arch}`,
      "platform",
    );
    add("node", nodeCheckStatus(process.versions.node), process.versions.node, "node");
    try {
      await this.ptyCheck();
      add("pty", "ok", "Native terminal module loads.");
    } catch {
      add("pty", "fail", "Native terminal module is unavailable.", "pty");
    }
    const tools = detectTools(
      { PATH: process.env.PATH, HOME: this.home },
      false,
      toolBinDirectories(this.dataDir),
    );
    for (const [id, command, args, required] of [
      ["tmux", "tmux", ["-V"], true],
      ["git", "git", ["--version"], true],
      ...["codex", "claude", "opencode"].map((id) => [
        `cli.${id}`,
        tools.find((t) => t.id === id)?.path || id,
        ["--version"],
        false,
      ]),
    ]) {
      const result = await this.command(command, args);
      const version = /\d+(?:\.\d+){0,3}[a-z]?/i.exec(result.stdout)?.[0];
      add(
        id,
        result.code === 0 ? "ok" : required ? "fail" : "warn",
        result.code === 0
          ? `Detected version ${version || "unknown"}.`
          : "Executable is unavailable.",
        "tool",
      );
    }
    add(
      "listener",
      this.serving ? "ok" : "skip",
      this.serving
        ? "Report requested from the running web instance."
        : "No listener probe was requested.",
    );
    const serviceFile =
      this.platform === "darwin"
        ? path.join(this.home, "Library/LaunchAgents/dev.agentpier.server.plist")
        : path.join(this.home, ".config/systemd/user/dev.agentpier.server.service");
    add(
      "service",
      fs.existsSync(serviceFile) ? "ok" : "skip",
      fs.existsSync(serviceFile)
        ? "User service definition exists; running state was not changed."
        : "No user service definition found.",
    );
    try {
      const st = fs.lstatSync(this.dataDir);
      add(
        "storage",
        st.isDirectory() &&
          !st.isSymbolicLink() &&
          (!process.getuid || st.uid === process.getuid()) &&
          (st.mode & 0o077) === 0
          ? "ok"
          : "fail",
        "Data directory ownership and private permissions checked.",
      );
      const disk = fs.statfsSync(this.dataDir),
        free = disk.bavail * disk.bsize;
      add(
        "disk",
        free < 512 * 1024 ** 2 ? "fail" : free < 2 * 1024 ** 3 ? "warn" : "ok",
        `${Math.floor(free / 1024 ** 2)} MiB available.`,
      );
    } catch {
      add("storage", "fail", "Data directory is unavailable.");
    }
    for (const name of [
      "memory/memory.sqlite",
      "pipeline-runs/runs.sqlite",
      "audit/audit.sqlite",
    ]) {
      const file = path.join(this.dataDir, name);
      if (!fs.existsSync(file)) {
        add(`database.${name}`, "skip", "Database has not been created.");
        continue;
      }
      let db;
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error();
        db = new DatabaseSync(file, { readOnly: true });
        const result = db
          .prepare(`PRAGMA ${deep ? "integrity_check" : "quick_check"}`)
          .all();
        add(
          `database.${name}`,
          result.length === 1 && Object.values(result[0])[0] === "ok" ? "ok" : "fail",
          "SQLite integrity check completed.",
        );
      } catch {
        add(`database.${name}`, "fail", "Database cannot be safely read.");
      } finally {
        db?.close();
      }
    }
    const accounts = readJson(path.join(this.dataDir, "accounts.json"), []);
    for (const account of accounts)
      if (account.provider && !account.internal)
        add(
          `account.${account.id}`,
          fs.existsSync(path.join(this.dataDir, "profiles", account.id, "secret.json"))
            ? "ok"
            : "warn",
          "Provider key presence checked; validity and entitlement were not tested.",
        );
    for (const connection of readJson(
      path.join(this.dataDir, "provider-connections.json"),
      [],
    )) {
      const keyed = fs.existsSync(
        path.join(this.dataDir, "provider-connection-secrets", `${connection.id}.json`),
      );
      if (connection.providerId === "endpoint") {
        let endpoint = null;
        try {
          endpoint = validateEndpoint(connection.endpoint);
        } catch {
          endpoint = null;
        }
        if (!endpoint) {
          add(
            `provider-connection.${connection.id}`,
            "warn",
            `Custom endpoint settings are invalid; the connection is hidden and cannot be launched until provider-connections.json is repaired. Key ${keyed ? "configured" : "not configured"}.`,
          );
          continue;
        }
        const routes = toolRoutes(endpoint);
        const routeText = Object.entries(routes)
          .map(
            ([tool, route]) =>
              `${tool}=${route ? `${route.mode}:${route.source}` : "off"}`,
          )
          .join(", ");
        const blankAuthorization =
          endpoint.authHeader && routes.opencode?.mode === "sdk"
            ? ` OpenCode sends a blank Authorization header next to ${endpoint.authHeader} on its ${routes.opencode.source} route; whether Azure OpenAI accepts that is unverified.`
            : "";
        const missing = (connection.endpoint?.models || []).filter(
          (model) => !model.contextTokens,
        ).length;
        const tested = connection.endpoint?.lastTest;
        add(
          `provider-connection.${connection.id}`,
          missing ? "warn" : "ok",
          `Custom endpoint; key ${keyed ? "configured" : "not configured"}; ${
            tested
              ? `last test ${tested.at}: ${Object.entries(tested.protocols || {})
                  .map(([name, status]) => `${name}=${status}`)
                  .join(", ")}`
              : "never tested"
          }; ${missing} model(s) without context; routes ${routeText}. No network check was performed.${blankAuthorization}`,
        );
        continue;
      }
      add(
        `provider-connection.${connection.id}`,
        keyed ? "ok" : "warn",
        "Provider key presence checked; validity and entitlement were not tested.",
      );
    }
    for (const check of adapterSessionChecks(this.dataDir)) push(check);
    const projects =
      readJson(path.join(this.dataDir, "repositories.json"), { projects: [] }).projects ||
      [];
    if (scope === "project" && !projects.some((p) => p.id === projectId))
      throw problem(serverMessages.operations.diagnosticProjectNotFound, 404);
    for (const project of projects.filter((p) => scope === "host" || p.id === projectId))
      add(
        `project.${project.id}`,
        fs.existsSync(project.path) ? "ok" : "fail",
        fs.existsSync(project.path)
          ? "Project directory exists."
          : "Project directory is missing.",
        "project",
      );
    return {
      version: applicationVersion(),
      generatedAt: new Date().toISOString(),
      checks,
    };
  }
}
