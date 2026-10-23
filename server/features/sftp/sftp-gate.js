import { isSftpProblem, sftpProblem } from "./sftp-errors.js";

export const AUTHORIZE_EVERY_MS = 2000;

/** The stable code for an error a transfer or delete stopped on. */
export function problemCode(error) {
  if (isSftpProblem(error)) return error.code;
  if (error?.status === 403) return "SFTP_PATH_REFUSED";
  if (error?.code === "EISDIR" || error?.code === "ENOTDIR") return "SFTP_TYPE_CONFLICT";
  if (error?.code === "EACCES" || error?.code === "EPERM") return "SFTP_PERMISSION";
  return "SFTP_FAILED";
}

/**
 * Stops a running transfer or delete: the caller's `signal` cancels, and
 * `stillAuthorized` — awaited by `check()` before each step and every `everyMs`
 * meanwhile — revokes when it answers false or throws. `signal` aborts the work.
 */
export class SftpGate {
  #controller = new AbortController();
  #outer;
  #cancel = () => this.stop("cancelled");
  #timer = null;
  #stillAuthorized;
  ended = null;

  constructor({ signal, stillAuthorized, everyMs = AUTHORIZE_EVERY_MS } = {}) {
    this.#outer = signal;
    this.#stillAuthorized = stillAuthorized;
    if (signal?.aborted) this.#cancel();
    signal?.addEventListener("abort", this.#cancel, { once: true });
    if (!stillAuthorized) return;
    let checking = false;
    this.#timer = setInterval(async () => {
      if (checking || this.ended) return;
      checking = true;
      await this.#ask();
      checking = false;
    }, everyMs);
    this.#timer.unref?.();
  }

  get signal() {
    return this.#controller.signal;
  }

  stop(state) {
    if (this.ended) return;
    this.ended = state;
    this.#controller.abort(sftpProblem("SFTP_CANCELLED"));
  }

  async #ask() {
    let allowed = false;
    try {
      allowed = Boolean(await this.#stillAuthorized());
    } catch {
      allowed = false;
    }
    if (!allowed) this.stop("revoked");
  }

  /** Before each step: throws once cancelled or no longer authorized. */
  async check() {
    this.signal.throwIfAborted();
    if (this.#stillAuthorized) await this.#ask();
    this.signal.throwIfAborted();
  }

  /** The end state and code for an error the work stopped on. */
  outcome(error) {
    if (this.ended === "cancelled") return { state: "cancelled", code: "SFTP_CANCELLED" };
    if (this.ended === "revoked") return { state: "revoked" };
    return { state: "failed", code: problemCode(error) };
  }

  close() {
    clearInterval(this.#timer);
    this.#outer?.removeEventListener("abort", this.#cancel);
  }
}
