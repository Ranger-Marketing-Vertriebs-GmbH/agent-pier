import readline from 'node:readline';

export function createServer({ tools, input = process.stdin, output = process.stdout, name = 'agentbus', version = '0.1.0' }) {
  const rl = readline.createInterface({ input });
  const write = (obj) => output.write(JSON.stringify(obj) + '\n');

  async function handle(req) {
    switch (req.method) {
      case 'initialize':
        return { protocolVersion: req.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name, version } };
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
      case 'tools/call': {
        const tool = tools.find((t) => t.name === req.params?.name);
        if (!tool) { const e = new Error(`unbekanntes Tool: ${req.params?.name}`); e.rpcCode = -32602; throw e; }
        try {
          return { content: [{ type: 'text', text: await tool.run(req.params.arguments ?? {}) }] };
        } catch (e) {
          return { content: [{ type: 'text', text: String(e?.message ?? e) }], isError: true };
        }
      }
      default: {
        const e = new Error(`method not found: ${req.method}`); e.rpcCode = -32601; throw e;
      }
    }
  }

  rl.on('line', async (line) => {
    try {
      if (!line.trim()) return;
      let req;
      try { req = JSON.parse(line); } catch { return; }
      if (!req || typeof req !== 'object' || req.id === undefined) return; // kein Objekt oder Notification
      try {
        write({ jsonrpc: '2.0', id: req.id, result: await handle(req) });
      } catch (e) {
        write({ jsonrpc: '2.0', id: req.id, error: { code: e.rpcCode ?? -32603, message: String(e?.message ?? e) } });
      }
    } catch (e) {
      process.stderr.write(`agentbus: mcp ${String(e?.message ?? e)}\n`);
    }
  });
  return { close: () => rl.close() };
}
