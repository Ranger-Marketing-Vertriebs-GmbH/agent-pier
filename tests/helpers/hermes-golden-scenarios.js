import {
  desiredAgent,
  desiredState,
} from "../../server/features/assistants/agent-desired-state.js";
import { hermesAdvancedRuntime } from "../../server/features/assistants/runtimes/hermes/hermes-config/advanced.js";

// Representative Hermes homes for the golden compile test
// (tests/unit/hermes-config-golden.test.js) and the config-check contract
// (tests/integration/hermes-config-check-contract.test.js). Each scenario is one
// agent's stored record, the model connection and instructions a live apply reads
// (assistant-config.js), and the start's own facts. The expected files are in
// tests/fixtures/hermes-golden/<name>.txt (goldenText).

export const goldenWorkspace = "/golden/assistants/workspaces/ap-a1";

const agent = (extra = {}) => ({
  id: "a1",
  name: "Agent a1",
  runtimeAgentId: "ap-a1",
  revision: 1,
  ...extra,
});
const instructions = "# Agent a1\n\nYou help the owner with their work.\n";
const model = (provider) => ({
  ref: `ap-c1/${provider.models[0].id}`,
  providerId: "ap-c1",
  provider,
  agentRuntime: undefined,
});
// The connection kinds assistant-models.js resolves: a custom OpenAI-compatible
// endpoint (Bearer, a raw Authorization header, an Azure-style api-key header or a
// local server without a key), OpenRouter, and a ChatGPT account (no provider).
const endpoint = (extra = {}) =>
  model({
    baseUrl: "https://llm.example.test/v1",
    api: "openai-completions",
    apiKey: "sk-golden-endpoint",
    models: [
      { id: "golden-1", name: "Golden 1", contextWindow: 128000, maxTokens: 8192 },
    ],
    ...extra,
  });
const models = {
  bearer: endpoint(),
  azure: endpoint({
    baseUrl: "https://golden.openai.azure.test/openai/v1",
    authHeader: false,
    headers: { authorization: "", "api-key": "sk-golden-endpoint" },
  }),
  local: model({
    baseUrl: "http://127.0.0.1:11434/v1",
    api: "openai-completions",
    models: [{ id: "llama3.2", name: "llama3.2", contextWindow: 32768, maxTokens: 4096 }],
  }),
  openRouter: model({
    baseUrl: "https://openrouter.ai/api/v1",
    api: "openai-completions",
    apiKey: "sk-or-golden",
    models: [{ id: "anthropic/claude-x", name: "Claude X", input: ["text", "image"] }],
  }),
  account: {
    ref: "openai/gpt-x@golden-profile",
    agentRuntime: { model: "openai/gpt-x", id: "openclaw" },
  },
};

