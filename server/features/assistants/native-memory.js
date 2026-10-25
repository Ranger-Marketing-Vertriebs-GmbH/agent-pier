import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { memoryEnabled } from "./native-capabilities.js";
import { assistantProblem, textValue } from "./assistant-validation.js";
import { leadMirrorDir } from "./member-memory.js";
import { openInside } from "./project-open.js";
const names = new Set(["MEMORY.md", "USER.md"]);
const projectFile = (file, name) => ({
  name,
  content: typeof file?.content === "string" ? file.content : "",
  missing: file?.missing === true,
  hash: /^[a-f0-9]{64}$/i.test(file?.hash || "") ? file.hash : null,
});
// OpenClaw indexes MEMORY.md, USER.md and Markdown files recursively under
// memory/. The two root files are edited through the Gateway; notes under memory/
// are the agent's own working layer and are shown read-only from its workspace.
const noteName = /^memory\/(?:[A-Za-z0-9][\w.-]*\/){0,3}[A-Za-z0-9][\w.-]*\.md$/;
// OpenClaw's Dream Diary: a file in the workspace root, shown read-only.
const diaryName = "DREAMS.md";
// Dreaming's raw corpus; it is never listed, read or searched.
const corpusFolder = /(^|\/)memory\/\.dreams(\/|$)/;
const maxNotes = 200,
  maxNoteBytes = 262144;
