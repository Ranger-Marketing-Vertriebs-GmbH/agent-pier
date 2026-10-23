import { sftpProblem } from "./sftp-errors.js";
import { sftpLimits } from "./sftp-limits.js";

// NUL, C0/C1 controls, line and paragraph separators and backslashes never reach the
// server: they hide names in listings and approval cards or mean different things to
// different servers.
const unsafe = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\\]/;
const refused = () => sftpProblem("SFTP_PATH_REFUSED");

function checked(raw) {
  if (typeof raw !== "string" || raw.length > sftpLimits.pathChars || unsafe.test(raw))
    throw refused();
  return raw;
}

/**
 * The absolute remote path for `raw`: relative paths join `base`, `.` and `..` are
 * collapsed lexically and climbing above `/` is refused (`SFTP_PATH_REFUSED`).
 */
export function remotePath(raw, base = "/") {
  if (!checked(base).startsWith("/")) throw refused();
  const joined = checked(raw).startsWith("/") ? raw : `${base}/${raw}`;
  const parts = [];
  for (const part of joined.split("/")) {
    if (!part || part === ".") continue;
    if (part !== "..") parts.push(part);
    else if (!parts.length) throw refused();
    else parts.pop();
  }
  return checked(`/${parts.join("/")}`);
}

/** Whether the normalised absolute path `p` is `root` or below it. */
export function insideRoot(root, p) {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return p === root || p.startsWith(prefix);
}

async function resolveDeepest(session, p) {
  const missing = [];
  let current = p;
  for (;;) {
    try {
      const real = await session.realpath(current);
      return missing.length ? `${real.replace(/\/$/, "")}/${missing.join("/")}` : real;
    } catch (error) {
      if (error?.code !== "SFTP_NOT_FOUND" || current === "/") throw error;
    }
    const cut = current.lastIndexOf("/");
    missing.unshift(current.slice(cut + 1));
    current = current.slice(0, cut) || "/";
  }
}

/**
 * Confines the normalised path `p` to the host's allowed remote folder: the server
 * resolves the deepest existing ancestor (symbolic links included), the missing names
 * are joined to it, and the result must stay inside the resolved `root`. Returns the
 * resolved path; without a `root` returns `p` unchanged.
 */
export async function confineRemote(session, p, root) {
  if (root === null || root === undefined) return p;
  if (!insideRoot(root, p)) throw refused();
  const [realRoot, real] = [
    await resolveDeepest(session, root),
    await resolveDeepest(session, p),
  ];
  if (!insideRoot(realRoot, real)) throw refused();
  return real;
}
