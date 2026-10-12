import http from "node:http";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { echoServer } from "./mcp-test-servers.js";

/**
 * A legacy HTTP+SSE MCP server on 127.0.0.1 with the `echo` tool: GET /sse opens the
 * stream, POST /messages?sessionId= carries requests.
 */
export async function sseMcpServer() {
  const transports = new Map();
  const state = { connections: 0 };
  const listener = http.createServer(async (req, res) => {
    const address = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && address.pathname === "/sse") {
      state.connections++;
      const transport = new SSEServerTransport("/messages", res);
      transports.set(transport.sessionId, transport);
      res.on("close", () => transports.delete(transport.sessionId));
      await echoServer("sse-echo", () => {}).connect(transport);
      return;
    }
    if (req.method === "POST" && address.pathname === "/messages") {
      const transport = transports.get(address.searchParams.get("sessionId"));
      if (!transport) return res.writeHead(404).end();
      return transport.handlePostMessage(req, res);
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${listener.address().port}/sse`,
    state,
    close: () =>
      new Promise((resolve) => {
        listener.closeAllConnections();
        listener.close(resolve);
      }),
  };
}
