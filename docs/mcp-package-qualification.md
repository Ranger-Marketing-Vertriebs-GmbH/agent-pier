# MCP package qualification

Managed MCP server packages (see [MCP](mcp.md#installing-a-server-package)) are
qualified against real servers before AgentPier documents them as supported. This
document records the code review of third-party servers and the qualification runs.

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
  (`api_client.py:16`). The check runs on the unnormalised path while httpx later
  resolves `..` segments, so a crafted `uuid` argument can reach other endpoints.
  With writes off this is limited to GET requests (`opn_get_dnsbl`,
  `opn_haproxy_get`); OPNsense ignores halt, reboot, poweroff, update and upgrade on
  GET. Upstream issue #9 reports a blocklist bypass privately; the API user's
  privileges remain the boundary.
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
  API user.

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
