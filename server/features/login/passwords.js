import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const derive = promisify(scrypt);

export const hashPassword = (password, salt) =>
  derive(password, salt, 64, { N: 32768, maxmem: 64 * 1024 * 1024 });

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

export async function verifyPassword(password, { salt, hash }) {
  if (typeof password !== "string" || password.length > 1024) return false;
  const derived = await hashPassword(password, salt);
  return timingSafeEqual(derived, Buffer.from(hash, "hex"));
}
