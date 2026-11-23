// The search's entries for the owner's own things (AGENTPIER-224): sessions, projects,
// agent chats, pipeline runs and definitions, inbox items, and the actions New run and
// Open inbox, CLI accounts, task profiles, saved views and each session's own actions.
// Every source is data the owner's app already reads under the owner's session (the
// workspace state, the agent list, the pushed run list and inbox, the project, pipeline
// and task profile lists, the saved views), so the search shows nothing the owner's
// pages would not.
import { sidebarCopy } from "../../lib/i18n/messages/app.js";
import { assistantCopy } from "../../lib/i18n/messages/assistants.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { inboxCopy } from "../../lib/i18n/messages/inbox.js";
import { pipelineCopy } from "../../lib/i18n/messages/pipelines.js";
import { searchCopy } from "../../lib/i18n/messages/search.js";
import { bilingual, join, withTerms } from "../../app/search-entries.js";
import { cliAccountWords, projectTabLabels } from "../../app/area-search-entries.js";
import { codingPageCopy } from "../../lib/i18n/messages/coding.js";
import { viewsCopy } from "../../lib/i18n/messages/views.js";
import { codingRoute } from "../coding/routes.js";
import { sessionActionEntries } from "./session-action-entries.js";
import { chatTitle, ownerChatFilter } from "../assistants/chats/chat-names.js";
import { itemTitle, kindLabel } from "../inbox/inbox-presentation.js";
import { runStatusLabel } from "../pipelines/run-codes.js";
import { runTitle } from "../pipelines/run-title.js";
import { projectsRoute } from "../projects/routes.js";
import { listedProjects } from "../../lib/project-list.js";
import { talkEligibleSession } from "../session-talk/talk-eligible.js";

const same = (text) => ({ de: String(text ?? ""), en: String(text ?? "") });
const folder = (cwd) => (cwd ? cwd.split("/").filter(Boolean).at(-1) || cwd : "");
const parts = (...values) => values.filter(Boolean).join(" · ");

function entry(group, id, label, path, target, options = {}) {
  return { id, group, label, path, target, aliases: [], ...options };
}

/**
 * Sessions as the sidebar lists them (a stopped headless pipeline session stays out),
 * found by name, project, CLI and account, opened in their last view.
 */
export function sessionEntries({ sessions = [], accounts = [], tools = [] } = {}) {
  const root = bilingual(() => commonCopy.sessions);
  const toolName = new Map(tools.map((tool) => [tool.id, tool.name]));
  const accountName = new Map(accounts.map((account) => [account.id, account.name]));
  return sessions
    .filter((session) => session?.id && session.name)
    .filter((session) => !(session.pipeline?.headless && session.status === "stopped"))
    .map((session) => {
      const project = session.repositoryName || folder(session.cwd);
      const cli = toolName.get(session.tool) || session.tool || "";
      const account = accountName.get(session.accountId) || "";
      return entry(
        "sessions",
        `session:${session.id}`,
        same(session.name),
        project ? join(root, same(project)) : root,
        { session: session.id },
        {
          meta: same(parts(cli, account)),
          icon: "terminal",
          extra: [project, session.cwd, cli, session.tool, account].filter(Boolean),
        },
      );
    });
}

/**
 * "<session> · Agent access" for every running coding session that may talk to
 * agents: it opens the session and its Agent access dialog (page action
 * `session-agent-access:<id>`, useSessionActions.jsx), so only that session's hook
 * takes it, also when it mounts after the navigation.
 */
export function sessionAgentAccessEntries({ sessions = [] } = {}) {
  const root = bilingual(() => commonCopy.sessions);
  const label = bilingual(() => searchCopy.actions.agentAccess);
  return sessions
    .filter((session) => session?.id && session.name && talkEligibleSession(session))
    .map((session) => {
      const project = session.repositoryName || folder(session.cwd);
      return entry(
        "actions",
        `session:${session.id}:agent-access`,
        { de: `${session.name} · ${label.de}`, en: `${session.name} · ${label.en}` },
        project ? join(root, same(project)) : root,
        { session: session.id, pending: `session-agent-access:${session.id}` },
        { icon: "talk", extra: [project, session.tool].filter(Boolean) },
      );
    });
}

/**
 * Projects from the project list (one row per folder, as the projects page shows
 * them) and cloned repositories not known there yet, found by name and folder.
 */
