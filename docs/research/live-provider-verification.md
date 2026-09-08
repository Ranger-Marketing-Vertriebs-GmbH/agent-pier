# Live central-provider verification

Small real requests were authorized by the user and executed through local AgentPier-created native CLI sessions in owned temporary projects. Credentials were supplied only through central connection resolution; no keys were logged, exported or copied to the deployment target. Each submitted task requested only the exact response `AGENTPIER_OK`, without tools or file changes. Sessions were stopped and removed after testing.

| CLI                 | Connection       | Model                | Result                                                                                                               |
| ------------------- | ---------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Codex 0.153.4       | OpenRouter       | `z-ai/glm-5.3-flash` | Exact assistant reply; automatic Chat binding                                                                        |
| Codex 0.153.4       | Z.ai Responses   | `glm-5.3`            | Exact assistant reply; declared Responses access worked for this request                                             |
| Claude Code 2.1.263 | OpenRouter       | `z-ai/glm-5.3-flash` | Exact assistant reply in Terminal and Chat; configured context 1,048,576                                             |
| Claude Code 2.1.263 | Z.ai             | `glm-5.3-flash`      | Exact assistant reply in Terminal and Chat; configured context 1,000,000                                             |
| OpenCode 1.18.29    | OpenRouter       | `z-ai/glm-5.3-flash` | Exact assistant reply in Terminal and automatically bound Chat after loader correction; configured context 1,048,576 |
| OpenCode 1.18.29    | Z.ai regular API | `glm-5.3-flash`      | Provider rejected the request with insufficient balance/resource package; automatic retries were stopped             |

| OpenCode 1.18.29 | Z.ai Coding Plan | `glm-5.3-flash` | Exact assistant reply and automatically bound Chat; configured context 1,000,000 |

A final isolated OpenCode request through `zai-coding-plan/glm-5.3-flash` succeeded with the same saved GLM key: exact `AGENTPIER_OK` in 6.9 seconds, automatically bound Chat with two messages, 8,100 used tokens and a configured 1,000,000-token context. The owned empty repository remained unchanged apart from its initial `.git` directory. Temporary credentials, application data and native processes were removed after verification.

This establishes a working Coding Plan route for the tested OpenCode model; it does not establish regular API credit or account-wide entitlement. The original central connection remains configured as `zai`. For this OpenCode route, choose **Z.ai Coding Plan** when configuring the central connection. No billing or existing account configuration was changed. Z.ai documents the separate product selection in its [OpenCode guide](https://docs.z.ai/devpack/tool/opencode) and the dedicated endpoint in its [Coding Plan quick start](https://docs.z.ai/devpack/quick-start).

The tests exposed two integration defects. Codex's OpenRouter native catalog advertised a larger context than the routing provider's published limit. Version1.0.1 explicitly uses the smaller known limit and requires a session restart when changing a model whose context is pinned. Seven catalog-normalized matrix cases verify generated configuration, launch arguments and model controls, while preserving native catalog/auth behavior and existing Z.ai configuration.

OpenCode's automatic reader-binding plugin lacked the default object export required by its current TUI loader. The regression now loads the exact configured module URL and exercises its default plugin through session changes and disposal. A fresh real OpenRouter session subsequently returned two structured Chat messages, including the actual assistant response.

These short tasks verify authentication, transport, model selection, response delivery and native history integration. They do not stress-test maximum context capacity, every catalog model, account-wide entitlement or physical-device push delivery. Native usable context counters can differ from configured model windows because of the CLI's own budget reservations.
