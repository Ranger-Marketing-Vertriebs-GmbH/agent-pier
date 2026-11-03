import {
  cliDefinition,
  cliName,
  codingCliIds,
} from "../../../server/features/clis/catalog.js";
const docs = {
  codex: "https://learn.chatgpt.com/docs/extend/mcp?surface=cli",
  claude: "https://code.claude.com/docs/en/mcp",
  opencode: "https://opencode.ai/docs/mcp-servers/",
};
export const clients = Object.fromEntries(
  codingCliIds().map((id) => [id, { name: cliName(id), docs: docs[id] }]),
);
export function mcpEndpoint(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.protocol === "https:") return url.href;
    const local = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):([0-9]{1,5})(?=\/|$)/i.exec(
      value,
    );
    if (!local || Number(local[2]) < 1 || Number(local[2]) > 65535) return null;
    return `http://${url.hostname}:${Number(local[2])}${url.pathname}`;
  } catch {
    return null;
  }
}
const shellQuote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
/** `{ steps, removeNote? }` of `cli`'s MCP setup, from its definition. */
export const setupPlan = (cli, endpoint) =>
  cliDefinition(cli).mcpSetup({ endpoint, quoted: shellQuote(endpoint) });
export const setupSteps = (cli, endpoint) => setupPlan(cli, endpoint).steps;