export const hermesGoldenScenarios = {
  // An agent that switched nothing on, read at a start (no model, no instructions).
  "no-tools": () => ({ profile: agent({ capabilities: {} }) }),
  // Shell on approval with memory and web search: Hermes asks for dangerous commands.
  "shell-approval": () => ({
    profile: agent({
      shell: "approval",
      capabilities: { memory: true, webSearch: true, webFetch: true },
    }),
    model: models.bearer,
    instructions,
    workspace: goldenWorkspace,
    // The owner's Brave key: Hermes's brave-free backend, AgentPier's web fetch.
    web: { search: { provider: "brave", key: "golden-brave-key" }, ddgs: false },
  }),
  // The stricter option: the guard plugin asks before every command.
  "every-command": () => ({
    profile: agent({ shell: "approval", capabilities: { memory: true } }),
    model: models.local,
    instructions,
    workspace: goldenWorkspace,
    strict: ["ap-a1"],
  }),
  // Full shell access: Hermes runs every command without asking.
  full: () => ({
    profile: agent({
      shell: "full",
      capabilities: { memory: true, documents: true, createImages: true },
    }),
    model: models.openRouter,
    instructions,
    workspace: goldenWorkspace,
  }),
  // An endpoint that takes its key in an api-key header.
  "model-azure": () => ({
    profile: agent({ capabilities: { memory: true } }),
    model: models.azure,
    instructions,
  }),
  // A ChatGPT account, which Hermes cannot use: the model section is removed.
  "model-account": () => ({
    profile: agent({ capabilities: { memory: true } }),
    model: models.account,
    instructions,
  }),
  // Skills: the bundled ones switched on stay, the others are switched off (the
  // essential one never), a catalog skill comes from its folder, a name Hermes
  // neither bundles nor finds in the catalog is named.
  skills: () => ({
    profile: agent({
      shell: "approval",
      capabilities: { memory: true },
      skills: ["github", "quartz-notes", "weather"],
    }),
    model: models.bearer,
    instructions,
    bundledSkills: ["github", "hermes-agent", "pdf"],
    catalogSkills: {
      "quartz-notes": "/golden/skill-catalog/skills/quartz-notes",
      unassigned: "/golden/skill-catalog/skills/unassigned",
    },
  }),
  // MCP servers bound to the agent: secrets only as .env references, a placeholder
  // resolved to its work folder, an OAuth server left out and named.
  mcp: () => ({
    profile: agent({ capabilities: { memory: true } }),
    model: models.bearer,
    instructions,
    workspace: goldenWorkspace,
    mcp: {
      servers: [
        {
          id: "s1",
          name: "files",
          transport: "stdio",
          command: "/usr/local/bin/files-mcp",
          args: ["--root={agent.workspace}/notes", "--fast"],
          toolTimeoutSec: 120,
        },
        {
          id: "s2",
          name: "tracker",
          transport: "http",
          url: "https://mcp.example.test/mcp?team=golden",
          startupTimeoutSec: 30,
        },
        { id: "s3", name: "events", transport: "sse", url: "https://sse.example.test/" },
        {
          id: "s4",
          name: "linear",
          transport: "http",
          url: "https://l.test",
          auth: "oauth",
        },
        { id: "s5", name: "unbound", transport: "http", url: "https://u.test" },
      ],
      bindings: { a1: ["s1", "s2", "s3", "s4"] },
      secrets: {
        s1: { env: { FILES_TOKEN: "golden-files-token" }, headers: {} },
        s2: { env: {}, headers: { Authorization: "Bearer golden-tracker" } },
        s3: { env: {}, headers: {} },
      },
      redirectUrl: null,
    },
  }),
  // The agent's own Telegram bot for other people with Deepgram voice (AGENTPIER-341):
  // Hermes's Telegram adapter, the access rules, the sender lock and the plugin.
  "telegram-bot": () => ({
    profile: agent({ capabilities: { memory: true } }),
    model: models.bearer,
    instructions,
    channelBot: {
      token: "123456:golden-bot-token",
      tokenRevision: 1,
      people: ["1001", "1002"],
      speech: { apiKey: "dg-golden-key", model: "nova-3", language: "de" },
    },
  }),
  // Subagents stay on with their defaults; wishes Hermes cannot serve yet are named.
  "subagents-default": () => ({
    profile: agent({
      capabilities: { memory: true, browser: true, reminders: true, readPdfs: true },
      skills: ["weather"],
    }),
    model: models.bearer,
    instructions,
  }),
  // The owner's advanced settings for all agents that Hermes takes (advanced.js):
  // the thinking level as reasoning effort ("off" is "none") and the clock's zone.
  // Settings Hermes has no equivalent of (the time limit) write nothing.
  advanced: () => ({
    profile: agent({ capabilities: { memory: true } }),
    model: models.bearer,
    instructions,
    advanced: {
      version: hermesAdvancedRuntime,
      values: { thinkingDefault: "off", userTimezone: "Europe/Berlin", runTimeout: 900 },
    },
  }),
  // A lead with the team bridge: AgentPier's team tools and guard as a Hermes plugin.
  "team-lead": () => ({
    profile: agent({ capabilities: { memory: true } }),
    model: models.bearer,
    instructions,
    connection: bridgeConnection,
  }),
  // A permanent team member: its own tools, and the guard asks before its file changes.
  "team-member": () => ({
    profile: agent({
      capabilities: { memory: true },
      teamMemberId: "a1",
      teamId: "t1",
      parentAssistantId: "lead",
      lifetime: "permanent",
    }),
    model: models.bearer,
    instructions,
    connection: bridgeConnection,
  }),
};

// The team bridge a start names (team-bridge.js), with a fixed token.
const bridgeConnection = { url: "http://127.0.0.1:43210", token: "golden-bridge-token" };

/** What hermesCompiler.compile takes for a scenario (`homes`: files found there). */
export function goldenCompileInput(scenario, homes = {}) {
  const { profile, model: connection, instructions: text, workspace, strict } = scenario;
  const { bundledSkills, catalogSkills, mcp, channelBot, web, advanced } = scenario;
  const servers = mcp?.bindings[profile.id] || [];
  const bridge = scenario.connection;
  const live =
    connection || text !== undefined
      ? [
          desiredAgent(profile, {
            model: connection,
            instructions: text,
            mcp: servers,
            channelBot,
          }),
        ]
      : [];
  return {
    desired: desiredState({
      profiles: [profile],
      mcp,
      ...(bridge && { directory: "/golden/team-plugin", connection: bridge }),
    }),
    agents: live,
    workspaces: workspace ? { [profile.runtimeAgentId]: workspace } : {},
    homes: Object.keys(homes).length ? { [profile.runtimeAgentId]: homes } : {},
    strictShell: strict || [],
    bundledSkills,
    catalogSkills,
    web,
    advanced,
  };
}

const noNewline = "\\ No newline at end of file\n";

/**
 * A compiled home as one text: each file under a `==> path <==` line (a file without
 * a final newline marked as diff marks it), then the paths it removes and what it
 * cannot serve yet.
 */
export function goldenText(home) {
  const block = (name, text) =>
    `==> ${name} <==\n${text}${text === "" || text.endsWith("\n") ? "" : `\n${noNewline}`}`;
  return [
    ...Object.keys(home.files)
      .sort()
      .map((file) => block(file, home.files[file])),
    block("(remove)", home.remove.map((p) => `${p}\n`).join("")),
    block("(unsupported)", home.unsupported.map((p) => `${p}\n`).join("")),
  ].join("");
}
