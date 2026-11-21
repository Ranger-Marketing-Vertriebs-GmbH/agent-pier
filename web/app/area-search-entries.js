// ⌘K entries for the tabs and groups inside the areas (AGENTPIER-418): the project
// tabs, Artifacts › Pinned, the groups of Agents › Runtime › Advanced, Settings ›
// Remote access and App & notifications, Files › Trash, Pipelines, Craft Anything, the
// start page's System status and the CLI accounts; and the actions that go with them
// (among them Upload, Send test notification and Install app).
import { agentGroupsCopy } from "../lib/i18n/messages/agent-groups.js";
import { agentSkillCatalogCopy } from "../lib/i18n/messages/agent-skill-catalog.js";
import { agentsHubCopy } from "../lib/i18n/messages/agents-hub.js";
import { artifactCopy } from "../lib/i18n/messages/artifacts.js";
import { assistantAdvancedCopy } from "../lib/i18n/messages/assistant-advanced.js";
import { assistantCopy } from "../lib/i18n/messages/assistants.js";
import { projectAgentBusCopy } from "../lib/i18n/messages/agentbus.js";
import { codingPageCopy } from "../lib/i18n/messages/coding.js";
import { commonCopy } from "../lib/i18n/messages/common.js";
import { connectionsAreaCopy } from "../lib/i18n/messages/connections-area.js";
import { craftCopy } from "../lib/i18n/messages/craft.js";
import { explorerLayoutCopy } from "../lib/i18n/messages/explorer-layout.js";
import { filesCopy } from "../lib/i18n/messages/files.js";
import { loginCopy } from "../lib/i18n/messages/login.js";
import { mailCopy } from "../lib/i18n/messages/mail.js";
import { notificationCopy } from "../lib/i18n/messages/notifications.js";
import { operationsCopy } from "../lib/i18n/messages/operations.js";
import { pipelineCopy } from "../lib/i18n/messages/pipelines.js";
import { pipelineQueueCopy } from "../lib/i18n/messages/pipeline-queue.js";
import { previewCopy } from "../lib/i18n/messages/previews.js";
import { projectAgentsCopy } from "../lib/i18n/messages/project-agents.js";
import { projectApprovalsCopy, projectsHubCopy } from "../lib/i18n/messages/projects.js";
import { remoteCopy } from "../lib/i18n/messages/remote.js";
import { systemStatusCopy } from "../lib/i18n/messages/system-status.js";
import { toolInstallerCopy } from "../lib/i18n/messages/tools.js";
import { viewsCopy } from "../lib/i18n/messages/views.js";
import { names } from "../lib/providers.js";
import { artifactsRoute } from "../features/artifacts/routes.js";
import { agentsHubRoute } from "../features/assistants/hub-routes.js";
import { codingRoute } from "../features/coding/routes.js";
import { connectionsRoute } from "../features/connections/routes.js";
import { projectsRoute } from "../features/projects/routes.js";
import {
  alias,
  bilingual,
  join,
  pageEntry,
  pipelinesRoute,
  settingsRoute,
  text,
} from "./search-labels.js";

/** A project tab's label, by its route tab (projects/routes.js), as ProjectDetail shows. */
export const projectTabLabels = {
  knowledge: () => projectsHubCopy.tabKnowledge,
  agentbus: () => projectsHubCopy.tabAgentBus,
  runs: () => projectsHubCopy.tabRuns,
  tickets: () => projectsHubCopy.tabTickets,
  agents: () => projectAgentsCopy.tab,
  approvals: () => projectApprovalsCopy.tab,
};
// Old or other names of a project tab.
const projectTabAliases = { knowledge: [alias("memory")] };

/**
 * Words people type for the CLI accounts that the catalogs do not show ("Konten" is
 * no UI term, see the glossary, but people search for it): the tab and each account
 * carry them as extra words.
 */
export const cliAccountWords = [
  "Konten",
  "Konto",
  "Login",
  "Claude-Login",
  "Codex-Login",
];

