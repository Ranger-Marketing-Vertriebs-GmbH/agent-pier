import http from "node:http";

// OpenClaw's tool search (directory mode, runtime-config.js) sends only the core file
// tools, the direct-only tools and its controls (tool_search, tool_describe,
// dispatch_action) as schemas; every other OpenClaw and plugin tool is a line of the
// system prompt's directory ("- name (owner): description"), which the model may call
// by its exact name. MCP tools are listed in neither: they are found by tool_search.
const directoryHeading = "Available deferred-schema tools:";
// It reads the directory from any text of the request (Chat Completions messages,
// Responses instructions or input items), never from the tool schemas.
function directoryText(value) {
  if (typeof value === "string") return value.includes(directoryHeading) ? value : "";
  if (!value || typeof value !== "object") return "";
  for (const [key, item] of Object.entries(value)) {
    const found = key === "tools" ? "" : directoryText(item);
    if (found) return found;
  }
  return "";
}
export function deferredToolNames(input) {
  const system = directoryText(input);
  const start = system.indexOf(directoryHeading);
  if (start < 0) return [];
  const names = [];
  for (const line of system
    .slice(start + directoryHeading.length)
    .split("\n")
    .slice(1)) {
    const match = /^- ([A-Za-z0-9][A-Za-z0-9_.:-]*)/.exec(line);
    if (!match) break;
    names.push(match[1]);
  }
  return names;
}
// The tools a request lets the model call by name: its schemas and its directory.
export const offeredToolNames = (input) => [
  ...(input?.tools || []).map((t) => t.function?.name ?? t.name),
  ...deferredToolNames(input),
];
export const toolSearchControls = ["tool_search", "tool_describe", "dispatch_action"];
// The granted tools a request offers, in either form, without tool search's controls.
export const grantedToolNames = (input) =>
  offeredToolNames(input).filter((name) => !toolSearchControls.includes(name));
// The tool names a tool_search result names (`"name":"…"`, JSON-quoted or not).
export const searchedToolNames = (text) =>
  [...String(text ?? "").matchAll(/\\*"name\\*":\s*\\*"([^"\\]+)/g)].map((m) => m[1]);
const searchCallId = "tool_search-call";
// The tool names this session's `discover` search returned (assistantModelServer).
export const discoveredToolNames = (requests) => {
  const messages = requests.flatMap((r) => r.messages || []);
  // OpenClaw may rewrite a call's id: follow the ids of the replayed search calls.
  const searches = new Set([
    searchCallId,
    ...messages
      .flatMap((m) => m.tool_calls || [])
      .filter((c) => c.function?.name === "tool_search")
      .map((c) => c.id),
  ]);
  return discoveredIn(messages, searches);
};
const discoveredIn = (messages, searches) => [
  ...new Set(
    messages
      .filter((m) => m.role === "tool" && searches.has(m.tool_call_id))
      .flatMap((m) =>
        searchedToolNames(
          typeof m.content === "string" ? m.content : JSON.stringify(m.content),
        ),
      ),
  ),
];
// By default the model calls `session_status` once; `tool` names another tool (with its
// arguments) to call once instead, when that tool is offered (offeredToolNames). `tool`
// may also be a function of the request returning such a call, or null for a plain
// reply. With `discover` (a query), a session's model first calls tool_search with it,
// as a model looks for MCP tools that the directory does not list, and may then call a
// tool the search returned.
export async function assistantModelServer({
  tool = { name: "session_status", arguments: {} },
  discover,
} = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let bytes = "";
    for await (const part of req) bytes += part;
    // A probe without a chat request body (OpenClaw checks models on some paths).
    if (!bytes) return res.writeHead(404).end();
    const input = JSON.parse(bytes);
    requests.push(input);
    if (input.messages?.some((m) => JSON.stringify(m.content).includes("HOLD_FOR_CRASH")))
      return;
    const offered = offeredToolNames(input);
    const results = input.messages.filter((m) => m.role === "tool").length;
    const searching = !!discover && offered.includes("tool_search");
    const wanted = typeof tool === "function" ? tool(input) : tool;
    const call =
      searching && results === 0
        ? { name: "tool_search", arguments: { query: discover, limit: 20 } }
        : wanted;
    const useTool =
      !!call &&
      (offered.includes(call.name) ||
        (searching && discoveredToolNames([input]).includes(call.name))) &&
      // One call per session: after the search, if any, and before any other result.
      results === (searching && call === wanted ? 1 : 0);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const delta = useTool
      ? {
          tool_calls: [
            {
              index: 0,
              id: `${call.name}-call`,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            },
          ],
        }
      : { content: "A useful assistant reply." };
    res.write(
      `data: ${JSON.stringify({ id: "fixture-chat", object: "chat.completion.chunk", model: "fixture-model", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ id: "fixture-chat", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: useTool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    requests,
    url: `http://127.0.0.1:${server.address().port}/v1`,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      }),
  };
}
