import { codexBaseEnv, codexPoolRow } from "./model.js";

// Image creation for a Hermes agent (Create images), verified against Hermes v0.22.5.
// Hermes bundles the image backend `openai-codex` (plugins/image_gen/openai-codex/,
// a bundled `backend` plugin, which Hermes loads without `plugins.enabled`,
// hermes_cli/plugins_discovery.py): gpt-image-2 through the Codex backend's own
// `images/generations` and `images/edits` endpoints, the route OpenClaw's
// image_generate takes with a ChatGPT login as well. `image_gen.provider` selects it
// (tools/image_generation_tool.py `_dispatch_to_plugin_provider`), and the
// `image_generate` tool of the `image_gen` toolset offers it once a Codex credential
// resolves (`check_image_generation_requirements`, the provider's `is_available`).
//
// The credential is the one Hermes resolves for every Codex call
// (agent/auxiliary_client.py `_resolve_codex_credential_and_base`): the
// `openai-codex` pool row of auth.json, sent to HERMES_CODEX_BASE_URL. AgentPier
// writes the same row and URL as for a ChatGPT model (model.js): the request reaches
// AgentPier's runtime proxy (model-logins/chatgpt-proxy.js), which holds the login's
// tokens, and the home holds only the proxy's credential for this agent and login.
// An agent that chats with a ChatGPT login AgentPier holds creates images with that
// login's row; any other agent gets a row of its own for the image login AgentPier
// chose (model-accounts.js heldImageLogin). openai-codex is no step of Hermes's
// auxiliary chain (`_get_provider_chain`), so the row never carries the agent's own
// model or auxiliary calls. A login OpenClaw still holds never reaches Hermes.
//
// Every call passes the team plugin's guard first (team-plugin.js `images`,
// hermes-tool-guard.js imageGuard), so images need the team bridge: `guarded`.

/** The image section of the home: config, and the row and URL without a ChatGPT model. */
export function imageHome(agent, { model, modelProxy, imageLogin, guarded }) {
  if (!agent.web.createImages) return null;
  if (!guarded || !modelProxy?.url || !imageLogin) return { unsupported: true };
  const config = [[["image_gen", "provider"], "openai-codex"]];
  // The agent's ChatGPT model already routes Codex calls through the proxy.
  if (model?.auth) return { config };
  const credential = modelProxy.credentialFor?.(imageLogin);
  if (!credential) return { unsupported: true };
  const baseUrl = `${modelProxy.url}/chatgpt/codex`;
  return {
    config,
    env: { [codexBaseEnv]: baseUrl },
    auth: codexPoolRow(baseUrl, credential),
  };
}
