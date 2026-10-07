# OpenClaw runtime integration spike

Date: 2026-10-07. Package: npm `openclaw@2026.9.8`. Platform: macOS arm64,
Node 26.7.0. This is recorded evidence, not a promise about subsequent releases.

## Probe conditions

The experiment used a disposable local package installation and a foreground
Gateway with private HOME, state, configuration, workspace and explicit log paths.
It used random disposable credentials and a deterministic local HTTP model.
No personal accounts, external channels, paid model requests or global daemon
installation were involved. Package lifecycle scripts were disabled, so the result
does not establish that optional native extensions work without their installers.
Both owned Gateway processes and the model server were stopped after the probe.

## Observations

| Probe                      | Observed result                                                                                          |
| -------------------------- | -------------------------------------------------------------------------------------------------------- |
| Local pinned installation  | Succeeded; about 728 MiB installed on the test machine                                                   |
| Node requirement           | `>=24.16.0 <25                                                                                           |     | >=26.1.0`, incompatible with Node 22 |
| Backend loopback WebSocket | Authenticated protocol 4 handshake succeeded                                                             |
| Startup readiness          | A listener can precede readiness; connect returned retryable `UNAVAILABLE` before succeeding             |
| CLI config validation      | `config validate --json` succeeded; invalid startup configuration exited 78                              |
| Gateway validation method  | `config.validate` was rejected as an unknown RPC method                                                  |
| Configuration reads        | Tested Gateway token and provider key fields were redacted                                               |
| Config writes              | Valid write succeeded; unknown fields and stale `baseHash` were rejected                                 |
| Config patch               | Changed one timeout path while preserving test secrets and unrelated configuration                       |
| Schema normalization       | Legacy `agents.list` was normalized to `agents.entries`                                                  |
| Session operations         | Create, list, subscribe, send, describe and delete worked                                                |
| Model turn                 | Actual streamed `POST /v1/chat/completions` to the local model returned the expected deterministic reply |
| Restart persistence        | Same session ID and exactly equal conversation messages after graceful stop/start                        |
| Active cancellation        | Abort reported success; waiting for the run confirmed a terminal result with `stopReason=rpc`            |
| Authentication             | Incorrect token rejected; read-only connection could not patch configuration                             |
| Session deletion           | Removed the list entry; archived transcript bytes may remain                                             |
| Cleanup                    | Owned Gateway processes exited cleanly; model server closed                                              |

The test model had no tools. It established transport, execution control and
persistence, not useful reasoning or service access. A token holder could request
an admin connection; self-selected read scopes are not a separate credential
boundary.

Early attempts set private HOME/TMPDIR but OpenClaw still selected its shared
`/tmp/openclaw` log location. Disposable diagnostic output may have been appended;
existing logs were preserved. The final probe set `logging.file` explicitly inside
the private run directory and verified that test secrets were absent from exported
evidence and captured logs.

## UI study

The synthetic mockup was exercised in Chromium and WebKit at desktop, tablet and
phone widths, with German and English catalogs. It demonstrated direct sidebar
chats, parent/child team visibility, per-member settings, independent model changes,
chat preservation across selection changes and dynamic mock team creation.
The built bundle was also tested with AgentPier's artifact renderer under its
iframe restrictions, with no network requests. Mock team creation was deterministic
UI behavior; it was not an OpenClaw multi-agent execution test.

## Unverified requirements

Live agent spawning and reconciliation; multiple-user/runtime isolation; Telegram
pairing and delivery; Deepgram audio; Google and Microsoft OAuth; native Apple
permissions in the installed service context; ChatGPT login/refresh; local/custom
model tool support; Linux installation; abrupt crash recovery; interrupted updates;
state migration and rollback; real browser or shell tools.

Before changing the pinned runtime, repeat the protocol/configuration probes and
add coverage for the product capabilities that depend on that version. The separate
integration ADR records the chosen boundaries and delivery gates.
