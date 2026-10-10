# AgentPier team tool plugin probe

Date: 2026-10-08. OpenClaw 2026.9.8, Node 26.7.0, macOS arm64.

The approved team design requires an AgentPier-owned admission boundary and permits
all four initial members to run concurrently. A disposable native probe verified
the plugin and execution primitives before writing the implementation plan.

## Verified

| Contract                        | Evidence                                                                                                                                                                                |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native plugin loading           | A local versioned manifest/package loaded through the Gateway's explicit plugin configuration                                                                                           |
| Actual model tool execution     | A deterministic streaming model called the optional `agentpier_team_probe` tool; the tool called a separately authenticated loopback fixture                                            |
| Caller context                  | The fixture received the exact expected runtime agent ID, session key and tool-call ID; the version-2 invocation guard was present and accepted calls before and after the HTTP request |
| Restricted tool surface         | The parent model's advertised tools excluded `sessions_spawn`, `sessions_send` and `gateway`; member model requests did not advertise the probe tool                                    |
| Four concurrent member profiles | Four distinct profile sessions reached a model-response barrier simultaneously; the fixture released responses only after all four arrived                                              |
| History and parent follow-up    | All four member histories contained their results; a separate controller-requested parent synthesis turn completed                                                                      |
| Graceful restart                | All four histories remained readable after restarting the owned Gateway                                                                                                                 |

Seventeen assertions passed. The script exited successfully and closed the owned
Gateway, model server and bridge server, then removed its disposable state and
generated credentials. The pinned runtime package was reused read-only. No real
provider, personal Telegram conversation, existing assistant state or production
service was touched. The throwaway harness remains in the ignored spike workspace.

## What this does not establish

The controller created the profiles and dispatched the four member turns. The
probe tool only verified context and transport; it did not authorize or provision a
real team. Parent synthesis was explicitly invoked by the controller. There is no
claim of an implemented coordinator, automatic result delivery, transactional
installation, approval UI, durable admission or crash recovery.

The invocation guard's rejection after retirement, missing/expired bridge authority,
configuration changes during admission, duplicate requests, lost acknowledgements,
active crashes and Telegram result routing still need product contract tests.
Checking the advertised model tool list does not by itself prove every alternative
invocation route is blocked. Linux and other architectures remain unqualified.

The plugin factory provides trusted session identity but does not expose an
AgentPier request ID. The implementation must bind a bridge invocation to the exact
active AgentPier attempt, not repeatedly resolve a session to whichever later turn
is current. The plan includes a prepare/commit exchange with an invocation guard
between the two requests and an attempt-bound expiring bridge ticket.

## References

- [Team design](../adr/0002-managed-openclaw-assistants.md)
- [Previous profile and native subagent probe](openclaw-permanent-agent-spike.md)
- [Official plugin tools](https://docs.openclaw.ai/plugins/tool-plugins)
- [Official SDK registration surface](https://docs.openclaw.ai/plugins/sdk-overview/tools-and-commands)

Bundled SDK declarations and documentation were inspected at the tested pin. The
live contract, rather than current upstream defaults, is the compatibility evidence.
