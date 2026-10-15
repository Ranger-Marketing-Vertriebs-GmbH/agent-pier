# MCP package qualification

Managed MCP server packages (see [MCP](mcp.md#installing-a-server-package)) were
qualified on 2026-10-15 on macOS 26.5.1 (arm64), AgentPier 9cd23303 (branch
`feat/mcp-packages-pypi`), toolchains Node 26.7.0 (npm 11.19.0), uv 0.12.21 and CPython
3.14.7. This document records the code review of third-party servers and the
qualification runs.

## OPNsense server review (opnsense-mcp-server 0.4.1)

Reviewed on 2026-10-15 on macOS (arm64) from the exact PyPI release, without running
any package code: the wheel was read statically (an `ast` walk over every call site),
and dependency ranges were checked by resolving with uv and reading the installed
files. 0.4.1 (2026-08-19) is the newest release; the upstream `main` branch has no
newer code (last commit 2026-08-19).

- Wheel `opnsense_mcp_server-0.4.1-py3-none-any.whl`, SHA-256
  `85540ca61ed3cc27731471c45e1c74fb0a888827fb145bc58ce3a2104d243d19` (matches PyPI);
  `Requires-Python: >=3.11`; program `opnsense-mcp` (`opnsense_mcp.server:main`,
  stdio transport). Source: <https://github.com/lucamarien/opnsense-mcp-server>.
- Write switch: `OPNSENSE_ALLOW_WRITES`, default `false` (`opnsense_mcp/config.py:80`);
  only `true`, `1` or `yes` enable writes, an unknown value stops the server.
- Gate: `OPNsenseAPI.require_writes()` (`api_client.py:462`). Every configuration
  change calls it directly or through `SavepointManager.create()` before its first
  POST: 86 POST and text-download call sites checked, 45 of them in 36 write tools,
  all gated. `_apply_dnsbl` is reached only after the gate.
- POSTs without the gate: OPNsense search and status endpoints (reads, including the
  helpers of `opn_security_audit` and the configuration scan), `opn_pf_states`
  (`query_states`), and the diagnostics tools `opn_ping`, `opn_traceroute` and
  `opn_dns_lookup`, which start short diagnostic jobs (hostnames are filtered for
  shell metacharacters). The server sends POSTs only to fixed endpoints from its
  registry.
- Blocked endpoints: `core/system/halt`, `core/system/reboot`,
  `core/firmware/poweroff`, `core/firmware/update`, `core/firmware/upgrade`
  (`api_client.py:16`). The check runs on the unnormalised path, so path
  normalisation after the check can bypass it.
  With writes off this is limited to GET requests (`opn_get_dnsbl`,
  `opn_haproxy_get`); OPNsense ignores halt, reboot, poweroff, update and upgrade on
  GET. Upstream issue #9 (open) asks how to report a blocklist bypass privately; it
  is probably the same bug. The API user's privileges remain the boundary.
- `opn_download_config` and `opn_get_config_section` with `include_sensitive=true`
  return the configuration unredacted, and the default redaction covers only a fixed
  list of tag names: the API user gets no backup privilege. Without it,
  `opn_download_config`, `opn_scan_config`, `opn_get_config_section`,
  `opn_ipv6_status` and the configuration part of `opn_security_audit` fail with an
  access error.
- Dependencies: `fastmcp>=2.0` only. `opnsense_mcp/api_client.py:11` imports `httpx`
  without declaring it; fastmcp 4.x (4.0.0 and 4.1.0) depends on `httpx2`, so an
  unconstrained resolve installs fastmcp 4.1.0, `httpx2` 2.13.1 and no `httpx`, and the
  server cannot start. fastmcp 2.x (2.14.7) has no `fastmcp.server.lifespan`, which
  `server.py` imports. Working range: fastmcp `>=3.0.0,<4` (3.0.0, 3.1.0, 3.2.0 and
  3.4.8 checked: each ships `lifespan`, `Context.lifespan_context` and
  `FastMCP(version=, lifespan=)` and requires `httpx>=0.28.1,<1.0`). Install it with
  the dependency constraint `fastmcp<4`, which resolves fastmcp 3.4.8, `httpx` 0.28.1
  and `mcp` 1.30.0.
- Verdict: read-only by default in code: yes. The enforced boundary is the restricted
  API user. The key needs `System: Firmware`, which also allows firmware and reboot
  actions; the owner accepted it with the write switch and the agent's shell kept off.

### Restricted OPNsense API user

OPNsense privileges cover whole API controllers, not read or write access, and the
server detects the OPNsense version through `GET api/core/firmware/status` before
every first request, so no tool works without access to that path. Privilege names
and patterns were read from `opnsense/core` 26.7.7 and `master` (identical for the
privileges below).

Grant:

| Privilege                                | Tools                                  | Other actions the key gains                                                    |
| ---------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------ |
| `System: Firmware` (required)            | version detection, `opn_system_status` | firmware check, update, upgrade, plugin install and removal, reboot, power off |
| `Diagnostics: Netstat`                   | `opn_interface_stats`                  | none                                                                           |
| `Diagnostics: ARP Table`                 | `opn_arp_table`                        | none                                                                           |
| `Diagnostics: NDP Table`                 | `opn_ndp_table`                        | none                                                                           |
| `Diagnostics: Logs: Firewall: Live View` | `opn_firewall_log`, interface names    | none                                                                           |
| `Firewall: Aliases`                      | `opn_list_firewall_aliases`            | none (export, search, list, get only)                                          |
| `Diagnostics: Ping`                      | `opn_ping`                             | diagnostic jobs only                                                           |
| `Diagnostics: Traceroute`                | `opn_traceroute`                       | diagnostic jobs only                                                           |
| `Interfaces: Diagnostics: DNS Lookup`    | `opn_dns_lookup`                       | diagnostic jobs only                                                           |

Grant only when the tool is needed, because the key also gains changes the server
never sends while writes are off:

| Privilege                  | Tools                    | Other actions the key gains          |
| -------------------------- | ------------------------ | ------------------------------------ |
| `System: Gateways`         | `opn_gateway_status`     | gateway configuration changes        |
| `System: Static Routes`    | `opn_list_static_routes` | static route changes                 |
| `Status: Services`         | `opn_list_services`      | service start, stop and restart      |
| `Diagnostics: Show States` | `opn_pf_states`          | killing and flushing firewall states |

Never grant: `All pages`, `Diagnostics: Configuration History` (configuration
download with secrets), `System: Configuration: Backups`, `Diagnostics: Reboot
System`, `Diagnostics: Halt system`, `Diagnostics: Factory defaults`, `System:
Access: Management`, and the privileges of configurable areas (`Firewall: Rules
[new]`, `Firewall: Alias: Edit`, `Firewall: NAT: Destination NAT`, `Services:
Unbound`, `Services: Dnsmasq DNS/DHCP: Settings`, `Services: DHCP: Kea(v4)`,
`System: Settings: Cron`, VPN configuration pages and plugin pages such as HAProxy).
Tools for areas without a privilege fail with an access error.

`System: Deny config write` makes every configuration save through the API fail for
this user (gateway and route changes included), but not service, firmware or state
actions. It also breaks `opn_ping`, `opn_traceroute` and `opn_dns_lookup`, whose
OPNsense endpoints save a job through the same code path. Add it when those three
tools are not needed.

## Qualification run (2026-10-15, macOS arm64)

A disposable AgentPier from this branch ran with its own data directory, its own
`HOME` and its own tmux socket. Every server went through the real routes: preview,
confirmation (`confirmInstall`), install job and package status. Each server was then
bound to Claude Code, and the exact command, args and env that AgentPier wrote into the
disposable `~/.claude.json` were started by a plain MCP stdio client (`initialize`,
`tools/list`, one real `tools/call`) with `PATH=/usr/bin:/bin`. Times are the preview
request and the install job until **Installed** (polled every second), with the
toolchains already staged at startup.

| Server                                    | Version    | Registry             | Preview / install | Direct MCP call                                                                                                         | Notes                                                                                                                                                        |
| ----------------------------------------- | ---------- | -------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@modelcontextprotocol/server-memory`     | 1.0.0      | npm                  | 4.5 s / < 2 s     | `create_entities` then `open_nodes` returned the entity                                                                 | 96 packages, 9 tools. Without `MEMORY_FILE_PATH` the server writes `memory.jsonl` into its install directory, which an update or reinstall replaces: set it. |
| `@modelcontextprotocol/server-filesystem` | 1.0.0      | npm                  | 0.8 s / 1 s       | `list_directory` and `read_text_file` on the allowed directory; `/etc` refused ("path outside allowed directories")     | Allowed directory as the owner argument after the generated one; 104 packages, 14 tools.                                                                     |
| `mcp-server-time`                         | 2026.10.10 | PyPI                 | 3.5 s / 1 s       | `get_current_time` for `Europe/Berlin` returned the local time (+02:00, DST)                                            | First PyPI preview (cold uv cache); 32 packages.                                                                                                             |
| `mcp-server-fetch`                        | 2026.10.10 | PyPI                 | 0.2 s / 1 s       | `fetch https://example.com` returned "Example Domain" as Markdown                                                       | 44 packages.                                                                                                                                                 |
| `opnsense-mcp-server`                     | 0.4.1      | PyPI, `fastmcp<4`    | 0.1 s / 2 s       | 81 tools listed; `opn_add_alias` answered "Write operations disabled"; `opn_system_status` could not connect (expected) | Program `opnsense-mcp`; placeholder environment values and a TEST-NET address, no firewall. See below.                                                       |
| `mcp-pandoc`                              | 0.11.1     | PyPI, builds allowed | 0.3 s / 1 s       | `convert-contents` Markdown to HTML returned `<h1 id="qualification">` and `<strong>`                                   | Built `pandoc==2.4` from its sdist; pandoc 3.12.1 found only with `PYPANDOC_PANDOC` set (see below).                                                         |

- `mcp-pandoc` without the opt-in: the preview reported `needsScripts: true` with no
  dependencies, and the install was refused with `MCP_PACKAGE_NEEDS_SCRIPTS`; no server
  was created. With the opt-in the preview resolved 36 packages and the install log
  showed `Building pandoc==2.4`. The server's `PATH` (`/usr/bin:/bin`) does not contain
  Homebrew's pandoc, so the first call answered "No pandoc was found"; with the
  environment value `PYPANDOC_PANDOC=/opt/homebrew/bin/pandoc` set in the form, the
  conversion worked.
- OPNsense: without a constraint the preview resolves fastmcp 4.1.0 and `httpx2`
  2.13.1. With `fastmcp<4` the preview, the stored record and the install receipt list
  the constraint, and the installed environment holds fastmcp 3.4.8, `httpx` 0.28.1 and
  `mcp` 1.30.0 (no `httpx2`). Without `OPNSENSE_URL`, `OPNSENSE_API_KEY` and
  `OPNSENSE_API_SECRET` the server stops at startup (`ConfigError`). With placeholder
  values and an unreachable TEST-NET address it starts, lists 81 tools, refuses the
  write tool before any request and fails the read tool on version detection. The
  real-firewall run is the owner's (below).
- Build tools (D6): with the opt-in, the build of `pandoc==2.4` fetched its build
  backend (`setuptools`) from PyPI at build time, outside the hashed lock; the
  confirmation's scripts and builds warning names this.

### Update, reinstall and remove

- Update: `mcp-server-time` 2026.10.10 to 2026.8.18. The update preview's diff listed
  one change (`mcp-server-time` 2026.10.10 to 2026.8.18), nothing added or removed.
  The job installed into a new directory, the old one was pruned, the Claude Code entry
  moved to the new program and the direct call worked again.
- Reinstall: after its install directory was deleted by hand, the package status showed
  `missing`; **Reinstall** synced the stored lock (32 packages) into a new directory
  and the direct call worked again. Until then the Claude
  Code entry kept pointing at the deleted program.
- Remove: deleting the `server-filesystem` server removed its directory from
  `mcp-packages/installs/` and its Claude Code entry.
- Yanked files: no PyPI release had a per-file yank among all releases of the 1,500 most
  downloaded projects and the packages above (PyPI yanks whole releases). A yanked
  dependency release pinned by a constraint (`tzlocal==5.4.1` for `mcp-server-time`)
  previewed without `MCP_PACKAGE_INTEGRITY_MISMATCH`; only the top release's files are
  checked against PyPI's digests.
- Package create, update and reinstall answered `400` ("Ungültige Audit-Aktion")
  although the job ran and finished: the audit schema rejects the three-part
  `mcp.package.*` actions. Reported for a fix before merge.

### Scope

- Linux: the `mcp-toolchains` workflow run 38692582095 (commit 808c5d44) passed on
  linux-x64, linux-arm64, darwin-x64 and darwin-arm64 (toolchains, local-index
  installs and the C-extension build). Real-server calls ran on macOS only.
- Agent and Claude Code calls, and OPNsense with real credentials and the restricted
  API user, are done by the owner in the real instance after merge.
- Upstream issue: not posted (owner decision).
