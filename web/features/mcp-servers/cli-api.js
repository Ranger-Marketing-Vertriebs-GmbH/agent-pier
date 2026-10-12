import api from "../../lib/api.js";

const id = (value) => encodeURIComponent(value);
const confirm = (confirmStdio) => (confirmStdio ? { confirmStdio: true } : {});

/** Central MCP servers in the coding CLIs (server/http/routes/mcp-cli.js). */
export const cliApi = {
  resolve: (serverId, cli, choice, confirmStdio = false) =>
    api(`/mcp-servers/${id(serverId)}/clis/${id(cli)}/resolve`, "POST", {
      choice,
      ...confirm(confirmStdio),
    }),
  /** `{ finds, problems }`: entries the owner added to a CLI, and CLIs that failed. */
  finds: () => api("/mcp-servers/cli-finds"),
  /** `{ adopted, failed }`; each key is adopted on its own. */
  adopt: (body) => api("/mcp-servers/cli-finds/adopt", "POST", body),
};
