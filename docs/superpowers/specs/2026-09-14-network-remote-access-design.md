# Network remote access without Tailscale

Date: 2026-09-14. Status: approved design, implementation pending.

## Goal

AgentPier can be reached from another device on the operator's own network
without Tailscale and without an additional reverse proxy. Access is protected
by the existing workspace login. The operator explicitly accepts plain HTTP and
its consequences; the product makes those consequences unmistakable. The same
configuration is settable from the settings page and from a script for
headless installations.

Out of scope: TLS termination inside AgentPier, automatic certificate
management, exposing the service to the public internet, changing the
Tailscale mode. The configuration shape leaves room for a later `tls` block.

## Configuration model

`config.json` in the data directory stays the single source for the server, the
script and the settings page:

```json
{
  "port": 4380,
  "remoteUrl": "https://macmini.tailnet.ts.net:8443",
  "ownerLogin": "user@example.com",
  "network": {
    "enabled": true,
    "bind": "0.0.0.0",
    "hosts": ["agentpier.home.arpa", "macmini.local"]
  }
}
```

- `network.enabled` switches the network mode. A missing or disabled block
  keeps today's behaviour: loopback binding, local and Tailscale access only.
- `network.bind` is `0.0.0.0`, `::` or one concrete interface address. Loopback
  always stays reachable because the service health check and release
  activation use `127.0.0.1`.
- `network.hosts` lists additional allowed host names without port. The
  interface addresses detected at startup, `os.hostname()` and
  `<hostname>.local` are added automatically. Every entry is matched against the
  `Host` header together with the configured port.
- Validation lives in one shared module used by the script and the settings
  route: valid IP address or host name, no control characters, no scheme, no
  path, at most 20 entries. An invalid file aborts startup with a clear message
  instead of silently falling back.
- Environment variables keep covering only the port and the data directory.
  The network mode has no environment variable so that there is exactly one
  source of truth.
- The file keeps mode `0600`.

## Server binding and host check

- `server/index.js` listens on `network.enabled ? network.bind : "127.0.0.1"`.
  The server logs the effective reachable addresses at startup. The test server
  and blackbox fixtures stay on loopback.
- `authorizeRequest` in `server/http/security.js` gains a third branch. Order:
  1. Loopback source and local host: unchanged.
  2. Loopback source and host equal to `remoteUrl`: Tailscale branch, unchanged.
  3. `network.enabled` and host inside the allowed set: network branch. The
     source address may also be loopback so that an operator's own reverse
     proxy on the same machine works. The expected origin is
     `http://<Host header>`.
  4. Otherwise 403, unchanged.
- Proxy headers: in the network branch `x-forwarded-*` and `forwarded` are
  ignored, not rejected, because an operator's proxy sets them. `tailscale-*`
  headers still cause rejection in the network branch so that a Tailscale Serve
  request never slides into the weaker branch. The source address is never
  taken from proxy headers.
- Origin and cookies: the origin must match the used host exactly, as in the
  other branches. The login cookie stays host-bound with `SameSite=Strict` and
  without `Secure` when the scheme is HTTP. Login is always required in the
  network branch, including the health endpoint, as with Tailscale today. The
  existing rate limit of ten hash attempts per minute applies.
- MCP endpoint: the machine transport check in `http-transport.js` gains the
  same network branch so MCP clients on the LAN can reach the endpoint. The
  public OAuth resource URL stays `remoteUrl` or loopback; a LAN host is not
  chosen automatically. This is documented as a limitation.
- Allowed set: computed once at startup from interfaces, host name and list.
  Configuration changes take effect only after a restart. No per-request DNS
  resolution.
- Error message: a new German and English message explains that the host is
  not allowed because the network mode is off or the host is not listed.

## Settings page and API

- Route `settings/remote` next to updates and diagnostics. Visible only for
  local or Tailscale access with login. From the network mode itself only the
  switch-off is possible; bind and host list are read-only there so a typo
  cannot lock the operator out while the off switch stays reachable.
- Three cards: Local (always active, URL `http://127.0.0.1:<port>`), Tailscale
  (status from `remoteUrl`, hint to `npm run tailscale`), Network (switch, bind
  selection from the detected interfaces plus "all", host list as chips, list of
  resulting URLs to open or copy).
- Enabling shows a confirmation dialog with fixed text: password and content
  travel unencrypted, no push notifications, no PWA installation, only for
  trusted networks, and the machine must not have a port forward to the
  internet. The dialog needs an active confirmation. The warning stays as a
  permanent notice on the card afterwards.
- `GET /api/remote` returns the saved configuration, the effective bind state
  and the detected addresses. `PUT /api/remote` validates through the shared
  module, writes `config.json` and answers with `restartRequired: true` while
  the running state differs. A "Restart service" button uses the existing
  `restartService`; without an installed service the page shows the manual
  restart hint instead. After a restart the page polls the health endpoint and
  reports when the new binding is active.
- The sidebar link keeps showing only the Tailscale URL. Network URLs appear
  only on the settings page so that nobody adopts the unencrypted address as the
  default by accident.
- Enabling, disabling and changes to bind or host list create an audit entry
  with source "settings" or "script".
- All copy exists in both catalogs; the warning text is identical to the
  script's output.

## Script for headless installations

- `npm run remote -- <command>` runs `scripts/remote.mjs`, modelled on
  `scripts/tailscale.mjs`:
  - `status` prints the saved configuration, detected addresses and resulting
    URLs.
  - `enable --bind 0.0.0.0 --host agentpier.home.arpa --host macmini.local`
    enables the mode; `--bind` defaults to `0.0.0.0`, `--host` repeats.
  - `hosts --add <name>` and `hosts --remove <name>` maintain the list.
  - `disable` switches the mode off and keeps the list.
- `enable` prints the same warning text as the dialog and requires
  `--accept-plain-http`; otherwise it exits with code 2. No interactive prompt,
  so automation stays possible.
- Script and `PUT /api/remote` call the same module for validation, reading,
  writing and address detection. The script only parses arguments and prints.
- After every change the script attempts `restartService` with the same rules
  as release activation (`systemctl --user restart` or `launchctl kickstart`).
  Without an installed service it prints the hint to `npm start` or
  `npm run service:install`. `--no-restart` skips the restart. Afterwards it
  checks the health endpoint on loopback and reports success or the exact
  deviation.
- The script writes the audit entry with source "script" directly through the
  existing audit store because the server restarts meanwhile.
- `AGENTPIER_DATA_DIR` applies as for the other scripts; script and service
  must use the same directory, which the output states.

## Tests and documentation

- Unit: validation of the `network` block, computation of the allowed host set,
  argument parsing of the script.
- Integration: host check for all three branches including proxy headers,
  Tailscale headers in the network branch, origin errors, login requirement and
  health endpoint; API route with validation errors and `restartRequired`;
  script against a temporary data directory without a real service.
- Blackbox: start the server with `network.enabled` on a non-loopback test
  interface and verify a request through the LAN address when the CI
  environment offers such an address; otherwise skip with a stated reason.
- Browser: settings page in both languages, confirmation dialog, chips, URL
  list, restart hint without a service.
- Documentation: new section in `docs/remote-access.md` with security notes and
  script examples, references in `docs/installation.md` and `docs/linux.md`,
  README note in both languages.
