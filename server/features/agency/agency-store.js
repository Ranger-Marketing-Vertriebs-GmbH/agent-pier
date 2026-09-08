import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { readJSON, writePrivate, problem } from "../../lib/storage.js";
import { safePath } from "../extensions/mcp-config.js";
import { profileLocation } from "../cli-profiles/configuration.js";
import {
  download,
  catalogEntries,
  parseAgent,
  nativeAgent,
  repository,
  sourceUrl,
} from "./source.js";
const digest = (text) => createHash("sha256").update(text).digest("hex");
export class AgencyStore {
  constructor({ accounts, sharedProfiles, fetchImpl = fetch }) {
    Object.assign(this, { accounts, sharedProfiles, fetchImpl });
    this.file = path.join(accounts.dataDir, "agency-agents.json");
    this.cacheFile = path.join(accounts.dataDir, "agency-catalog.json");
    this.controllers = new Set();
    this.pending = null;
    this.closed = false;
  }
  async fetchText(url, limit) {
    if (this.closed) throw problem("AgentPier is stopping.", 503);
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      return await download(
        url,
        this.fetchImpl,
        AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
        limit,
      );
    } finally {
      this.controllers.delete(controller);
    }
  }
  async catalog(refresh = false) {
    const saved = readJSON(this.cacheFile, null);
    if (!refresh && saved && Date.now() - saved.checkedAt < 3600000) return saved;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      try {
        const ref = JSON.parse(
          await this.fetchText(
            `https://api.github.com/repos/${repository}/git/ref/heads/main`,
          ),
        );
        const revision = ref.object?.sha;
        if (!/^[a-f0-9]{40}$/.test(revision || ""))
          throw problem("Agency Agents returned an invalid revision.", 502);
        const tree = JSON.parse(
          await this.fetchText(
            `https://api.github.com/repos/${repository}/git/trees/${revision}?recursive=1`,
          ),
        );
        const license = await this.fetchText(
          `https://raw.githubusercontent.com/${repository}/${revision}/LICENSE`,
          32768,
        );
        if (!license.includes("MIT License"))
          throw problem(
            "The Agency Agents license changed; review the source before importing.",
            409,
          );
        const result = {
          revision,
          checkedAt: Date.now(),
          license,
          items: catalogEntries(tree),
        };
        if (this.closed) throw problem("AgentPier is stopping.", 503);
        writePrivate(this.cacheFile, result);
        return result;
      } catch (error) {
        if (saved && !refresh) return { ...saved, stale: true };
        throw error;
      }
    })().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
  location(id) {
    return profileLocation(this.accounts, this.sharedProfiles.resolve(id));
  }
  async list(id, query = {}) {
    const location = this.location(id),
      catalog = await this.catalog(query.refresh === "1");
    const records = readJSON(this.file, []).filter(
      (record) => record.tool === location.account.tool,
    );
    const search = typeof query.q === "string" ? query.q.slice(0, 200).toLowerCase() : "";
    const found = catalog.items.filter(
      (item) =>
        (!query.category || item.category === query.category) &&
        `${item.name} ${item.category}`.includes(search),
    );
    const raw = Number(query.page || 1),
      page =
        Number.isSafeInteger(raw) && raw > 0
          ? Math.min(raw, Math.max(1, Math.ceil(found.length / 20)))
          : 1;
    return {
      sourceUrl,
      revision: catalog.revision,
      checkedAt: catalog.checkedAt,
      stale: Boolean(catalog.stale),
      categories: [...new Set(catalog.items.map((item) => item.category))].sort(),
      total: found.length,
      page,
      hasMore: page * 20 < found.length,
      items: found.slice((page - 1) * 20, page * 20).map((item) => ({
        ...item,
        installed: records.some((record) => record.id === item.id),
      })),
      installed: records.map(({ id, name, revision, source, path }) => ({
        id,
        name,
        revision,
        source,
        path,
      })),
    };
  }
  async preview(id, input) {
    this.location(id);
    const catalog = await this.catalog();
    if (input?.revision !== catalog.revision)
      throw problem(
        "The Agency catalog changed. Refresh the preview before installing.",
        409,
      );
    const item = catalog.items.find((item) => item.id === input.id);
    if (!item) throw problem("Agency agent not found.", 404);
    const source = `https://github.com/${repository}/blob/${catalog.revision}/${item.path}`;
    const text = await this.fetchText(
      `https://raw.githubusercontent.com/${repository}/${catalog.revision}/${item.path}`,
      256 * 1024,
    );
    return {
      ...parseAgent(text),
      id: item.id,
      category: item.category,
      revision: catalog.revision,
      source,
      license: catalog.license,
    };
  }
  async install(id, input) {
    this.sharedProfiles.migrate(id);
    const agent = await this.preview(id, input),
      location = this.location(id),
      tool = location.account.tool;
    if (this.closed) throw problem("AgentPier is stopping.", 503);
    const directory = path.join(location.root, "agents");
    const filename = `agency-${agent.id.replaceAll("__", "-").slice(0, 160)}-${digest(agent.id).slice(0, 8)}.${tool === "codex" ? "toml" : "md"}`;
    const file = path.join(directory, filename);
    safePath(file, location.boundary);
    const records = readJSON(this.file, []);
    if (
      records.some((record) => record.tool === tool && record.id === agent.id) ||
      fs.existsSync(file)
    )
      throw problem("This Agency agent is already installed.", 409);
    const content = nativeAgent(tool, agent, agent.source);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const licenseFile = path.join(directory, "AGENCY-LICENSE.txt");
    safePath(licenseFile, location.boundary);
    if (!fs.existsSync(licenseFile))
      fs.writeFileSync(licenseFile, agent.license, { mode: 0o600, flag: "wx" });
    fs.writeFileSync(file, content, { mode: 0o600, flag: "wx" });
    const info = fs.lstatSync(file);
    const record = {
      id: agent.id,
      name: agent.name,
      tool,
      revision: agent.revision,
      source: agent.source,
      path: file,
      hash: digest(content),
      dev: info.dev,
      ino: info.ino,
    };
    try {
      writePrivate(this.file, [...records, record]);
    } catch (error) {
      fs.unlinkSync(file);
      throw error;
    }
    return record;
  }
  remove(id, agentId) {
    const location = this.location(id),
      records = readJSON(this.file, []);
    const record = records.find(
      (item) => item.tool === location.account.tool && item.id === agentId,
    );
    if (!record) throw problem("Agency agent is not installed for this CLI.", 404);
    if (path.dirname(record.path) !== path.join(location.root, "agents"))
      throw problem("The agent file is outside this CLI's agent directory.", 409);
    safePath(record.path, location.boundary);
    const stat = fs.lstatSync(record.path);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.dev !== record.dev ||
      stat.ino !== record.ino ||
      digest(fs.readFileSync(record.path)) !== record.hash
    )
      throw problem("The agent file changed outside AgentPier; it was retained.", 409);
    fs.unlinkSync(record.path);
    writePrivate(
      this.file,
      records.filter((item) => item !== record),
    );
  }
  close() {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
  }
}
