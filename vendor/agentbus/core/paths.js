import os from 'node:os';
import path from 'node:path';

export function home(env = process.env) {
  return env.AGENTBUS_HOME || path.join(os.homedir(), '.agentbus');
}
export function claudeSessionsDir(env = process.env) {
  return env.AGENTBUS_CLAUDE_SESSIONS_DIR || path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'sessions');
}
export const peersDir = (h) => path.join(h, 'peers');
export const inboxRoot = (h) => path.join(h, 'inbox');
export const inboxDir = (h, key) => path.join(h, 'inbox', key);
export const pendingDir = (h, key) => path.join(inboxDir(h, key), 'pending');
export const doneDir = (h, key) => path.join(inboxDir(h, key), 'done');
export const peerKey = (runtime, sessionId) => {
  if (!['claude','codex','opencode'].includes(runtime) || typeof sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,239}$/.test(sessionId)) throw new Error('agentbus: invalid peer identity');
  return `${runtime}-${sessionId}`;
};
// Ein opencode-Prozess bedient mehrere Sessions ueber EINEN MCP-Server. Die PID allein sagt
// dann nicht, welche Session gerade fragt; das Plugin hinterlegt sie hier.
export const activeDir = (h) => path.join(h, 'active');
export const activeFile = (h, pid) => path.join(activeDir(h), String(pid));

// Socket-Verzeichnis bewusst unter /tmp statt unter home(): macOS begrenzt
// Unix-Pfade auf rund 104 Zeichen, und os.tmpdir() ist hier ein langer
// /var/folders/…-Pfad. Claude Code hält /tmp/cc-socks/ aus demselben Grund.
export function socketDir(env = process.env) {
  if (env.AGENTBUS_SOCKET_DIR) return env.AGENTBUS_SOCKET_DIR;
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return `/tmp/agentbus-${uid}`;
}
export const socketPath = (pid, env = process.env) => path.join(socketDir(env), `${pid}.sock`);
