import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const derive = promisify(scrypt);

/** Runs at most `limit` calls of `run` at once; further calls wait their turn. */
export function limited(run, limit) {
  let running = 0;
  const waiting = [];
  return async (...args) => {
    // A finished call hands its place straight to the next waiting one.
    if (running >= limit) await new Promise((resolve) => waiting.push(resolve));
    else running++;
    try {
      return await run(...args);
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  };
}

// Each hash takes 32 MiB and a thread of the pool that file and DNS work share, so at
// most two run at once, whoever asks. The attempt windows bound how many can wait.
export const hashPassword = limited(
  (password, salt) => derive(password, salt, 64, { N: 32768, maxmem: 64 * 1024 * 1024 }),
  2,
);

export const newSalt = () => randomBytes(32).toString("hex");

export const validPassword = (value) =>
  typeof value === "string" && value.length >= 12 && value.length <= 1024;

export const validUsername = (value) =>
  typeof value === "string" &&
  Boolean(value.trim()) &&
  value.trim().length <= 100 &&
  !/[\x00-\x1f\x7f]/.test(value);

export const validCredential = (credential) =>
  /^[a-f0-9]{64}$/.test(credential?.salt) && /^[a-f0-9]{128}$/.test(credential?.hash);

// Unknown names verify against this record, so they take as long as a real check.
export const dummyCredential = Object.freeze({
  salt: "0".repeat(64),
  hash: "0".repeat(128),
});

export async function verifyPassword(password, { salt, hash }, derive = hashPassword) {
  if (typeof password !== "string" || password.length > 1024) return false;
  const derived = await derive(password, salt);
  return timingSafeEqual(derived, Buffer.from(hash, "hex"));
}