/** The pages inside the areas; `agentsOnly` ones need the agent feature. */
export function areaPageEntries() {
  const projects = [bilingual(text.projects)];
  const agents = [bilingual(text.agents)];
  const advanced = [
    ...agents,
    bilingual(() => agentsHubCopy.tabs.runtime),
    bilingual(() => agentsHubCopy.runtime.advanced),
  ];
  const settings = [bilingual(text.settings)];
  const remote = [...settings, bilingual(() => operationsCopy.groups.remote)];
  const app = [...settings, bilingual(() => operationsCopy.groups.app)];
  const pipelines = [bilingual(text.pipelines)];
  const craft = [bilingual(text.craft)];
  const models = [
    bilingual(text.connections),
    bilingual(() => connectionsAreaCopy.sections.models),
  ];
  return [
    ...Object.keys(projectTabLabels).map((tab) =>
      pageEntry(
        `projects-${tab}`,
        projectTabLabels[tab],
        projects,
        { route: projectsRoute({ projectTab: tab }) },
        { aliases: projectTabAliases[tab] },
      ),
    ),
    pageEntry(
      "projects-agentbus-messages",
      () => projectAgentBusCopy.messagesLabel,
      [...projects, bilingual(projectTabLabels.agentbus)],
      { route: projectsRoute({ projectTab: "agentbus", busTab: "messages" }) },
    ),
    pageEntry(
      "artifacts-pinned",
      () => artifactCopy.tabs.pinned,
      [bilingual(text.artifacts)],
      { route: artifactsRoute({ artifactTab: "pinned" }) },
    ),
    pageEntry(
      "agents-groups",
      () => agentGroupsCopy.title,
      [...agents, bilingual(() => agentsHubCopy.tabs.all)],
      { route: agentsHubRoute() },
      { agentsOnly: true },
    ),
    ...["runs", "media"].map((group) =>
      pageEntry(
        `runtime-advanced-${group}`,
        () => assistantAdvancedCopy.groups[group],
        advanced,
        { route: agentsHubRoute("runtime", "advanced") },
        { agentsOnly: true },
      ),
    ),
    ...["local", "tailscale", "network", "hosts"].map((group) =>
      pageEntry(`settings-remote-${group}`, () => remoteCopy[group], remote, {
        route: settingsRoute("remote"),
      }),
    ),
    pageEntry("settings-remote-previews", () => previewCopy.title, remote, {
      route: settingsRoute("remote"),
    }),
    ...[
      "installTitle",
      "pushTitle",
      "devices",
      "levelGroup",
      "behaviourGroup",
      "quietHours",
    ].map((group) =>
      pageEntry(`settings-app-${group}`, () => notificationCopy[group], app, {
        route: settingsRoute("notifications"),
      }),
    ),
    // Files › Trash: the explorer's second view (?panel=trash).
    pageEntry(
      "files-trash",
      () => filesCopy.actions.trashTitle,
      [bilingual(text.files)],
      {
        route: { view: "files", filePanel: "trash" },
      },
    ),
    pageEntry(
      "pipelines-risk-rules",
      () => pipelineCopy.riskRules,
      [...pipelines, bilingual(() => pipelineCopy.verification)],
      { route: pipelinesRoute("verification") },
    ),
    pageEntry(
      "pipelines-concurrent-runs",
      () => pipelineQueueCopy.settingsHeading,
      [...pipelines, bilingual(() => pipelineQueueCopy.tab)],
      { route: pipelinesRoute("queue") },
    ),
    pageEntry("craft-rebuilds", () => craftCopy.list.title, craft, {
      route: { view: "craft", rebuildId: "" },
    }),
    pageEntry("craft-defaults", () => craftCopy.defaults.title, craft, {
      route: { view: "craft", rebuildId: "" },
    }),
    // The start page's tile opens its details (DashboardPage takes the request).
    pageEntry(
      "overview-system-status",
      () => systemStatusCopy.title,
      [bilingual(text.overview)],
      {
        route: { view: "workspace", sessionId: "" },
        pending: "system-status",
      },
    ),
    pageEntry(
      "connections-chatgpt",
      () => assistantCopy.accountsTitle,
      models,
      { route: connectionsRoute("models") },
      { agentsOnly: true },
    ),
  ];
}

/**
 * The actions: Add email account, New view (offered while the sidebar's Views group
 * shows), Install skill, Update CLI, Chrome for Testing, Upload (Files), Send test
 * notification, Install app and Sign out (offered while someone is signed in). `action` is search-entries.js' action builder.
 */
export function areaActionEntries(action) {
  const clis = bilingual(text.clis);
  const install = join(
    clis,
    bilingual(() => codingPageCopy.tabs.install),
  );
  return [
    action(
      "add-mail",
      () => mailCopy.add,
      join(
        bilingual(text.connections),
        bilingual(() => connectionsAreaCopy.sections.mail),
      ),
      { route: connectionsRoute("mail"), pending: "mail-add" },
      { aliases: [alias("addMailAccount")].map(bilingual) },
    ),
    action(
      "new-view",
      () => viewsCopy.newView,
      bilingual(() => viewsCopy.group),
      { action: "view-new", pending: "view-new" },
      { offer: "view-new" },
    ),
    action(
      "install-skill",
      () => commonCopy.installSkill,
      join(
        clis,
        bilingual(() => codingPageCopy.tabs.extensions),
      ),
      { extensions: "skills" },
      { suggested: false },
    ),
    action(
      "install-agent-skill",
      () => agentSkillCatalogCopy.install,
      join(
        bilingual(text.agents),
        bilingual(() => agentsHubCopy.tabs.skills),
      ),
      { route: agentsHubRoute("skills") },
      { suggested: false, agentsOnly: true },
    ),
    action(
      "update-cli",
      () => toolInstallerCopy.updateCli,
      install,
      { route: codingRoute("install") },
      { suggested: false },
    ),
    action(
      "chrome-for-testing",
      () => names.chromium,
      install,
      { route: codingRoute("install") },
      { suggested: false },
    ),
    // Files › Upload opens the explorer's upload panel (ExplorerWorkspace takes it).
    action(
      "files-upload",
      () => explorerLayoutCopy.upload,
      bilingual(text.files),
      { route: { view: "files" }, pending: "files-upload" },
      { suggested: false },
    ),
    ...[
      ["notification-test", () => notificationCopy.test],
      ["install-app", () => notificationCopy.install],
    ].map(([id, label]) =>
      action(
        id,
        label,
        join(
          bilingual(text.settings),
          bilingual(() => operationsCopy.groups.app),
        ),
        { route: settingsRoute("notifications") },
        { suggested: false },
      ),
    ),
    action(
      "sign-out",
      () => loginCopy.logout,
      bilingual(text.menu),
      { action: "sign-out" },
      { offer: "sign-out", suggested: false },
    ),
  ];
}
