import {
  desiredAgent,
  desiredState,
} from "../../server/features/assistants/agent-desired-state.js";

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
  // Subagents stay on with their defaults; wishes Hermes cannot serve yet are named.
  "subagents-default": () => ({
    profile: agent({
      capabilities: { memory: true, browser: true, reminders: true, readPdfs: true },
      skills: ["weather"],
    }),
    model: models.bearer,
    instructions,
  }),
};

/** What hermesCompiler.compile takes for a scenario (`homes`: files found there). */
export function goldenCompileInput(scenario, homes = {}) {
  const { profile, model: connection, instructions: text, workspace, strict } = scenario;
  const live =
    connection || text !== undefined
      ? [desiredAgent(profile, { model: connection, instructions: text })]
      : [];
  return {
    desired: desiredState({ profiles: [profile] }),
    agents: live,
    workspaces: workspace ? { [profile.runtimeAgentId]: workspace } : {},
    homes: Object.keys(homes).length ? { [profile.runtimeAgentId]: homes } : {},
    strictShell: strict || [],
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