// The workspace and its memory/ folder must be real directories: a symbolic link
// in their place would list or read notes from outside the agent's workspace.
async function assertRealDirectories(root, notes = true) {
  for (const dir of notes ? [root, path.join(root, "memory")] : [root])
    if (!(await fs.lstat(dir)).isDirectory()) throw Error("link");
}
export class NativeMemory {
  constructor(assistants, { workspaces } = {}) {
    this.assistants = assistants;
    this.workspaces = workspaces;
  }
  root(id) {
    const agent = this.assistants.store.getAssistant(id);
    if (!memoryEnabled(agent)) throw assistantProblem("invalid", 403);
    const workspaces = this.workspaces ?? this.assistants.config?.workspaces;
    if (!workspaces) throw assistantProblem("unavailable", 503);
    return path.join(workspaces, agent.id);
  }
  // Notes under memory/ are read from disk, yet they follow the same admission
  // gate as the root notes: no reads while agents are closed, recovering or in
  // maintenance, when a restore or update may be replacing the workspace.
  files(id) {
    return this.assistants.admit(() => this.listNotes(id));
  }
  async listNotes(id) {
    const root = this.root(id),
      files = [];
    try {
      await assertRealDirectories(root, false);
      const stat = await fs.lstat(path.join(root, diaryName));
      if (stat.isFile())
        files.push({
          name: diaryName,
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          diary: true,
        });
    } catch (error) {
      if (error.code !== "ENOENT") return { files };
    }
    try {
      await assertRealDirectories(root);
    } catch {
      return { files };
    }
    const walk = async (dir, depth) => {
      let entries;
      try {
        entries = await fs.readdir(path.join(root, dir), { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (files.length >= maxNotes) return;
        const name = `${dir}/${entry.name}`;
        // Symbolic links are skipped: a note never leaves the agent's workspace.
        // A task member's copy of its lead's memory is not its own (member-memory.js).
        if (name === leadMirrorDir) continue;
        if (entry.isDirectory() && depth < 3) await walk(name, depth + 1);
        else if (entry.isFile() && noteName.test(name)) {
          const stat = await fs.lstat(path.join(root, name));
          files.push({ name, size: stat.size, modifiedAt: stat.mtime.toISOString() });
        }
      }
    };
    await walk("memory", 0);
    // The diary stays first; notes follow, newest first.
    const diary = files.filter((f) => f.diary);
    const notes = files.filter((f) => !f.diary);
    notes.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    files.splice(0, files.length, ...diary, ...notes);
    return { files };
  }
  async readNote(id, name) {
    const diary = name === diaryName;
    if (!diary && (!noteName.test(name) || name.split("/").includes("..")))
      throw assistantProblem("invalid");
    const root = this.root(id),
      file = path.join(root, name);
    let handle;
    try {
      // Every component must be a real directory or file inside the workspace.
      await assertRealDirectories(root, !diary);
      const real = await fs.realpath(file);
      if (real !== path.join(await fs.realpath(root), name)) throw Error("link");
      // The open follows no link on the way (openInside), so a folder swapped for
      // one after the checks above is refused; the opened handle is checked itself,
      // so a swap cannot substitute an oversized file either.
      handle = await openInside(real, constants.O_RDONLY);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > maxNoteBytes) throw Error("size");
      const content = await handle.readFile("utf8");
      return {
        name,
        content,
        missing: false,
        readOnly: true,
        hash: createHash("sha256").update(content).digest("hex"),
      };
    } catch (error) {
      if (error.code === "ENOENT") throw assistantProblem("notFound", 404);
      throw assistantProblem("invalid");
    } finally {
      await handle?.close();
    }
  }
  /**
   * Deletes one note under memory/ (the owner reviews shared memory, users delete
   * their own agents' notes): 400 for MEMORY.md, USER.md or any other path, 404
   * when the note does not exist. Links are never followed.
   */
  remove(id, name) {
    return this.assistants.admit(async () => {
      if (
        typeof name !== "string" ||
        !noteName.test(name) ||
        name.split("/").includes("..")
      )
        throw assistantProblem("invalid");
      const root = this.root(id),
        file = path.join(root, name);
      try {
        await assertRealDirectories(root);
        const real = await fs.realpath(file);
        if (real !== path.join(await fs.realpath(root), name)) throw Error("link");
        if (!(await fs.lstat(real)).isFile()) throw Error("type");
        await fs.unlink(real);
      } catch (error) {
        if (error.code === "ENOENT") throw assistantProblem("notFound", 404);
        throw assistantProblem("invalid");
      }
      this.assistants.changed();
    });
  }
  async prepare(id) {
    const a = this.assistants;
    const agent = a.store.getAssistant(id);
    if (!memoryEnabled(agent)) throw assistantProblem("invalid", 403);
    a.requireReady();
    await a.config.apply(id);
    return agent;
  }
  async call(method, input) {
    try {
      return await this.assistants.runtime.client.call(method, input);
    } catch (error) {
      throw assistantProblem(
        error.code === "CONFLICT" ? "conflict" : "unavailable",
        error.code === "CONFLICT" ? 409 : 503,
      );
    }
  }
  read(id, name) {
    if (typeof name === "string" && (name.startsWith("memory/") || name === diaryName))
      return this.assistants.admit(() => this.readNote(id, name));
    return this.assistants.admit(async () => {
      if (!names.has(name)) throw assistantProblem("invalid");
      const agent = await this.prepare(id);
      const result = await this.call("agents.files.get", {
        agentId: agent.runtimeAgentId,
        name,
      });
      return projectFile(result.file, name);
    });
  }
  write(id, input) {
    return this.assistants.admit(async () => {
      if (
        !input ||
        Object.keys(input).some(
          (k) => !["name", "content", "expectedHash", "expectedMissing"].includes(k),
        ) ||
        !names.has(input.name)
      )
        throw assistantProblem("invalid");
      textValue(input.content, 65536, true);
      const hash = /^[a-f0-9]{64}$/i.test(input.expectedHash || "");
      if (
        hash === (input.expectedMissing === true) ||
        (!hash && "expectedHash" in input) ||
        ("expectedMissing" in input && input.expectedMissing !== true)
      )
        throw assistantProblem("invalid");
      const agent = await this.prepare(id);
      const result = await this.call("agents.files.set", {
        agentId: agent.runtimeAgentId,
        ...input,
      });
      this.assistants.changed();
      return projectFile(result.file, input.name);
    });
  }
  search(id, query) {
    return this.assistants.admit(async () => {
      textValue(query, 1000);
      const agent = await this.prepare(id);
      const result = await this.call("tools.invoke", {
        name: "memory_search",
        agentId: agent.runtimeAgentId,
        sessionKey: `agent:${agent.runtimeAgentId}:main`,
        args: { query, maxResults: 12 },
      });
      const details = result.output?.details;
      if (!result.ok || !Array.isArray(details?.results))
        throw assistantProblem("unavailable", 503);
      return {
        results: details.results
          .slice(0, 12)
          .filter(
            (r) =>
              typeof r.path === "string" &&
              !r.path.startsWith("/") &&
              !r.path.includes("..") &&
              !corpusFolder.test(path.posix.normalize(r.path.replaceAll("\\", "/"))),
          )
          .map((r) => ({
            path: r.path.slice(0, 256),
            snippet: String(r.snippet || "").slice(0, 4000),
            startLine: r.startLine,
            endLine: r.endLine,
          })),
      };
    });
  }
}
