export const clients = {
  codex: { name: "Codex", docs: "https://learn.chatgpt.com/docs/extend/mcp?surface=cli" },
  claude: { name: "Claude Code", docs: "https://code.claude.com/docs/en/mcp" },
  opencode: { name: "OpenCode", docs: "https://opencode.ai/docs/mcp-servers/" },
};
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
export function setupSteps(cli, endpoint) {
  const url = shellQuote(endpoint);
  if (cli === "claude")
    return [
      ["add", `claude mcp add --transport http --scope user agentpier ${url}`],
      ["login", "/mcp"],
      ["check", "claude mcp get agentpier\nclaude mcp list"],
      ["remove", "claude mcp remove --scope user agentpier"],
    ];
  if (cli === "opencode")
    return [
      [
        "add",
        JSON.stringify(
          {
            $schema: "https://opencode.ai/config.json",
            mcp: { agentpier: { type: "remote", url: endpoint, enabled: true } },
          },
          null,
          2,
        ),
      ],
      ["login", "opencode mcp auth agentpier"],
      ["check", "opencode mcp list\nopencode mcp debug agentpier"],
      ["remove", "opencode mcp logout agentpier"],
    ];
  return [
    ["add", `codex mcp add agentpier --url ${url}`],
    ["login", "codex mcp login agentpier --oauth-client-registration dcr"],
    ["check", "codex mcp get agentpier\ncodex mcp list"],
    ["remove", "codex mcp logout agentpier\ncodex mcp remove agentpier"],
  ];
}
