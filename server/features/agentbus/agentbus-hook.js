import { agentbusClient } from "./agentbus-client.js";

try {
  const event = process.argv[2];
  if (!["SessionStart", "UserPromptSubmit", "SessionEnd"].includes(event)) throw Error();
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 65536) throw Error();
    chunks.push(chunk);
  }
  const data = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  const nativeSessionId =
    data.session_id ?? data.sessionId ?? data.thread_id ?? data.conversation_id;
  if (typeof nativeSessionId !== "string" || !nativeSessionId) throw Error();
  const response = await agentbusClient()({
    jsonrpc: "2.0",
    id: 1,
    method: "agentbus/hook",
    params: { event, nativeSessionId, pid: process.pid },
  });
  if (response?.error) throw Error();
  const context = response?.result?.context;
  if (event !== "SessionEnd" && typeof context === "string" && context)
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: event, additionalContext: context },
      }) + "\n",
    );
} catch {
  process.stderr.write("AgentBus hook unavailable. Check AgentPier session access.\n");
}
