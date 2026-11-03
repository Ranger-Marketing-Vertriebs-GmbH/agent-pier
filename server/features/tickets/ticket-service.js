import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { isCodingCli } from "../clis/catalog.js";
import { sessionScope } from "../chat/chat-delivery.js";
import { TICKET_SOURCE_IDS, ticketRef } from "./ticket.js";
import { ticketTask } from "./ticket-task.js";
import { TicketSourceError } from "./http-json.js";
import { ticketSources } from "./sources/index.js";
import { githubApiBase } from "../repositories/github-token-check.js";
import { parseGithubRemote } from "./sources/github.js";
import { TicketStore } from "./ticket-store.js";
import { canonicalKey, startInput } from "./ticket-start-input.js";
import { ticketConnectionsChanged, ticketsProjectChanged } from "./live-topics.js";
import { createTicketSequenceServices } from "./sequence-service.js";

const copy = serverMessages.tickets;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_CODES = new Set(Object.keys(copy.source));
const DELIVERING = new Set(["pending", "handed-off", "uncertain"]);

const plainObject = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);
const byUpdatedDesc = (a, b) =>
  (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
const sortNames = (names) =>
  [...names].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
// Only the code of a source failure leaves the service: never a message, URL or token.
const failureCode = (error) =>
  error instanceof TicketSourceError && SOURCE_CODES.has(error.code)
    ? error.code
    : "invalidResponse";

/**
 * A project's ticket sources: reads tickets fresh from GitHub and Plane, starts one as
 * a session or a pipeline run with a server-built task and moves it to "in progress".
 * Tokens stay inside the source accesses; only failure codes leave.
 */
export class TicketService {
  constructor({
    store,
    memory,
    repositories,
    github,
    gitRemotes,
    launch,
    chatDelivery,
    sessions,
    pipelines,
    live = () => null,
    fetchImpl = globalThis.fetch,
    sources = ticketSources,
    now = Date.now,
  }) {
    Object.assign(this, {
      store,
      memory,
      repositories,
      github,
      gitRemotes,
      launch,
      chatDelivery,
      sessions,
      pipelines,
      live,
      fetchImpl,
      sources,
      now,
    });
    this.starting = new Set();
  }

  resolveProject(projectId) {
    if (typeof projectId !== "string" || !projectId)
      throw problem(copy.projectNotFound, 404);
    try {
      const project = this.memory?.project(projectId);
      if (typeof project?.cwd === "string" && project.cwd)
        return { id: projectId, path: project.cwd };
    } catch (error) {
      if (!(Number.isInteger(error?.status) && error.status < 500)) throw error;
    }
    const cloned = this.repositories
      .listProjects()
      .find((project) => project.id === projectId);
    if (typeof cloned?.path === "string" && cloned.path)
      return { id: projectId, path: cloned.path };
    throw problem(copy.projectNotFound, 404);
  }

  /** The GitHub access of a project folder, or null when a piece is missing. */
  async githubAccess(projectPath) {
    const remote = parseGithubRemote(await this.gitRemotes.read(projectPath));
    if (!remote) return null;
    let canonical;
    try {
      canonical = fs.realpathSync(projectPath);
    } catch {
      return null;
    }
    const hostname = new URL(remote.host).hostname;
    const selection = this.github
      .selections(canonical)
      .find((entry) => entry.host === hostname);
    if (!selection) return null;
    const token = this.repositories.token(selection.credentialId);
    if (!token) return null;
    let credential;
    try {
      credential = this.repositories.credential(selection.credentialId);
    } catch {
      return null;
    }
    return {
      host: remote.host,
      owner: remote.owner,
      repo: remote.repo,
      apiBase: githubApiBase(remote.host),
      token,
      fetchImpl: this.fetchImpl,
      credential: { id: credential.id, name: credential.name },
    };
  }

  connectionAccess(connectionId) {
    const connection = this.store.find(connectionId);
    const token = this.store.token(connection.id);
    if (!token) throw new TicketSourceError("notConnected");
    return {
      connection,
      baseUrl: connection.baseUrl,
      workspaceSlug: connection.workspaceSlug,
      token,
      fetchImpl: this.fetchImpl,
    };
  }

  /** The Plane access of a project link, or null when it is not connected. */
  planeAccess(link) {
    if (!link.plane) return null;
    try {
      const access = this.connectionAccess(link.plane.connectionId);
      return {
        ...access,
        projectId: link.plane.planeProjectId,
        identifier: link.plane.identifier,
        inProgressStateId: link.plane.inProgressStateId,
      };
    } catch {
      return null;
    }
  }

  async accesses(project) {
    const link = this.store.projectLink(project.id);
    return {
      link,
      github: await this.githubAccess(project.path),
      plane: this.planeAccess(link),
    };
  }

  async projectView(projectId) {
    const project = this.resolveProject(projectId);
    const { link, github, plane } = await this.accesses(project);
    const inProgressLabel = link.github.inProgressLabel;
    const githubView = github
      ? {
          state: "connected",
          repo: `${github.owner}/${github.repo}`,
          host: github.host,
          credential: github.credential,
          inProgressLabel,
        }
      : { state: "notConnected", inProgressLabel };
    let planeView = { state: "notConnected" };
    if (link.plane) {
      let connectionName;
      try {
        connectionName = this.store.find(link.plane.connectionId).name;
      } catch {}
      planeView = {
        state: plane ? "connected" : "notConnected",
        connectionId: link.plane.connectionId,
        ...(connectionName ? { connectionName } : {}),
        planeProjectId: link.plane.planeProjectId,
        identifier: link.plane.identifier,
        name: link.plane.name,
        inProgressStateId: link.plane.inProgressStateId,
      };
    }
    return {
      project,
      sources: { github: githubView, plane: planeView },
      starts: this.store.starts(project.id),
    };
  }

  async setSources(projectId, input = {}) {
    if (!plainObject(input)) throw problem(copy.invalidLink);
    const project = this.resolveProject(projectId);
    const current = this.store.projectLink(project.id);
    let plane = current.plane;
    if (input.plane === null) plane = null;
    else if (input.plane !== undefined) {
      const wanted = input.plane;
      if (
        !plainObject(wanted) ||
        typeof wanted.planeProjectId !== "string" ||
        !UUID.test(wanted.planeProjectId)
      )
        throw problem(copy.invalidLink);
      // Identifier and name come from Plane, never from the request; an unchanged link
      // keeps the saved ones, so a Plane outage does not block the GitHub label.
      const same =
        current.plane?.connectionId === wanted.connectionId &&
        current.plane?.planeProjectId === wanted.planeProjectId;
      const found = same
        ? { ...current.plane, id: current.plane.planeProjectId }
        : (await this.planeProjects(wanted.connectionId)).find(
            (item) => item.id === wanted.planeProjectId,
          );
      if (!found) throw problem(copy.invalidLink);
      plane = {
        connectionId: wanted.connectionId,
        planeProjectId: found.id,
        identifier: found.identifier,
        name: found.name || found.identifier,
        inProgressStateId: wanted.inProgressStateId ?? null,
      };
    }
    const github = input.github === undefined ? current.github : input.github;
    if (!plainObject(github)) throw problem(copy.invalidLink);
    this.store.setProjectLink(project.id, project.path, { plane, github });
    ticketsProjectChanged(this.live(), project.id);
    return this.projectView(project.id);
  }

  async listTickets(projectId, { source, label } = {}) {
    if (source !== undefined && source !== "" && !TICKET_SOURCE_IDS.includes(source))
      throw problem(copy.invalidFilter);
    if (
      label !== undefined &&
      (typeof label !== "string" || label.length > 100 || /[\x00-\x1f\x7f]/.test(label))
    )
      throw problem(copy.invalidFilter);
    const project = this.resolveProject(projectId);
    const accesses = await this.accesses(project);
    const wanted = source ? [source] : TICKET_SOURCE_IDS;
    const results = await Promise.all(
      wanted.map(async (id) => {
        const access = accesses[id];
        if (!access) return { source: id, code: "notConnected" };
        try {
          return await this.sources[id].list(access, { label: label || undefined });
        } catch (error) {
          return { source: id, code: failureCode(error) };
        }
      }),
    );
    const tickets = [];
    const labels = new Set();
    const errors = [];
    for (const result of results) {
      if (result.code) {
        errors.push({ source: result.source, code: result.code });
        continue;
      }
      tickets.push(...result.tickets);
      for (const name of result.labels) labels.add(name);
    }
    return { tickets: tickets.sort(byUpdatedDesc), labels: sortNames(labels), errors };
  }

  async start(projectId, input) {
    const checked = startInput(input);
    const project = this.resolveProject(projectId);
    const { link, ...accesses } = await this.accesses(project);
    const access = accesses[checked.source];
    if (!access) throw new TicketSourceError("notConnected");
    const source = this.sources[checked.source];
    // One spelling per issue, so the lock and the start records see the same key.
    const key = canonicalKey(checked.source, checked.key, access);
    const lock = `${project.id}:${checked.source}:${key}`;
    if (this.starting.has(lock)) throw problem(copy.alreadyStarting, 409);
    this.starting.add(lock);
    try {
      if (this.store.findStart(project.id, checked.source, key) && !checked.again)
        throw problem(copy.alreadyStarted, 409);
      const ticket = await source.get(access, key);
      const ref = ticketRef(ticket);
      const result = {};
      if (checked.kind === "session") {
        const given = checked.session.name;
        const name =
          typeof given === "string" && given.trim()
            ? given
            : `${ticket.key} · ${ticket.title.slice(0, 60)}`.slice(0, 100);
        const session = await this.launch(
          { ...checked.session, cwd: project.path, name },
          false,
          {
            ticket: ref,
            validateAccount: (account) => {
              if (!isCodingCli(account.tool)) throw problem(copy.codingCliRequired);
            },
          },
        );
        await this.deliverTask(session, ticket);
        result.session = session;
      } else {
        result.run = await this.pipelines.start(
          {
            ...checked.pipeline,
            cwd: project.path,
            task: ticketTask(ticket, { kind: "pipeline" }),
          },
          { ticket: ref },
        );
      }
      const targetId = result.session?.id ?? result.run?.id;
      let start = this.store.addStart({
        projectId: project.id,
        source: ticket.source,
        key: ticket.key,
        title: ticket.title,
        url: ticket.url,
        kind: checked.kind,
        targetId,
        writeBack: { state: "pending" },
      });
      ticketsProjectChanged(this.live(), project.id);
      start = await this.writeBack(start, { source, access, link, ticket });
      return { start, ...result };
    } finally {
      this.starting.delete(lock);
    }
  }

  /**
   * Sends the task to the new session. A session the task cannot reach is stopped and
   * the start fails without a record, so a retry starts cleanly.
   */
  async deliverTask(session, ticket) {
    let receipt;
    try {
      receipt = await this.chatDelivery.send(session.id, {
        deliveryId: randomUUID(),
        deliveryScope: sessionScope(session),
        text: ticketTask(ticket, { kind: "session" }),
        submit: true,
      });
    } catch (error) {
      await this.stopSession(session.id);
      throw error;
    }
    // Pending and uncertain deliveries may still reach the CLI; rejected ones never do.
    if (!DELIVERING.has(receipt?.status)) {
      await this.stopSession(session.id);
      throw problem(copy.taskNotDelivered, 502);
    }
  }

  async stopSession(id) {
    await Promise.resolve()
      .then(() => this.sessions?.stop(id))
      .catch(() => {});
  }

  /** Marks the ticket in progress; a refusal is recorded, never thrown. */
  async writeBack(start, { source, access, link, ticket }) {
    let writeBack;
    try {
      await source.markInProgress(access, ticket, {
        kind: start.kind,
        label: link.github.inProgressLabel,
      });
      writeBack = { state: "done" };
    } catch (error) {
      const code = failureCode(error);
      // The code alone: no ticket key, URL or token reaches the log.
      console.error(`AgentPier could not update ticket ${start.source}: ${code}`);
      writeBack = { state: "failed", code };
    }
    let saved = start;
    try {
      saved = this.store.patchStart(start.id, { writeBack });
    } catch {
      saved = { ...start, writeBack };
    }
    ticketsProjectChanged(this.live(), start.projectId);
    return saved;
  }

  async planeProjects(connectionId) {
    const { connection: _connection, ...access } = this.connectionAccess(connectionId);
    return this.sources.plane.projects(access);
  }

  async planeStates(connectionId, planeProjectId) {
    if (typeof planeProjectId !== "string" || !UUID.test(planeProjectId))
      throw problem(copy.invalidLink);
    const { connection: _connection, ...access } = this.connectionAccess(connectionId);
    const states = await this.sources.plane.states({
      ...access,
      projectId: planeProjectId,
    });
    return states.map(({ id, name, group }) => ({ id, name, group }));
  }

  connectionsView() {
    return { connections: this.store.listConnections() };
  }

  createConnection(input) {
    const connection = this.store.createConnection(input);
    ticketConnectionsChanged(this.live());
    return connection;
  }

  updateConnection(id, input) {
    const connection = this.store.updateConnection(id, input);
    ticketConnectionsChanged(this.live());
    return connection;
  }

  removeConnection(id) {
    this.store.removeConnection(id);
    ticketConnectionsChanged(this.live());
  }
}

/**
 * The ticket store and service of the application, and the ticket sequences built on
 * them (sequence-service.js); launch, pipelines and the run queue bind late.
 */
export function createTicketServices(services) {
  const { config } = services;
  const ticketStore = new TicketStore({ dataDir: config.dataDir });
  const tickets = new TicketService({
    store: ticketStore,
    memory: services.memory,
    repositories: services.repositories,
    github: services.github,
    gitRemotes: services.gitRemotes,
    launch: (...args) => services.launch(...args),
    chatDelivery: services.chatDelivery,
    sessions: { stop: (...args) => services.sessions.stop(...args) },
    pipelines: { start: (...args) => services.pipelines.start(...args) },
    live: () => services.live,
    fetchImpl: config.ticketFetch ?? globalThis.fetch,
  });
  // The GitHub source of every project view reads the repository credentials.
  services.repositories.onChange = () => services.live?.invalidate("tickets.project");
  return { ticketStore, tickets, ...createTicketSequenceServices(services, { tickets }) };
}
