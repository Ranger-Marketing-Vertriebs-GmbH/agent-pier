<a id="github-zugänge-für-agenten"></a>

# GitHub connections for agents

Under **Settings → Access → GitHub connections** each token is saved with its HTTPS host, for example `github.com`, `company.ghe.com` or your own GitHub Enterprise Server host. Several profiles may use the same host. Exactly one profile per host is marked **Default for agents**; the first profile on a host takes that role automatically.

<a id="auswahl-beim-sitzungsstart"></a>

## Selection at session start

New Codex, Claude Code and OpenCode sessions receive the default connection of every supported host. When the working directory lies in a project cloned with AgentPier, the connection chosen at clone time wins for the repository's original host. With nested projects the nearest project applies. A token profile that has since moved to another host does not override a different host's assignment. Login sessions only sign a CLI in and receive no GitHub access.

<a id="shell-sessions"></a>

Shell sessions are the owner's own terminal and change less. `gh`, `GH_CONFIG_DIR` and token variables such as `GH_TOKEN` stay as the owner set them, so `gh` in a shell keeps the owner's own login. Only git gets the AgentPier helper, and only for the hosts with a selected profile (and their gist hosts); it finds the session's files through a `--session <folder>` argument instead of `GH_CONFIG_DIR`. Every other host keeps the owner's own git helpers, `gh auth git-credential` included. A shell without a selected profile gets no changes at all.

