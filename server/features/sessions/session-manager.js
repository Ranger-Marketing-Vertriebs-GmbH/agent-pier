import { serverMessages } from "../../lib/i18n/de.js";
import { publicProviderConfiguration } from "./provider-configuration.js";
import {
  pipelineIdentity,
  nativeInput,
  assertInteractiveSession,
} from "../pipelines/native-session.js";
import { shellQuote as quote } from "../../lib/launch-serialization.js";
import { validId, validName, dimensions, textInput } from "./session-validation.js";
import { safeEnvironment, execute, privateWrite } from "./session-process-runtime.js";
import { replaceSession } from "./session-replacement.js";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as pty from "node-pty";

const launcher = fileURLToPath(new URL("../../terminal-launcher.js", import.meta.url));
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
/** One private tmux server per data directory. Closing a manager only detaches its clients. */
export class SessionManager {
  constructor({ dataDir, tmuxPath = "tmux", onStopped = () => {} }) {
    if (typeof dataDir !== "string" || !path.isAbsolute(dataDir))
      throw failure("Invalid data directory");
    this.directory = path.join(path.resolve(dataDir), "sessions");
    const hash = createHash("sha256")
      .update(path.resolve(dataDir))
      .digest("hex")
      .slice(0, 24);
    this.socketPath = `/tmp/tuiui-${process.getuid?.() ?? "user"}-${hash}/tmux.sock`;
    this.tmuxPath = tmuxPath;
    this.configPath = path.join(this.directory, "tmux.conf");
    this.clients = new Set();
    this.onStopped = onStopped;
    this.reconciledStops = new Set();
    this.replacing = new Set();
    this.queue = Promise.resolve();
    this.ready = this.initialize();
  }
  async initialize() {
    for (const directory of [this.directory, path.dirname(this.socketPath)]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const info = await lstat(directory);
      if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid()))
        throw new Error("Unsafe terminal storage directory");
      await chmod(directory, 0o700);
    }
    await privateWrite(
      this.configPath,
      // set-clipboard defaults to "external", which drops OSC 52 from the programs
      // inside a pane, and tmux emits the sequence only for a client it believes
      // capable: terminal-features forces that regardless of the attaching TERM.
      // Together they carry both a CLI's own copy request and a copy-mode yank
      // out to the browser, where the terminal view turns them into a clipboard write.
      'set -g remain-on-exit on\nset -g default-shell /bin/sh\nset -g prefix None\nset -g history-limit 50000\nset -g status off\nset -g mouse on\nset -g default-terminal "tmux-256color"\nset -g set-clipboard on\nset -as terminal-features ",*:clipboard"\nset -g exit-empty off\nset -g escape-time 0\n',
    );
  }
  serial(operation) {
    const next = this.queue.then(async () => {
      await this.ready;
      return operation();
    });
    this.queue = next.catch(() => {});
    return next;
  }
  target(id) {
    return `=tuiui-${validId(id)}`;
  }
  file(id) {
    return path.join(this.directory, `${validId(id)}.json`);
  }
  tmux(args, options) {
    return execute(
      this.tmuxPath,
      ["-S", this.socketPath, "-f", this.configPath, ...args],
      options,
    );
  }
  async metadata(id) {
    try {
      return JSON.parse(await readFile(this.file(id), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") throw failure("Session not found", 404);
      throw error;
    }
  }
  async save(session) {
    await privateWrite(this.file(session.id), JSON.stringify(session, null, 2));
  }
  async capture(id) {
    return this.tmux(["capture-pane", "-p", "-t", `${this.target(id)}:0.0`, "-S", "-"]);
  }
  async remember(id) {
    const text = await this.capture(id);
    await privateWrite(path.join(this.directory, `${id}.screen`), text);
    return text;
  }
  async reconcileStopped(session) {
    if (this.reconciledStops.has(session.id)) return;
    await this.onStopped(session);
    this.reconciledStops.add(session.id);
  }
  async current(id) {
    const session = await this.metadata(id);
    let state;
    const readState = async () =>
      (
        await this.tmux([
          "list-panes",
          "-t",
          `${this.target(id)}:`,
          "-F",
          "#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}",
        ])
      ).trim();
    try {
      state = await readState();
      if (state === "1||") {
        // tmux 3.4 + utempter can lose SIGCHLD. A no-output job wakes its reaper.
        // https://github.com/tmux/tmux/issues/4559
        await this.tmux(["run-shell", "-t", `${this.target(id)}:0.0`, ":"]);
        state = await readState();
      }
    } catch (error) {
      // Only a missing pane/server means stopped; executable/permission failures must surface.
      if (
        !/no server running|failed to connect|can't find|no such file|no current target|error connecting/i.test(
          error.message,
        )
      )
        throw error;
      state = null;
    }
    const [dead, code, signal] = state?.split("|") || [];
    const exit =
      dead === "1" && /^\d+$/.test(code) && Number(code) <= 255
        ? Number(code)
        : undefined;
    // tmux 3.4 can close the PTY before waitpid supplies status or signal.
    // See https://github.com/tmux/tmux/blob/3.4/format.c (pane_dead callbacks).
    const status =
      state === null || (dead === "1" && (exit !== undefined || signal))
        ? "stopped"
        : "running";
    if (session.status !== status || (exit !== undefined && session.exitCode !== exit)) {
      session.status = status;
      if (exit !== undefined && Number.isFinite(exit)) session.exitCode = exit;
      if (state !== null && status === "stopped") await this.remember(id);
      await this.save(session);
    }
    if (
      status === "stopped" &&
      !["waiting", "reloading", "failed"].includes(session.reload?.state)
    )
      await this.reconcileStopped(session);
    return session;
  }
  async create(options) {
    return this.serial(async () => {
      if (!options || typeof options !== "object")
        throw failure("Invalid session options");
      const {
        id = randomUUID(),
        tool,
        accountId,
        cwd,
        command,
        args = [],
        env = {},
      } = options;
      validId(id);
      validId(accountId);
      const pipeline = pipelineIdentity(options.pipeline);
      const input = nativeInput(options);
      const name = validName(options.name);
      if (!["codex", "claude", "opencode", "shell"].includes(tool))
        throw failure("Invalid session tool");
      if (
        tool === "shell" &&
        (accountId !== "local-shell" ||
          options.purpose === "login" ||
          options.agentbus?.enabled ||
          (options.launchMode && options.launchMode !== "default"))
      )
        throw failure(serverMessages.sessions.shellConfigurationRestricted);
      if (
        typeof cwd !== "string" ||
        !path.isAbsolute(cwd) ||
        cwd.includes("\0") ||
        !(await stat(cwd).then(
          (info) => info.isDirectory(),
          () => false,
        ))
      )
        throw failure("Invalid working directory");
      if (
        typeof command !== "string" ||
        !path.isAbsolute(command) ||
        command.includes("\0") ||
        !(await stat(command).then(
          (info) => info.isFile(),
          () => false,
        ))
      )
        throw failure("Invalid executable");
      await access(command, constants.X_OK).catch(() => {
        throw failure("Invalid executable");
      });
      if (
        !Array.isArray(args) ||
        args.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
        args.join("").length > 1024 * 1024
      )
        throw failure("Invalid command arguments");
      if (
        !env ||
        typeof env !== "object" ||
        Array.isArray(env) ||
        Object.entries(env).some(
          ([key, value]) =>
            !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
            typeof value !== "string" ||
            value.includes("\0"),
        )
      )
        throw failure("Invalid environment");
      try {
        await access(this.file(id));
        throw failure("Session already exists", 409);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const launchFile = path.join(this.directory, `${id}.launch.json`);
      await privateWrite(
        launchFile,
        JSON.stringify({
          command,
          args,
          cwd,
          env: { TERM: "xterm-256color", ...env },
          ...input,
          ...(options.nativeObservation
            ? {
                observationPath: path.join(this.directory, `${id}.events.jsonl`),
                outcomePath: path.join(this.directory, `${id}.outcome.json`),
              }
            : {}),
        }),
      );
      const session = {
        id,
        name,
        tool,
        accountId,
        cwd,
        status: "running",
        createdAt: new Date().toISOString(),
        ...(pipeline ? { pipeline } : {}),
        ...(options.launchMode ? { launchMode: options.launchMode } : {}),
        ...(options.purpose === "login" ? { purpose: "login" } : {}),
        ...(options.agentbus
          ? {
              agentbus: {
                enabled: options.agentbus.enabled === true,
                ...(options.agentbus.enabled
                  ? {
                      projectId: options.agentbus.projectId,
                      version: options.agentbus.version,
                    }
                  : {}),
              },
            }
          : {}),
      };
      if (options.nativeModelId) session.nativeModelId = options.nativeModelId;
      if (options.sshTools)
        session.sshTools = {
          enabled: options.sshTools.enabled === true,
          generation: options.sshTools.generation,
        };
      const eligible = tool !== "shell" && options.purpose !== "login";
      if (options.access && eligible)
        session.access = Object.fromEntries(
          [
            "providerConnectionId",
            "providerConnectionName",
            "providerId",
            "providerModelId",
            "sourceAccountId",
          ]
            .filter((key) => typeof options.access[key] === "string")
            .map((key) => [key, options.access[key]]),
        );
      if (options.memory?.enabled && eligible)
        session.memory = { enabled: true, projectId: options.memory.projectId };
      if (options.provider && eligible)
        session.provider = publicProviderConfiguration(options.provider);
      if (options.nativeBinding && eligible)
        session.nativeBinding = {
          enabled: options.nativeBinding.enabled === true,
          version: 1,
        };
      if (options.nativeRequests?.enabled && eligible && !pipeline?.headless)
        session.nativeRequests = { enabled: true, version: 1 };
      const dir =
        eligible && !pipeline?.headless ? options.attachments?.directory : undefined;
      if (typeof dir === "string" && path.isAbsolute(dir) && !dir.includes("\0"))
        session.attachments = { directory: dir };
      await this.save(session);
      try {
        // The shell sees only executable/file paths. Arguments and credentials stay in a private, one-use payload.
        await this.tmux([
          "new-session",
          "-d",
          "-s",
          `tuiui-${id}`,
          "-c",
          cwd,
          "-x",
          "120",
          "-y",
          "35",
          [process.execPath, launcher, launchFile].map(quote).join(" "),
        ]);
      } catch (error) {
        await rm(launchFile, { force: true });
        await rm(this.file(id), { force: true });
        throw error;
      }
      return session;
    });
  }
  updateReload(id, reload) {
    return this.serial(async () => {
      const session = await this.metadata(id);
      session.reload = reload;
      await this.save(session);
    });
  }
  replace(id, prepare, beforeStop) {
    this.replacing.add(id);
    return this.serial(() => replaceSession(this, id, prepare, beforeStop)).finally(() =>
      this.replacing.delete(id),
    );
  }
  list() {
    return this.serial(async () => {
      const names = (await readdir(this.directory)).filter((name) =>
        /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}\.json$/.test(name),
      );
      const sessions = [];
      for (const name of names) sessions.push(await this.current(name.slice(0, -5)));
      return sessions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    });
  }
  get(id) {
    return this.serial(() => this.current(id));
  }
  rename(id, name) {
    return this.serial(async () => {
      const session = await this.current(id);
      session.name = validName(name);
      await this.save(session);
      return session;
    });
  }
  stop(id) {
    return this.serial(async () => {
      const session = await this.current(id);
      try {
        await this.remember(id);
        await this.tmux(["kill-session", "-t", this.target(id)]);
      } catch (error) {
        if (session.status === "running") throw error;
      }
      session.status = "stopped";
      if (session.reload)
        session.reload = { ...session.reload, state: "idle", nativeId: null };
      await this.reconcileStopped(session);
      await this.save(session);
      return session;
    });
  }
  remove(id) {
    return this.serial(async () => {
      const session = await this.current(id);
      if (session.status === "running")
        throw failure("Stop the running session before deleting it", 409);
      await this.tmux(["kill-session", "-t", this.target(id)]).catch(() => {});
      for (const extension of [
        "json",
        "screen",
        "launch.json",
        "events.jsonl",
        "outcome.json",
      ])
        await rm(path.join(this.directory, `${id}.${extension}`), {
          force: true,
        });
    });
  }
  screen(id) {
    return this.serial(async () => {
      await this.current(id);
      try {
        return await this.remember(id);
      } catch (error) {
        try {
          return await readFile(path.join(this.directory, `${id}.screen`), "utf8");
        } catch (readError) {
          if (readError.code === "ENOENT") return "";
          throw readError;
        }
      }
    });
  }
  control(id, operation, { allowStopped = false } = {}) {
    return this.serial(async () => {
      const session = await this.current(id);
      assertInteractiveSession(session);
      if (session.reload?.state === "reloading")
        throw failure("Session is reloading", 409);
      if (session.tool === "shell")
        throw failure(serverMessages.sessions.shellModelPickerUnavailable, 409);
      if (session.purpose === "login")
        throw failure(serverMessages.sessions.loginModelPickerUnavailable, 409);
      if (!allowStopped && session.status !== "running")
        throw failure(serverMessages.sessions.stopped, 409);
      const target = `${this.target(id)}:0.0`;
      return operation({
        session,
        screen: () =>
          this.tmux(["capture-pane", "-e", "-p", "-t", target]).catch((error) => {
            if (session.status === "stopped") return "";
            throw error;
          }),
        keys: async (keys) => {
          if (
            !Array.isArray(keys) ||
            keys.length > 100 ||
            keys.some(
              (key) =>
                ![
                  "M-p",
                  "C-x",
                  "m",
                  "Up",
                  "Down",
                  "Enter",
                  "Escape",
                  "s",
                  "C-e",
                  "C-u",
                ].includes(key),
            )
          )
            throw failure("Invalid control keys");
          if (keys.length) await this.tmux(["send-keys", "-t", target, ...keys]);
        },
        type: async (text) => {
          textInput(text);
          if (text) await this.tmux(["send-keys", "-l", "-t", target, "--", text]);
        },
      });
    });
  }
  input(id, text, submit = false, beforeInput) {
    if (this.replacing.has(id))
      return Promise.reject(failure("Session is reloading", 409));
    return this.serial(async () => {
      textInput(text);
      if (typeof submit !== "boolean") throw failure("Invalid submit flag");
      const session = await this.current(id);
      if (session.reload?.state === "reloading")
        throw failure("Session is reloading", 409);
      if (session.status !== "running") throw failure("Session is stopped", 409);
      assertInteractiveSession(session);
      if (beforeInput)
        await beforeInput(
          session,
          await this.tmux(["capture-pane", "-e", "-p", "-t", `${this.target(id)}:0.0`]),
        );
      if (text) {
        const buffer = `tuiui-${randomUUID()}`;
        await this.tmux(["load-buffer", "-b", buffer, "-"], { input: text });
        try {
          await this.tmux([
            "paste-buffer",
            "-d",
            "-p",
            "-r",
            "-b",
            buffer,
            "-t",
            `${this.target(id)}:0.0`,
          ]);
        } catch (error) {
          await this.tmux(["delete-buffer", "-b", buffer]).catch(() => {});
          throw error;
        }
      }
      if (submit) await this.tmux(["send-keys", "-t", `${this.target(id)}:0.0`, "Enter"]);
    });
  }
  attach(id, { cols = 120, rows = 35, onData = () => {}, onExit = () => {} } = {}) {
    return this.serial(async () => {
      dimensions(cols, rows);
      const session = await this.current(id);
      const present = await this.tmux(["has-session", "-t", this.target(id)]).then(
        () => true,
        () => false,
      );
      if (session.status === "stopped") {
        const text = present
          ? await this.tmux([
              "capture-pane",
              "-e",
              "-p",
              "-t",
              `${this.target(id)}:0.0`,
              "-S",
              "-",
            ])
          : await readFile(path.join(this.directory, `${id}.screen`), "utf8").catch(
              () => "",
            );
        queueMicrotask(() => {
          onData(text.replaceAll("\n", "\r\n"));
          onExit({ exitCode: session.exitCode ?? 0 });
        });
        return { write() {}, resize() {}, dispose() {} };
      }
      // The browser always speaks UTF-8, even when launchd supplies no locale.
      const terminal = pty.spawn(
        this.tmuxPath,
        ["-u", "-S", this.socketPath, "attach-session", "-t", this.target(id)],
        {
          name: "xterm-256color",
          cols,
          rows,
          cwd: this.directory,
          env: { ...safeEnvironment(), TERM: "xterm-256color" },
        },
      );
      let disposed = false;
      const data = terminal.onData(onData);
      const exit = terminal.onExit((event) => {
        this.clients.delete(client);
        data.dispose();
        onExit(event);
      });
      const client = {
        sessionId: id,
        write: (text) => {
          textInput(text);
          assertInteractiveSession(session);
          if (this.replacing.has(id))
            return Promise.reject(failure("Session is reloading", 409));
          return this.serial(async () => {
            if (disposed) return;
            if ((await this.metadata(id)).reload?.state === "reloading")
              throw failure("Session is reloading", 409);
            terminal.write(text);
          });
        },
        resize: (nextCols, nextRows) => {
          dimensions(nextCols, nextRows);
          if (!disposed) terminal.resize(nextCols, nextRows);
        },
        dispose: () => {
          if (disposed) return;
          disposed = true;
          data.dispose();
          exit.dispose();
          this.clients.delete(client);
          terminal.kill();
        },
      };
      this.clients.add(client);
      return client;
    });
  }
  async close() {
    await this.queue;
    for (const client of [...this.clients]) client.dispose();
  }
}
