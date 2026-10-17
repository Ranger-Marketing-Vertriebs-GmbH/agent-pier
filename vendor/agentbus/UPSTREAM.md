AgentBus by David Kaulig, MIT licensed.

Vendored runtime from the supplied agentbus-main archive, reviewed September 6, 2026.
Original LICENSE retained. Installers, remote package descriptors, setup scripts and documentation are excluded.
AgentPier adapters bind peers to private launch records, scope buses to canonical project directories, use target-profile wake settings, and correlate OpenCode MCP calls explicitly with their native session.

AgentPier wake hints carry message references so delayed nudges can be correlated with already acknowledged batched inbox reads without replaying messages.

AgentPier send budgets read sender, pair and reply-chain counts from the queue (`sentSince`, `replyDepth`, sender index), and wake hints ask every runtime to reply only when needed.
The legacy vendored send path (`core/send.js`, used by `mcp/tools.js` and the standalone `agentpier/mcp.js` server) is not budgeted; only pre-broker processes use it. Current sessions send through the AgentPier broker.