The selected profile IDs stay with the session. A changed default applies to new sessions; token rotation and deletion also update the configuration of sessions that already run. A deleted profile, or one moved to another host, is disabled there: AgentPier writes a fixed invalid placeholder for that host so that `gh` cannot silently fall back to another login from the system keychain, and the git credential helper answers with an explanation instead of a token (see [Helper messages](#helper-messages)). A profile added afterwards has a new ID, so a running session uses it only after a reload.

Without a selected connection — no default for agents and no project assignment — `GH_CONFIG_DIR` still points to the session configuration with an empty `hosts.yml`: `gh` is signed out in the session and does not use the owner's own login. git then gets no AgentPier helper and keeps asking the owner's own helpers for every host.

<a id="stable-helper"></a>

### The helper across updates

git starts the helper through the `GIT_CONFIG_*` values a session received at its start, and a running process keeps those values. An installed AgentPier therefore starts the helper through the install root's `current` link, for example `~/.local/share/agentpier-app/current/bin/node ~/.local/share/agentpier-app/current/server/github-credentials.js --git-credential`. Every update moves `current` to the release it activates, and release cleanup never removes the active release, so the helper and its Node runtime always come from the active release; the session files it reads keep their format across releases. A source checkout keeps its own Node and repository paths, because no update replaces them.

Rolling back to a release from before this change keeps running sessions working, but sessions started under that release again name their own release directory and get no `gist.<host>` helper entries; `gist.<host>` then falls back to the owner's own git helpers.

Sessions started by an earlier release still name their own release directory. While such a session runs, its terminal launcher runs from that release, so release cleanup lists the release as in use and keeps it. Reloading the session — also the reload that moves sessions off an old release before cleanup — switches it to the stable path. If such a release is removed anyway, git stops with `told us to quit` for that host; reload the session.

<a id="verwendung"></a>

## Usage

In the project the agent can for example run:

```sh
gh pr list
gh issue list
git fetch
git push
```

For an explicitly chosen Enterprise host:

```sh
gh api --hostname company.ghe.com user
gh repo view company.ghe.com/team/project
```

What is actually possible depends on the permissions of the saved token. AgentPier does not extend them. It sets no shared `GH_TOKEN` or `GH_ENTERPRISE_TOKEN` variables that could mask different host connections, and no forced `GH_HOST` or `GH_REPO`. git gets its own helper only for the configured HTTPS hosts and their gist hosts; the global git configuration is kept.

For a selected host, AgentPier replaces the helper list of `credential.https://<host>.helper` and `credential.https://gist.<host>.helper` through `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`. The owner's own helpers such as `osxkeychain` or `gh auth git-credential` are deliberately not asked for these hosts, so no other account steps in, and `gh auth git-credential` from a global `~/.gitconfig` cannot fail silently against the session's gh folder. `gist.<host>` uses the token of the host's selected profile. After the AgentPier helper follows a second entry that only reports `quit=1`. git asks it only when the AgentPier helper returned no token or could not start, and then stops at once instead of waiting for a user name in the agent's terminal. A global `credential.interactive=false` or `GIT_TERMINAL_PROMPT=0` would also switch off prompts for other hosts, and git ignores the URL-scoped `credential.<url>.interactive`.

The helper reads the git credential protocol as git 2.46 and later sends it: multi-valued attributes such as `capability[]` and `wwwauth[]` are skipped and no capabilities are announced; duplicate single attributes such as `host` or `protocol` reject the request. The helper starts through `server/github-credentials.js` and loads only Node built-ins and small local modules, no npm packages.

<a id="ssh-remotes"></a>

### SSH remotes

Tokens apply to HTTPS only. A project whose `origin` is an SSH remote (`git@github.com:owner/repo.git` or `ssh://…`) authenticates with the owner's SSH keys, and the session's GitHub profile does not take part. The session footer names the session's GitHub profiles and shows a hint when the project remote uses SSH. To use the token, switch the remote to HTTPS, for example `git remote set-url origin https://github.com/owner/repo.git`. `gh` itself uses the token for API calls either way.

<a id="helper-messages"></a>

### Helper messages

When the helper has no token for a request, it writes one line to git's error output before git stops, in the form `AgentPier GitHub access: <cause> — <fix>`. The messages are diagnostic output and stay in English:

| Cause                                                                       | Fix                                                                            |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| the process is not an AgentPier session (`GH_CONFIG_DIR` is not set)        | start or reload the session in AgentPier                                       |
| the session folder is missing, or its `selection.json` is unreadable        | reload the session                                                             |
| no GitHub profile is selected for the host in this session                  | mark a profile as default for agents or assign one to the project, then reload |
| the session's `hosts.yml` cannot be read                                    | reload the session                                                             |
| the profile for the host was removed, moved to another host or has no token | save a token for the host, then reload the session                             |

git never prompts for a user name in these cases.

<a id="commit-identität-pro-token"></a>

### Commit identity per token

A token profile can optionally save a **commit name** and a **commit email**. Fill in or clear both fields together. They are git's author and committer details; the GitHub account and its permissions are still determined by the token alone.

When a coding session starts or reloads, AgentPier uses the identity of the connection assigned to the project. Without a project assignment it is used only when exactly one host connection is selected. With several hosts the existing git identity is kept instead of picking a connection arbitrarily. Empty identity fields also leave the existing git settings unchanged.

The identity applies to git processes inside this session, also after a directory change. To work under another identity, start a session in the project assigned to it. Global and local git configuration files are not changed. Changes to the name or email apply at the next session start or reload; plain token rotation keeps the saved identity.

<a id="token-check"></a>

## Token check

**Check** next to a profile calls the host's API with the saved token from the AgentPier server: `GET https://api.github.com/user` for github.com, `https://api.<tenant>.ghe.com/user` for GitHub Enterprise Cloud with data residency and `https://<host>/api/v3/user` for GitHub Enterprise Server. The list then shows:

- the state: **Token valid**, **Token expires soon** (within seven days), **Token expired**, **Token rejected** or **Check failed** with the reason (unreachable host, rate limit, denied access);
- the GitHub login the token belongs to;
- the token type by its documented prefix: classic (`ghp_`), fine-grained (`github_pat_`), OAuth (`gho_`) or GitHub App (`ghu_`, `ghs_`);
- the scopes of a classic token from GitHub's `X-OAuth-Scopes` header; fine-grained tokens have per-repository permissions that GitHub does not report here;
- the expiry date from the `github-authentication-token-expiration` header, or **No expiry date**;
- SAML SSO: for up to five projects cloned with this profile, AgentPier asks GitHub for the repository. When an organization answers with `X-GitHub-SSO: required`, the list names the organization and links to GitHub's authorization page for the token.

The token never appears in the response, the list or logs; only these results are saved with the profile. A new token or host clears the last result.

Once a day the server checks every saved token whose last check is older than a day, beginning a few minutes after start. When a token turns invalid, expires or comes within seven days of expiry, the list shows it and the owner receives the **Check GitHub token** [notification](notifications.md); an unchanged state is not announced again. Opening the notification opens **GitHub connections**.

<a id="private-dateien"></a>

## Private files

The generated files live under `github-sessions/<AgentPier session ID>/` in the data directory:

- `config.yml`: native schema with `version: 1`, so `gh` migrates no old configuration and asks no extra questions for it. When the selection metadata is damaged or missing, AgentPier replaces the file with a value without an object root, which every `gh` version rejects as an invalid configuration, and then removes every token from `hosts.yml`.
- `hosts.yml`: host assignment and token; JSON-compatible YAML, mode 0600.
- `selection.json`: selected profile IDs and hosts, without tokens.

The folders are 0700. Tokens do not appear in process arguments, session metadata or API responses. A web service restart keeps the assignment and synchronizes the saved tokens again. The helper only reads these files and writes to no credential manager.

`GH_CONFIG_DIR` separates the configuration files. It is no operating-system isolation: programs of the same user keep that user's file permissions, and native `gh` calls for entirely different, unconfigured hosts can still use an existing keychain login.

The GitHub CLI supports only hosts without their own port here. API aliases of `github.com` or `ghe.com` are not passed on as independent hosts, because `gh` normalizes them. Such existing profiles stay available for direct HTTPS clones.

Sandboxed sessions get read access to the install root's `current` link and its `releases/` directory, so the helper still starts after an update; see [sandbox grants](sandbox.md#the-grant-model).

<a id="installation-und-prüfung"></a>

## Installation and tests

Under **Your tools → GitHub CLI** the official `cli/cli` release for macOS or Linux on x64/ARM64 can be installed. AgentPier verifies the release checksum, limits the download and unpacked size and takes over only the binary and the license. A version check and atomic activation in the private `clis/gh/` directory follow. Existing installations take precedence; npm and sudo are not needed for `gh`.

Installer tests use temporary release archives. Credential tests cover host and project selection, rotation and removal, file permissions and symlinks, helper messages, gist hosts and a session that keeps its credentials after a simulated release switch and cleanup. A real `gh auth token` and `git credential fill` additionally check the generated configuration with an isolated HOME, test tokens and blocked network; no real GitHub account is contacted. `git credential fill` receives the `capability[]` and `wwwauth[]` lines of current git versions, and a recorded `GIT_ASKPASS` proves that git requests no input for revoked connections or a helper that cannot start. The token check runs against a local fake GitHub API.

Sources: [GitHub CLI environment](https://cli.github.com/manual/gh_help_environment), [GitHub CLI login](https://cli.github.com/manual/gh_auth_login), [git credential protocol](https://git-scm.com/docs/gitcredentials), [GitHub REST API authentication](https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api), [SAML SSO and the REST API](https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api#using-personal-access-tokens), [official release configuration](https://github.com/cli/cli/blob/trunk/.goreleaser.yml).

<a id="permanent-agents"></a>

## Permanent agents

Permanent agents use these token profiles too: in an agent's **Work** tab, **GitHub** chooses the level (**Read** or **Read and write**) and a profile, preselected with the **Default for agents**. The agent then gets the official GitHub MCP server with that profile and, with shell access, its own folder `github-sessions/agent-<agent-id>/` in the same layout as a session, so `gh` and `git` in its commands use this profile instead of the owner's login. Its git helper is started with `--session` and that folder, like an owner shell's. Rotation and deletion work there the same way. Details are in [GitHub for agents](assistant-gateway.md#github-for-agents).