export function projectEntries({ projects = [], repositories = [] } = {}) {
  const root = bilingual(() => sidebarCopy.projectsNavigation);
  const seen = new Set();
  const entries = [];
  const add = (id, name, path) => {
    if (!id || !name || seen.has(path || id)) return;
    seen.add(path || id);
    entries.push(
      entry(
        "projects",
        `project:${id}`,
        same(name),
        root,
        {
          route: projectsRoute({ projectId: id }),
        },
        { meta: same(path), icon: "folder", extra: [path].filter(Boolean) },
      ),
    );
    entries.push(
      entry(
        "projects",
        `project-tickets:${id}`,
        bilingual(() => searchCopy.projectTickets),
        join(root, same(name)),
        { route: projectsRoute({ projectId: id, projectTab: "tickets" }) },
        {
          meta: same(path),
          icon: "folder",
          extra: [name, path, "GitHub", "Plane", "Issues"].filter(Boolean),
        },
      ),
    );
    // "alpha Knowledge": the project's other tabs (Tickets has its own entry above).
    for (const tab of Object.keys(projectTabLabels).filter((key) => key !== "tickets"))
      entries.push(
        entry(
          "projects",
          `project-${tab}:${id}`,
          bilingual(projectTabLabels[tab]),
          join(root, same(name)),
          { route: projectsRoute({ projectId: id, projectTab: tab }) },
          { meta: same(path), icon: "folder", extra: [name, path].filter(Boolean) },
        ),
      );
  };
  for (const project of listedProjects(projects))
    add(project.id, project.name || folder(project.cwd), project.cwd || "");
  for (const repository of repositories)
    add(repository.id, repository.name, repository.path || "");
  return entries;
}

/**
 * The owner's chats with agents, as the agent's chat list shows them: not archived,
 * not on an archived agent or a team member, and on a shared agent only the owner's own.
 */
export function chatEntries({ agents = [], conversations = [] } = {}) {
  const root = bilingual(() => assistantCopy.title);
  const byId = new Map(
    agents
      .filter((agent) => agent?.id && !agent.archivedAt && !agent.teamMemberId)
      .map((agent) => [agent.id, agent]),
  );
  return conversations
    .filter((chat) => chat?.id && !chat.archivedAt && byId.has(chat.assistantId))
    .filter((chat) => {
      const filter = ownerChatFilter(byId.get(chat.assistantId));
      return !filter || filter(chat);
    })
    .map((chat) => {
      const agent = byId.get(chat.assistantId);
      return entry(
        "chats",
        `chat:${chat.id}`,
        bilingual(() => chatTitle(chat)),
        join(root, same(agent.name)),
        { route: { view: "agents", assistantId: agent.id, conversationId: chat.id } },
        { mark: agent.name, extra: [agent.name], agentsOnly: true },
      );
    });
}

/** Recent runs and active sidebar runs beyond the first page, once per id. */
export function runEntries(recent = [], active = []) {
  const root = join(
    bilingual(() => pipelineCopy.title),
    bilingual(() => pipelineCopy.runs),
  );
  const runs = new Map(
    [...recent, ...active].filter((run) => run?.id).map((run) => [run.id, run]),
  );
  return [...runs.values()].map((run) =>
    entry(
      "runs",
      `run:${run.id}`,
      same(runTitle(run) || run.id),
      run.pipelineName ? join(root, same(run.pipelineName)) : root,
      { route: { view: "pipelines", pipelineTab: "runs", pipelineItem: run.id } },
      {
        meta: bilingual(() => runStatusLabel(run.status)),
        icon: "refresh",
        extra: [run.pipelineName, run.projectName, run.id].filter(Boolean),
      },
    ),
  );
}

/** Pipeline definitions, opened in the definition editor. */
export function pipelineEntries(pipelines = []) {
  const root = join(
    bilingual(() => pipelineCopy.title),
    bilingual(() => pipelineCopy.definitions),
  );
  return pipelines
    .filter((pipeline) => pipeline?.id && pipeline.name)
    .map((pipeline) =>
      entry(
        "runs",
        `pipeline:${pipeline.id}`,
        same(pipeline.name),
        root,
        {
          route: {
            view: "pipelines",
            pipelineTab: "definitions",
            pipelineItem: pipeline.id,
          },
        },
        { icon: "grid" },
      ),
    );
}

