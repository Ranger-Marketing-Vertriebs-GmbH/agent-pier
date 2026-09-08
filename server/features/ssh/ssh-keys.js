import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { problem } from "../../lib/storage.js";

export const runOpenSsh = promisify(execFile);
export const processOptions = {
  encoding: "utf8",
  timeout: 15000,
  maxBuffer: 65536,
  env: { ...process.env, SSH_ASKPASS_REQUIRE: "never" },
};

export function validateFields(input, allowed) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !allowed.includes(key))
  )
    throw problem("Invalid SSH access fields.");
}

export function endpoint(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw problem("Invalid SSH host or port.");
  const { host, username } = input;
  const port = input.port === undefined ? 22 : Number(input.port);
  if (
    typeof host !== "string" ||
    host.length > 253 ||
    (!isIP(host) &&
      !/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host)) ||
    (!isIP(host) &&
      host
        .split(".")
        .some(
          (part) =>
            !part || part.length > 63 || part.startsWith("-") || part.endsWith("-"),
        )) ||
    !["number", "string"].includes(typeof (input.port ?? 22)) ||
    (typeof input.port === "string" && !/^\d+$/.test(input.port)) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw problem("Invalid SSH host or port.");
  if (
    username !== undefined &&
    (typeof username !== "string" || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$/.test(username))
  )
    throw problem("Invalid SSH username.");
  return { host, port, ...(username === undefined ? {} : { username }) };
}

export function publicKeyValue(value) {
  if (typeof value !== "string" || value.length > 16384 || /[\x00-\x1f\x7f]/.test(value))
    throw problem("Invalid SSH public key.");
  const parts = value.trim().split(/ +/);
  if (
    !/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521))$/.test(parts[0]) ||
    !/^[a-zA-Z0-9+/]+={0,2}$/.test(parts[1] || "")
  )
    throw problem("Invalid SSH public key.");
  return `${parts[0]} ${parts[1]}`;
}

export async function fingerprint(publicKey, directory, run = runOpenSsh) {
  const file = path.join(directory, `verify-${randomUUID()}.pub`);
  try {
    fs.writeFileSync(file, `${publicKey}\n`, { mode: 0o600, flag: "wx" });
    const { stdout } = await run(
      "ssh-keygen",
      ["-l", "-E", "sha256", "-f", file],
      processOptions,
    );
    const result = stdout.match(/^\d+ (SHA256:[A-Za-z0-9+/]+) /)?.[1];
    if (!result) throw new Error();
    return result;
  } catch {
    throw problem("Invalid SSH public key.");
  } finally {
    fs.rmSync(file, { force: true });
  }
}

export async function prepareIdentity(directory, privateKey, run = runOpenSsh) {
  const file = path.join(directory, "identity");
  try {
    if (privateKey !== undefined) {
      if (
        typeof privateKey !== "string" ||
        privateKey.length > 65536 ||
        !privateKey.trim() ||
        privateKey.includes("\0")
      )
        throw new Error();
      fs.writeFileSync(file, privateKey, { mode: 0o600, flag: "wx" });
    } else {
      await run(
        "ssh-keygen",
        ["-q", "-t", "ed25519", "-N", "", "-C", "agentpier", "-f", file],
        processOptions,
      );
    }
    fs.chmodSync(file, 0o600);
    const { stdout } = await run(
      "ssh-keygen",
      ["-y", "-P", "", "-f", file],
      processOptions,
    );
    const publicKey = publicKeyValue(stdout.trim());
    fs.writeFileSync(`${file}.pub`, `${publicKey}\n`, { mode: 0o600 });
    fs.chmodSync(`${file}.pub`, 0o600);
    return { publicKey, fingerprint: await fingerprint(publicKey, directory, run) };
  } catch {
    throw problem(
      "SSH key could not be prepared. Import an unencrypted private key or generate a new key.",
    );
  }
}
