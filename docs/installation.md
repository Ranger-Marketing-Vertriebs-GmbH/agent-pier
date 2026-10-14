# Set up AgentPier on a Mac mini

For Linux, see [Linux installation](linux.md). This guide covers installation on the target machine. Running `npm start` for local testing does not configure automatic startup.

Create a user when you first open AgentPier, then sign in with a username and password. This also works over configured remote access. See [Login](login.md) for session and recovery details.

<a id="ein-befehl-installation-auf-macos"></a>

## One-command installation on macOS

On a native Apple Silicon or Intel Mac running macOS 14 or later:

```sh
(agentpier_tmp=$(mktemp -d) && trap 'rm -rf "$agentpier_tmp"' EXIT && curl --fail --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier/releases/latest/download/install-agentpier.sh -o "$agentpier_tmp/install.sh" && /bin/sh "$agentpier_tmp/install.sh")
```

The script first downloads the versioned installer bundle and verifies its SHA-256
checksum. It installs missing prerequisites, including Homebrew through its official
installer when needed. Prompts, Command Line Tools and an administrator password
may be required. Run it as a regular user, without `sudo`; on Apple Silicon, use a
native terminal without Rosetta.

If Homebrew is already installed:

```sh
brew install ranger-marketing-vertriebs-gmbh/tap/agentpier-installer && agentpier-install
```

Both methods use the same setup process. By default, the application is installed
under `~/.local/share/agentpier-app` and private data under
`~/Library/Application Support/AgentPier`. The login service starts AgentPier at
`http://127.0.0.1:4380`; success is reported only after the version health check passes.
Then create users and provider accounts in the UI; coding CLIs can also be installed
there. Remote access is configured separately.