/** Task profiles by name, opened in the profile editor. */
export function profileEntries(profiles = []) {
  const root = join(
    bilingual(() => pipelineCopy.title),
    bilingual(() => pipelineCopy.profiles),
  );
  return profiles
    .filter((profile) => profile?.id && profile.name)
    .map((profile) =>
      entry(
        "runs",
        `profile:${profile.id}`,
        same(profile.name),
        root,
        {
          route: { view: "pipelines", pipelineTab: "profiles", pipelineItem: profile.id },
        },
        { icon: "grid" },
      ),
    );
}

/** Native CLI accounts by name ("Konten", "Claude-Login"), opened under CLIs › Accounts. */
export function cliAccountEntries({ accounts = [], tools = [] } = {}) {
  const root = join(
    bilingual(() => codingPageCopy.title),
    bilingual(() => codingPageCopy.tabs.accounts),
  );
  const toolName = new Map(tools.map((tool) => [tool.id, tool.name]));
  return accounts
    .filter((account) => account?.id && account.name && account.tool !== "shell")
    .map((account) =>
      entry(
        "pages",
        `cli-account:${account.id}`,
        same(account.name),
        root,
        { route: codingRoute("accounts", { item: account.id }) },
        {
          meta: same(toolName.get(account.tool) || account.tool),
          extra: [toolName.get(account.tool), account.tool, ...cliAccountWords].filter(
            Boolean,
          ),
        },
      ),
    );
}

/** The saved views by name (split views at /views/:id). */
export function viewEntries(views = []) {
  const root = bilingual(() => viewsCopy.group);
  return views
    .filter((view) => view?.id && view.name)
    .map((view) =>
      entry("pages", `view:${view.id}`, same(view.name), root, {
        route: { view: "split", viewId: view.id },
      }),
    );
}

/** What waits in the inbox, opened at the item's own address. */
export function inboxEntries(items = []) {
  const root = bilingual(() => inboxCopy.title);
  return items
    .filter((item) => item?.type && item.id)
    .map((item) =>
      entry(
        "inbox",
        `inbox:${item.type}:${item.id}`,
        bilingual(() => itemTitle(item)),
        root,
        {
          route: {
            view: "inbox",
            inboxTab: "all",
            itemType: item.type,
            itemId: item.id,
          },
        },
        {
          meta: bilingual(() => parts(kindLabel(item), item.source?.name)),
          icon: "inbox",
          extra: [item.source?.name, item.source?.project].filter(Boolean),
        },
      ),
    );
}

/** The actions New run and Open inbox (New session is with the other actions). */
export function workspaceActions() {
  const action = (id, label, path, target) =>
    entry("actions", `action:${id}`, bilingual(label), path, target, {
      suggested: true,
      primary: true,
    });
  return [
    action(
      "new-run",
      () => pipelineCopy.newRun,
      bilingual(() => pipelineCopy.title),
      { route: { view: "pipelines", pipelineTab: "runs", pipelineItem: "new" } },
    ),
    action(
      "open-inbox",
      () => searchCopy.actions.openInbox,
      bilingual(() => inboxCopy.title),
      {
        route: { view: "inbox", inboxTab: "all", itemType: "", itemId: "" },
      },
    ),
  ];
}

// All of an entry's words read as one, so a query may mix them: "Scout Reiseplanung"
// (agent and chat), "billing claude" (project and CLI of a session).
const allWords = (item) =>
  ["de", "en"].map((language) =>
    [
      item.path[language],
      item.label[language],
      item.meta?.[language],
      ...(item.extra || []),
    ]
      .filter(Boolean)
      .join(" "),
  );

/**
 * The owner's entries with their terms. `sources` holds what is loaded so far; a
 * source not loaded yet (null) adds nothing. Chats need agents on.
 */
export function workspaceEntries(sources = {}, { agentsEnabled = false } = {}) {
  return [
    ...sessionEntries(sources.workspace || {}),
    ...projectEntries(sources),
    ...(agentsEnabled ? chatEntries(sources) : []),
    ...(agentsEnabled ? sessionAgentAccessEntries(sources.workspace || {}) : []),
    ...sessionActionEntries(sources.workspace || {}),
    ...cliAccountEntries(sources.workspace || {}),
    ...runEntries(sources.runs, sources.activeRuns),
    ...pipelineEntries(sources.pipelines || []),
    ...profileEntries(sources.profiles || []),
    ...viewEntries(sources.views || []),
    ...inboxEntries(sources.inbox || []),
    ...workspaceActions(),
  ].map((item) =>
    withTerms({ ...item, extra: [...(item.extra || []), ...allWords(item)] }),
  );
}
