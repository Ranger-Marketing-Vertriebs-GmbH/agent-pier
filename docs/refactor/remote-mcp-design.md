# Remote MCP design

The user approved HTTPS MCP on the Mac mini for Codex, Claude Code and OpenCode running on their own computer, with per-CLI setup help in Settings. No standalone AgentPier terminal CLI or stdio transport is requested.

## User outcome

Settings → MCP & Access exposes the configured HTTPS MCP URL, copyable setup instructions for each CLI, a browser consent view, and paginated connected-client grants with revocation. Existing Tailscale owner authentication remains the browser administrator identity; no new password account is introduced. MCP tokens are separate from provider credentials. The remote host stays private to the tailnet. Without configured remote access, local instances advertise `http://127.0.0.1:<actual-port>/mcp`; OAuth remains required. HTTP is permitted only on loopback with an explicit port, never on LAN hosts. A configured HTTPS origin is never downgraded after a connection failure.

Agents can discover permitted projects/accounts/providers/models, create and update pipeline profiles and definitions, validate definitions, start durable runs, read progress/evidence and cancel their own authorized runs. Human approval gates are not exposed as agent tools. A grant explicitly controls projects, source accounts, provider connections and action scopes. Publication requires a separate scope checked against the frozen graph. Denied resources are excluded from listings as well as individual reads.

## Architecture

Use the official MCP JavaScript SDK with Streamable HTTP at `/mcp`. A fresh stateless transport handles each request, while run and authorization state live in AgentPier. MCP tools call a shared application facade wrapping existing definition and execution services; they do not instantiate another pipeline engine or write its files. Long runs return a durable run ID and UI link immediately. Start idempotency is durable and grant-scoped; ambiguous interrupted starts must not be blindly repeated.

OAuth authorization-code flow uses mandatory S256 PKCE, exact registered callback matching, resource/audience binding, one-use expiring codes, expiring opaque tokens, refresh rotation/reuse detection and revocation. Metadata, dynamic public-client registration and token exchange are machine endpoints with dedicated transport guards. No arbitrary client metadata URL fetching is needed. Browser consent uses existing owner authentication and strict same-origin mutation protection. Client names/URLs are untrusted display data. Tokens/code verifiers/provider keys never enter audit logs, URLs or help commands; the authorization response code is used only in the standard registered OAuth callback.

Authorization records use private durable storage and are excluded from ordinary backups/restores. API requests bearing MCP tokens cannot fall through to unrestricted owner APIs. The existing trusted local OS user and Tailscale owner remain administrators; MCP scopes are not an OS sandbox against an administrator who can access server files or impersonate its existing owner interface. Non-owner tailnet clients require an owner-approved MCP grant and cannot access browser administration.

## Provider profiles

Pipeline profiles gain the same source-account versus central-provider selection as session start. CLI ownership, model catalogs/context limits, frozen account/provider identity, credential rotation and history retention remain enforced. Legacy profiles are valid without migration. Snapshot semantics ensure editing a profile or switching a provider cannot silently change an in-flight run.

## Boundaries and verification

English code and comments, German locale copy, files below 600 lines, dark/orange responsive UI and URL-deep-linked state. Tests use isolated temporary data, projects and synthetic CLIs. Cover real OAuth HTTP exchanges, bad PKCE/audience/redirect/replay/expiry/revocation, non-owner consent denial, privilege and project isolation, reconnect/double-start/restart behavior, profile/provider/CLI matrices, and desktop/mobile setup and consent. Verify supported CLI configuration syntax using current official docs and existing local binaries, with no global install or user-config overwrite. Deploy the verified release through the existing updater; preserve user data/native sessions.
