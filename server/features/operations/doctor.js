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
const execute = promisify(execFile);
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
      throw problem("Invalid diagnostic scope.");
    const checks = [],
      add = (id, status, summary, remedy, details) =>
        checks.push({
          id,
          status,
          summary,
          ...(remedy ? { remedy } : {}),
          ...(details ? { details } : {}),
        });
    add(
      "platform",
      ["darwin", "linux"].includes(this.platform) ? "ok" : "fail",
      `${this.platform}/${process.arch}`,
      "Use a supported macOS or Linux host.",
    );
    const node = process.versions.node.split(".").map(Number);
    add(
      "node",
      node[0] > 22 || (node[0] === 22 && node[1] >= 13) ? "ok" : "fail",
      process.versions.node,
    );
    try {
      await this.ptyCheck();
      add("pty", "ok", "Native terminal module loads.");
    } catch {
      add(
        "pty",
        "fail",
        "Native terminal module is unavailable.",
        "Reinstall dependencies for this Node runtime and platform.",
      );
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
        result.code ? "Install the tool or correct the service PATH." : undefined,
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
    ))
      add(
        `provider-connection.${connection.id}`,
        fs.existsSync(
          path.join(this.dataDir, "provider-connection-secrets", `${connection.id}.json`),
        )
          ? "ok"
          : "warn",
        "Provider key presence checked; validity and entitlement were not tested.",
      );
    const projects =
      readJson(path.join(this.dataDir, "repositories.json"), { projects: [] }).projects ||
      [];
    if (scope === "project" && !projects.some((p) => p.id === projectId))
      throw problem("Diagnostic project not found.", 404);
    for (const project of projects.filter((p) => scope === "host" || p.id === projectId))
      add(
        `project.${project.id}`,
        fs.existsSync(project.path) ? "ok" : "fail",
        fs.existsSync(project.path)
          ? "Project directory exists."
          : "Project directory is missing.",
        "Restore or map the project checkout on this host.",
      );
    return {
      version: applicationVersion(),
      generatedAt: new Date().toISOString(),
      checks,
    };
  }
}
