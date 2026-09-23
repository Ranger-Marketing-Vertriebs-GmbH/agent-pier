import { removeSession } from "./session-removal.js";
import { recordManualInput } from "./manual-input-guard.js";
import { prepareModelViewport } from "../models/model-viewport.js";
import { drainSessionLists, getSessionList } from "./session-list.js";
import { SessionOperations } from "./session-operations.js";
import { sendSlashCommand } from "./session-slash-command.js";
import { inputChat, withChatInput } from "./session-chat-input.js";
import { serverMessages } from "../../lib/i18n/de.js";
import { buildSessionLaunch } from "./session-creation.js";
import { assertInteractiveSession } from "../pipelines/native-session.js";
import { validId, validName, dimensions, textInput } from "./session-validation.js";
import { safeEnvironment, execute, privateWrite } from "./session-process-runtime.js";
import { replaceSession, blocksTerminalInput } from "./session-replacement.js";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as pty from "node-pty";
const launcher = fileURLToPath(new URL("../../terminal-launcher.js", import.meta.url));
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
/** One private tmux server per data directory. Closing a manager only detaches its clients. */
export class SessionManager {
  constructor({
    dataDir,
    tmuxPath = "tmux",
    onStopped = () => {},
    onRemoving = () => {},
  }) {
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
    this.onRemoving = onRemoving;
    this.reconciledStops = new Set();
    this.replacing = new Set();
    this.pendingTerminalInput = new Set();
    this.operations = new SessionOperations(() => this.ready);
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
      this.directory,
      "tmux.conf",
      // Enable OSC 52 clipboard; cap shared history (50000 lines exhausted RAM).
      'set -g remain-on-exit on\nset -g default-shell /bin/sh\nset -g prefix None\nset -g history-limit 10000\nset -g status off\nset -g mouse on\nset -g default-terminal "tmux-256color"\nset -g set-clipboard on\nset -as terminal-features ",*:clipboard"\nset -g exit-empty off\nset -g escape-time 0\n',
    );
  }
  serial(operation, id) {
    return this.operations.run(operation, id);
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
      { cwd: this.directory, ...options },
    );
  }
  async metadata(id) {
    try {
      return JSON.parse(await readFile(this.file(id), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") throw failure(serverMessages.sessions.notFound, 404);
      throw error;
    }
  }
  async save(session) {
    const filename = `${validId(session.id)}.json`;
    await privateWrite(this.directory, filename, JSON.stringify(session, null, 2));
  }
  async capture(id) {
    return this.tmux(["capture-pane", "-p", "-t", `${this.target(id)}:0.0`, "-S", "-"]);
  }
  async remember(id) {
    const text = await this.capture(id);
    await privateWrite(this.directory, `${id}.screen`, text);
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
      const { id, launchFile, session } = await buildSessionLaunch(this, options);
      try {
        // Execute the launcher directly: an old tmux daemon may retain a deleted
        // release cwd, which makes an intermediate shell emit getcwd errors.
        // Arguments and credentials stay in the private, one-use payload.
        await this.tmux([
          "new-session",
          "-d",
          "-s",
          `tuiui-${id}`,
          "-c",
          session.cwd,
          "-x",
          "120",
          "-y",
          "35",
          process.execPath,
          launcher,
          launchFile,
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
    }, id);
  }
  replace(id, prepare, beforeStop) {
    this.replacing.add(id);
    return this.serial(() => replaceSession(this, id, prepare, beforeStop)).finally(() =>
      this.replacing.delete(id),
    );
  }
  list() {
    return getSessionList(this);
  }
  get(id) {
    return this.serial(() => this.current(id), id);
  }
  rename(id, name) {
    return this.serial(async () => {
      const session = await this.current(id);
      session.name = validName(name);
      await this.save(session);
      return session;
    }, id);
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
      this.pendingTerminalInput.delete(id);
      session.status = "stopped";
      if (session.reload)
        session.reload = { ...session.reload, state: "idle", nativeId: null };
      await this.reconcileStopped(session);
      await this.save(session);
      return session;
    }, id);
  }
  remove(id) {
    return removeSession(this, id);
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
    }, id);
  }
  control(id, operation, { allowStopped = false } = {}) {
    return this.serial(async () => {
      const session = await this.current(id);
      assertInteractiveSession(session);
      if (session.reload?.state === "reloading")
        throw failure(serverMessages.sessions.reloading, 409);
      if (session.tool === "shell")
        throw failure(serverMessages.sessions.shellModelPickerUnavailable, 409);
      if (session.purpose === "login")
        throw failure(serverMessages.sessions.loginModelPickerUnavailable, 409);
      if (!allowStopped && session.status !== "running")
        throw failure(serverMessages.sessions.stopped, 409);
      const target = `${this.target(id)}:0.0`;
      return operation({
        session,
        prepareModelPicker: () => prepareModelViewport(this, target),
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
            throw failure(serverMessages.sessions.invalidControlKeys);
          if (keys.length) await this.tmux(["send-keys", "-t", target, ...keys]);
        },
        type: async (text) => {
          textInput(text);
          if (text) await this.tmux(["send-keys", "-l", "-t", target, "--", text]);
        },
      });
    }, id);
  }
  withChatInput(id, operation) {
    return withChatInput(this, id, operation);
  }
  inputChat(id, text, beforeInput, options) {
    return inputChat(this, id, text, beforeInput, options);
  }
  input(id, text, submit = false, beforeInput) {
    if (this.replacing.has(id))
      return Promise.reject(failure(serverMessages.sessions.reloading, 409));
    return this.serial(async () => {
      textInput(text);
      if (typeof submit !== "boolean")
        throw failure(serverMessages.sessions.invalidSubmitFlag);
      const session = await this.current(id);
      if (session.reload?.state === "reloading")
        throw failure(serverMessages.sessions.reloading, 409);
      if (session.status !== "running")
        throw failure(serverMessages.sessions.stopped, 409);
      assertInteractiveSession(session);
      if (beforeInput)
        await beforeInput(
          session,
          await this.tmux(["capture-pane", "-e", "-p", "-t", `${this.target(id)}:0.0`]),
        );
      if (await sendSlashCommand(this, session, text, submit)) return;
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
    }, id);
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
      const inputState = {};
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
            return Promise.reject(failure(serverMessages.sessions.reloading, 409));
          return this.serial(async () => {
            if (disposed) return;
            if (blocksTerminalInput(await this.metadata(id)))
              throw failure(serverMessages.sessions.reloading, 409);
            await recordManualInput(this, session, text, inputState);
            terminal.write(text);
          }, id);
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
    }, id);
  }
  async close() {
    await drainSessionLists(this);
    await this.operations.drain();
    for (const client of [...this.clients]) client.dispose();
  }
}
