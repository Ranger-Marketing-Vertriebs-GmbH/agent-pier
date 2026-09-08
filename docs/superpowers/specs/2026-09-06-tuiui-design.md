# TUIUI design

A local, single-owner web workspace for installed Codex, Claude Code and OpenCode CLIs. User explicitly authorizes autonomous implementation, tests and Tailscale access, with no damage to existing projects/accounts. Empty project: build on a dedicated feature branch in place. A local Node service is required because hosted Cloudflare Sites cannot own local PTYs; no Sites project is created.

## Requirements

- Detect available CLI executables; absent providers remain visible and disabled. Never install or modify those CLIs automatically.
- Create, rename and delete multiple account profiles with independent config/auth directories. Native login runs in a visible terminal. API keys are saved in private files and never returned by API. Existing local accounts can be used explicitly via built-in local profiles; defaults are not rewritten or logged out. Claude config AND secure storage namespace are isolated.
- Create named sessions in an existing chosen directory. Each uses a private dedicated tmux server, a real PTY and xterm.js, with full ANSI, mouse, keys, resizing, scrollback and reconnect. Sessions survive browser disconnection and web-server restart. Normal CLI permission prompts remain intact. Stop targets only owned sessions; exited sessions retain readable output. Deletion requires stopped session.
- Responsive, German UI: session navigation, account management, launch dialog, tool detection, connection state, readable terminal, and mobile keyboard toolbar. Mobile reader uses live terminal text plus a chat-like composer for all providers. All tool output and permissions remain accessible through the full terminal; the reader does not fabricate structured events or silently autoapprove.
- Loopback-only HTTP. Host and Origin checks protect API and websocket. Tailscale Serve HTTPS access is restricted to configured owner identity. No public Funnel, no replacing unrelated Serve configuration.
- macOS LaunchAgent restarts web service after failure/login; tmux sessions independent. Computer must stay awake for remote use. OS reboot ends processes; retained session metadata is marked stopped, never automatically reruns tasks.
- Meaningful unit/integration tests for profile isolation, secret redaction, validation, auth, PTY/reconnect/restart, safe stopping, plus desktop/mobile browser interaction tests and installed CLI startup checks.

## Interfaces

GET /api/state -> {tools:[{id,name,installed,path}],accounts:[{id,name,tool,kind,hasSecret,createdAt}],sessions:[{id,name,tool,accountId,cwd,status,createdAt,exitCode?}],home,remoteUrl}
POST /api/accounts {name,tool,apiKey?} -> account; PATCH/DELETE /api/accounts/:id.
POST /api/accounts/:id/login -> session. Native local profiles cannot login/logout from management.
POST /api/sessions {name,accountId,cwd} -> session; POST /api/sessions/:id/stop; DELETE /api/sessions/:id; PATCH /api/sessions/:id {name}.
GET /api/sessions/:id/screen -> {text}; POST /api/sessions/:id/input {text,submit:boolean}; GET /api/directories?path= -> {path,parent,entries:[{name,path}]}.
WS /api/sessions/:id/terminal same-origin JSON messages: client {type:'input',data}, {type:'resize',cols,rows}; server {type:'output',data}, {type:'status',status}, {type:'error',message}. Reattach via a fresh tmux client replays full screen. Disconnect detaches client only.

SessionManager({dataDir,tmuxPath?}) async create({id,name,tool,accountId,cwd,command,args,env}) -> session; list() -> sessions; get(id) -> session; stop(id), remove(id), rename(id,name), screen(id)->string, input(id,text,submit); attach(id,{cols,rows,onData,onExit}) -> {write,resize,dispose}; close() detaches web clients only. Persist metadata privately inside dataDir. All methods may be awaited. Inputs must validate before process launch.