Run `agentpier-install --help` for options. Use `--no-service` to install only the
application; `--install-root` and `--data-dir` override the default paths.
The corresponding `AGENTPIER_INSTALL_ROOT` and `AGENTPIER_DATA_DIR` environment
variables are also supported. Use absolute, normalized paths without `..`;
the data directory must be outside the application directory.
`--dependencies-only` repairs missing prerequisites only.
`--with-assistants` enables the optional agents and installs their runtime in
advance (see [Managed assistant runtime](#managed-assistant-runtime)).

After an interruption, run the same command again. A matching existing setup is
resumed; an AgentPier version that has already been updated is not downgraded.
The installer reports a conflict if it finds an unrelated existing installation,
different data paths, or an occupied port when service installation is requested.
`--no-service` leaves existing services and listeners unchanged. Existing source
installations are not adopted automatically. If a process exits precisely while
acquiring the installation lock, `.setup-recovery.lock` may remain. In that case,
the installer stops and asks for manual inspection. Remove the lock only after
confirming that no setup process is still running; unknown files are not deleted
automatically. Temporary `.current-<UUID>` pointers and staging directories are
preserved during repair because a concurrent application update may still use them.
Leftovers from an interrupted update to a later version do not prevent repair,
provided their structure and ownership are valid.

**Application updates remain under Settings → Operations → Updates.** `brew upgrade` or
`brew uninstall agentpier-installer` affects only the installer package. The running
application, its service and private data remain separate. To stop the service of
an installation using the default path:

```sh
"$HOME/.local/share/agentpier-app/current/bin/node" "$HOME/.local/share/agentpier-app/current/scripts/service.mjs" stop
```

To remove automatic startup, then delete
`~/Library/LaunchAgents/dev.agentpier.server.plist`. For custom paths, adjust the
application path in the command accordingly. Application releases and private data
are retained; remove data only when explicitly intended.
The Homebrew formula version identifies the installer, not necessarily the
AgentPier version currently running.

## Install a versioned release

Coding CLIs can be updated independently of AgentPier releases under **Your tools → Update CLI**. See [CLI updates](cli-updates.md) for details and manual commands.

The following sections describe running from a source checkout. For a versioned installation with immutable releases, a bundled Node runtime and a separate data directory, use the [release installer and exact commands](operations.md#installer-and-exact-commands) instead. Download the `.aprelease` package for your platform from the [official GitHub releases](https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier/releases): `darwin` for macOS or `linux`, with `arm64` or `x64` matching your machine.

The [file explorer](file-explorer.md) uses the file permissions of the user running
the web service. Versioned packages include Koffi and the matching native module;
installation and updates verify these runtime components. No manual system
extension is required. On macOS, strict new-inode operations and ZIP extraction
run only when the native check confirms that the specific destination uses APFS.

`sh scripts/install.sh` does not require `npm ci` in a clean checkout. Missing tmux and Git packages are installed by default; Node is downloaded temporarily if needed and is included in the release. Missing download tools (`curl`, `tar`, SHA-256 verification) are also installed when needed. On macOS, Homebrew is used and set up through the [official installer](https://brew.sh) if necessary; Linux uses apt. Prompts and an administrator password can be entered in the terminal. Without a terminal, the Homebrew installer runs non-interactively and requires suitable administrator privileges. On other Linux distributions, install missing packages with the distribution's package manager.

`--skip-dependencies` checks prerequisites without installing host packages. `--install-dependencies` remains available for compatibility. `--service` configures the user web service and waits for its version health check; it also saves the usual Homebrew and system paths. The data directory must not be inside a release directory.

To install missing prerequisites for an existing installation from the current checkout without changing releases or session data:

```sh
sh scripts/install.sh --dependencies-only
```

Then restart the AgentPier web service. If `tmux -V` works but the service still reports `spawn tmux ENOENT`, recreate the service configuration with the updated `scripts/service.mjs install` and the same installation and data paths. The release installer guide also covers updates, schema boundaries and rollback.

## 1. Prerequisites on the target machine

- macOS with a regular user account that will also run the CLI sessions.
- Node.js 22.13 or later with npm, tmux and Git.
- Codex, Claude Code and OpenCode may already be installed or can be installed later under **Your tools → Install CLI**.
- Optional: Tailscale, signed in to your own tailnet on both the Mac mini and mobile device.

With Homebrew already configured, the runtime tools can be installed as follows:

```sh
brew install node@22 tmux git
```

Make sure Node and the CLI binaries are on PATH. AgentPier also searches for CLIs in `~/.local/bin`, `~/.opencode/bin`, `/opt/homebrew/bin` and `/usr/local/bin`. Then verify:

```sh
node --version
npm --version
tmux -V
git --version
```

## 2. Set up the project and test locally first

Clone or copy the repository to the Mac mini and run these commands in the project directory:

```sh
git clone https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier.git
cd agent-pier
npm ci
npm run build
npm start
```

Open `http://127.0.0.1:4380` on the Mac mini. Install missing CLIs, including the GitHub CLI `gh`, through **Install CLI** as needed. They are installed on this server inside the AgentPier data directory and verified with `--version`. Then configure CLI accounts and open a session in a test project. Create a separate profile for each additional account. Add GitHub or Enterprise tokens separately under **Settings → Access → GitHub connections**.

Press `Ctrl+C` to stop the test web service before configuring the persistent service. Running terminal sessions remain in tmux.

## 3. Optionally choose a data directory

By default, the project uses `.data/`. To use a separate location, set this before running the following setup commands:

```sh
export AGENTPIER_DATA_DIR="$HOME/Library/Application Support/AgentPier"
```

Use the same value for startup, service installation and Tailscale setup. Do not share existing data between multiple running instances. A different data directory starts a separate workspace.

Optional explorer limits are configured in `config.json` under `files.limits`.
AgentPier reads and validates them at startup; unknown keys, non-positive values
and integers outside the safe range prevent startup. Stop the web service before
changing them, then restart it. There are no separate environment variables or
settings fields for these limits. Values, defaults and retention periods are listed
in the [file explorer guide](file-explorer.md#limits-and-retention).

## 4. Optional: persistent macOS service

Run these commands only on the intended target machine, after the local test:

```sh
npm run service:install
npm run service:status
```

Installation writes only the AgentPier LaunchAgent at `~/Library/LaunchAgents/dev.agentpier.server.plist`. It starts the web service when the user logs in and restarts it after a crash. The service runs under that user account; it is not a system service that starts before login.

The plist saves the Node path, project and data directories, and PATH at installation time. Run `npm run service:install` again after moving the project or upgrading Node. Your CLI sessions survive a web service restart. A machine restart or crash, however, ends all CLI processes. On the next startup—after login on macOS, since the LaunchAgent starts only then—AgentPier automatically resumes interrupted sessions with their own conversations if **Resume interrupted sessions automatically** is enabled under **Settings → Workspace → General** (on by default). Responses and processes running at the time of interruption are lost; sessions stopped by the user remain stopped.

## 5. Optional: private remote access

There are two supported ways to access AgentPier from another device: [Tailscale Serve](remote-access.md#weg-a-tailscale-serve) with HTTPS in your own tailnet, or [network mode without Tailscale](remote-access.md#weg-b-netzwerkmodus-ohne-tailscale), which can also be enabled headlessly with `npm run remote` and is protected only by login. The [remote access guide](remote-access.md) provides exact commands for both. To disable your Tailscale exposure when removing the service, use `tailscale serve --https=8443 off` as described below.

## 6. Updating

**Settings → Operations → Updates → Update channel** defaults to **Stable**, which offers only
stable releases. **Preview** also offers release candidates such as `2.1.0-rc.1`
so that new versions can be tested before their stable release. The selection
applies to the entire AgentPier installation and persists across restarts.
Preview also includes stable releases: for example, `2.1.0` supersedes
`2.1.0-rc.2`. Switching back to Stable does not install an older version; an
installed RC stays active until a newer stable version is offered. Already staged
versions remain available for explicit activation. If a custom source is configured
through `AGENTPIER_RELEASE_CHANNEL`, the update source is managed on the server.

For a versioned installation, check for a new version under **Settings → Operations → Updates**, download the package, then activate it. For an offered or already staged update, the app displays the GitHub release notes for that specific version. Notes load separately; missing notes or an unreachable GitHub do not prevent the update. Custom update sources do not display potentially unrelated official release notes. Packages come from the [official GitHub releases](https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier/releases) by default; a custom source can be set with `AGENTPIER_RELEASE_CHANNEL`. Downloads are verified with SHA-256. If the new version fails to start, the previous version is reactivated. CLI sessions survive a web service restart.

For a source checkout, update the repository files, then run:

```sh
npm ci
npm run build
npm test
npm run service:install
```

Data in `.data/` or your custom data directory is retained. Create a host backup under **Settings → Operations → Backups** before migrations; [docs/backups.md](backups.md) describes what it holds, the archive format and how to restore it into a new data directory. OAuth and Keychain logins may be tied to the individual Mac; sign in again on the Mac mini instead of copying Keychain files from a MacBook.

### Upgrading from 1.x

AgentPier 2.0 keeps the data schema of 1.28, so the update itself needs no
migration step. A few changes need one action from you or change what you can roll
back to:

- **Take a backup before you update** if you might go back to 1.28.x. Backups made
  by 2.0 use [archive format 2](backups.md#archive-format), which 1.28.x cannot
  restore. 2.0 still restores backups made by 1.x.
- **Codex MCP logins.** Managed Codex accounts now keep MCP OAuth tokens in their own
  profile instead of the macOS keychain. Sign in once more to each OAuth MCP server
  you used from a managed Codex account, under **Accounts → MCP servers** (see
  [Central MCP servers](mcp.md#central-mcp-servers-in-the-coding-clis)).
- **Lead agents instruct their members without approval.** Questions and tasks from
  a lead to its team members run without an approval prompt, and each member uses
  its own capabilities for them. Check your members' shell access and MCP servers
  after the update; see [Teams](agents.md#teams-asks-and-tasks).
- **Settings moved.** Settings has the tabs **Workspace**, **Access** and
  **Operations**; agent settings have **Profile**, **Capabilities**, **Work** and
  **Telegram**; **Accounts** groups **Model access**, **Services for agents**,
  **MCP servers** and **Native CLI accounts**. MCP servers for the coding CLIs moved
  from **Extensions** to **Accounts → MCP servers**. Navigation and **Sign out** are
  in the sidebar **Menu**. Old links and bookmarks still open the right page.
- **Backups capture less of the CLI profiles.** Profiles are copied by
  [allowlist](backups.md#cli-profile-allowlists), CLI conversation histories only
  into backups with a passphrase, and restored hook scripts need `chmod +x` again.
- **Removed HTTP routes.** `POST /api/accounts/:id/extensions/mcp` and
  `DELETE /api/accounts/:id/extensions/mcp/:name` are gone; scripts use
  `/api/mcp-servers` instead.

After 2.0.0, the 1.x line receives no further fixes, including security fixes.

Going back to 1.28.x under **Settings → Operations → Updates** remains possible and
keeps your data, with these limits:

- 2.0 backups cannot be restored there.
- Agent shell access, web, browser and document tools, bound MCP servers, the
  agents' own Telegram bots, check-ins, attachments and lead requests stop until you
  update again. Their data stays.
- Saving an agent's capabilities on 1.28.x drops its web, browser and document
  settings.
- If the agent service already runs OpenClaw 2026.9.9, agents' memory writes stay
  read-only on 1.28.x until you activate 2026.9.8 again under
  **Settings → Workspace → Agents → Agent service**.
- Once the agent service has committed the update to OpenClaw 2026.10.3, 2026.9.8
  can no longer be activated: its agent state database was migrated (see
  [Managed assistant runtime](#managed-assistant-runtime)).

## Stop and remove

```sh
npm run service:stop
```

This stops only the web service. If CLI sessions should also end, stop those sessions explicitly in the UI first.

To remove automatic startup completely after stopping the service:

```sh
rm "$HOME/Library/LaunchAgents/dev.agentpier.server.plist"
```

Disable your Tailscale exposure separately, using the port you actually configured:

```sh
tailscale serve --https=8443 off
```

Do not use `tailscale serve reset` if other exposures exist. Remove the project directory and profile data only if they are no longer needed. Old installations under the former name may use `dev.tuiui.server.plist`; stop such a service explicitly before switching so that two web services do not compete for the same port.

### Remove old versions

Under **Settings → Operations → Updates → Remove old versions**, older versions can be deleted individually or together. The confirmation lists the exact selection. Deleted versions are no longer available for rollback.

The active version, newer staged versions and versions with running processes are retained. If the existing `ps` process check cannot run reliably, nothing is deleted. Cleanup is locked during activation, rollback or session migration. It does not change session data or profiles.

#### Migrate sessions

For a version with running processes, **Show sessions** lists the AgentPier sessions holding it and their status: ready, busy, unknown, reloading or not reloadable. **Migrate sessions and delete version** reloads each session onto the active version using [Reload & resume](session-reload.md), then deletes the old version once the last session has migrated. Busy sessions migrate only after their current step finishes; sessions with an unknown state wait until the CLI is visibly ready. **Migrate now and delete** immediately restarts all sessions after confirmation, interrupting ongoing work. A running migration can be cancelled; reloads already initiated continue independently, and the version is retained.

Sessions that cannot be reloaded—pipeline, login, shell or unverified sessions—must be stopped manually. Processes outside a session, such as a running pipeline supervisor or release helper, block migration and are listed with their paths. Node processes that use only the version's Node binary do not block migration; they are checked again afterwards. If processes still use the version after migration, it is retained and the operation reports the remaining references.

When activating a staged version, the confirmation offers **Move running sessions to the new version afterwards**. Migration begins only after the new version passes its health check and does not interrupt work. If activation fails or is rolled back, no migration takes place.

### Managed assistant runtime

The assistant service is optional and off initially: until the owner turns on
**Settings → Workspace → Agents → Enable agents**, nothing is created, downloaded or started. Installations that
already used agents before this switch existed come back enabled. Enabling it provisions a
private OpenClaw 2026.10.3 installation and Node 26.7.0 under the data directory's
`assistants/runtimes/` directory. AgentPier itself retains its Node 22.13+ support.
Downloads are checked against pinned official Node checksums and npm package
integrity before activation. Failed staging preserves the previously selected runtime.
The release package includes the installer; no global OpenClaw or second daemon is
required. The runtime's dependencies are installed with lifecycle scripts disabled;
optional tools needing native builds are not qualified.

Provisioning paths:

- `agentpier-install --with-assistants` (or `scripts/install.sh … --with-assistants`)
  enables assistants and installs the runtime before the service starts. The
  installer, rerun on an installation with assistants enabled, provisions the
  runtime as well. A failed download never fails the AgentPier installation; the
  result reports `assistantRuntime.status: "failed"` with a code, and the runtime is
  installed on the first assistant start.
- After an AgentPier update, an installation with assistants enabled prepares the
  runtime the new version ships in the background through the same staging path
  and installation lock. AgentPier starts without waiting; the selection is not
  changed. Activation stays an owner action under Settings → Workspace → Agents → Agent service. With
  assistants disabled, nothing is downloaded.

Downloads are aborted only after 30 seconds without data, not after a total
duration, so slow links complete. Interrupted transfers and server errors are
retried up to three times with growing pauses (1, 2, 4 seconds); a retry resumes
with an HTTP range request only when the server sent a strong ETag or a
Last-Modified date, and otherwise starts again from the beginning. The small
release channel manifest is retried once; a stalled channel reports
`DOWNLOAD_IDLE_TIMEOUT`. AgentPier's own release
downloads use the same rules.

Proxies: run the installer in a shell where `HTTPS_PROXY`/`HTTP_PROXY` (either
case), `NO_PROXY`/`no_proxy` and, for a company CA, `NODE_EXTRA_CA_CERTS` are set.
No manual service edits are needed:

- The installer writes exactly these variables, plus `NODE_USE_ENV_PROXY=1`, into
  the launchd `EnvironmentVariables` or the systemd `Environment=` lines. No other
  variable of the shell is persisted. Rerunning the installer with changed proxy
  settings updates the service; a rerun from a shell without proxy variables keeps
  the settings the service already has.
- AgentPier passes the same set to `npm ci` and to the assistant Gateway.
- `localhost`, `127.0.0.1`, `::1` and `[::1]` are always added to `NO_PROXY` and
  `no_proxy`, so health checks and the Gateway connection never use the proxy.
- Node's built-in `fetch` honours the proxy on Node 22.21+ or 24+ (not on Node 23,
  and not on Node 22 before 22.21). The release bundles a suitable Node; if
  AgentPier runs on another Node while a proxy is set, downloads fail at once with
  `PROXY_REQUIRES_NEWER_NODE` instead of bypassing the proxy. When a proxy is set,
  the installer does not use such a system Node; it downloads its own pinned Node
  instead.
- Behaviour change: this also applies to AgentPier's own self-update downloads.
  An installation that runs on Node 22.13 to 22.20 behind a proxy now stops an
  update download with `PROXY_REQUIRES_NEWER_NODE` instead of trying a direct
  connection. Upgrade the Node that runs AgentPier to 22.21+ or 24+.

**The update to OpenClaw 2026.10.3 cannot be undone once committed.** It migrates
the agent service's state database (schema 19 to 20), and OpenClaw 2026.9.9 and
2026.9.8 refuse the migrated database. If activation fails before the update is
committed, AgentPier rolls back to the snapshot it took beforehand. After commit,
neither **Settings → Workspace → Agents → Agent service** nor an older AgentPier
can return the agent service to 2026.9.x. Create a host backup under
**Settings → Operations → Backups** before you activate 2026.10.3.

For isolated diagnostics, the same installer is available as
`node scripts/install-assistant-runtime.mjs --data-dir /absolute/disposable/path`.
This installs the runtime only; it does not enable or start a service.

### Toolchains for MCP server packages

AgentPier installs MCP server packages from npm and PyPI with its own pinned
toolchains under the data directory's `toolchains/` directory: Node 26.7.0 with npm
11.19.0, uv 0.12.21 and CPython 3.14.7 (python-build-standalone 20260929). They are
separate from the agents' OpenClaw runtime and need no agents. Every archive is
checked against a SHA-256 pinned in AgentPier before it is unpacked. AgentPier
unpacks the verified CPython archive itself and records the toolchain folder in
CPython's build configuration (sysconfig); uv never downloads Python. Nothing is
installed globally, and your own npm, pip or uv configuration is never read.

The installer provisions both toolchains; a failed download never fails the
installation (the result reports `toolchains.<kind>.status: "failed"` with a code),
and the first package install retries. After an AgentPier update with new pins, the
new toolchains are prepared in the background. Supported: macOS and Linux (glibc) on
arm64 and x64; other hosts report `MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE`.

A toolchain that fails verification is never repaired automatically; package
installs report `MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE`. Delete the affected folder under
`<data>/toolchains/` (for example `node-v26.7.0-linux-x64`) and AgentPier reinstalls it
on next use.

Once no packaged MCP server and no running install uses an older toolchain version,
AgentPier removes its folder (at start, after each install and after a server is
removed); the current pins always stay. How packages are installed:
[MCP](mcp.md#installing-a-server-package).

### Assistant qualification in a source checkout

The optional assistant service is configured under **Settings → Workspace → Agents**;
create agents under **Agents** in the sidebar menu, then use their direct sidebar chats. Agents use
the model connections and ChatGPT accounts configured in AgentPier (OpenRouter,
Ollama, llama.cpp, generic and Azure OpenAI-compatible endpoints; see
[model connections](assistant-model-connections.md)).
For an isolated runtime probe, use
`node scripts/verify-assistant-runtime.mjs --data-dir /absolute/empty-directory`.
See [Assistant Gateway](assistant-gateway.md#implemented-foundation)
for recovery behavior and current capability limits. Do not use live application
data for this probe.
