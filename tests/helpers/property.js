import fc from "fast-check";

/** fast-check reports the seed and minimized replay path on failure. */
export function propertyParameters(overrides = {}) {
  const seed = Number(process.env.FC_SEED ?? 20260906);
  const numRuns = Number(process.env.FC_RUNS ?? overrides.numRuns ?? 100);
  if (
    !Number.isInteger(seed) ||
    !Number.isInteger(numRuns) ||
    numRuns < 1 ||
    numRuns > 10000
  ) {
    throw new Error("FC_SEED must be an integer; FC_RUNS must be between 1 and 10000.");
  }
  return {
    ...overrides,
    seed,
    numRuns,
    ...(process.env.FC_PATH ? { path: process.env.FC_PATH } : {}),
  };
}

export function check(property, options) {
  return fc.assert(property, propertyParameters(options));
}

export const characters = (alphabet, constraints = {}) =>
  fc.array(fc.constantFrom(...alphabet), constraints).map((parts) => parts.join(""));

export const publicId = fc
  .tuple(
    fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"),
    characters("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-", {
      minLength: 0,
      maxLength: 79,
    }),
  )
  .map(([first, rest]) => first + rest);

export const dnsLabel = characters("abcdefghijklmnopqrstuvwxyz0123456789", {
  minLength: 1,
  maxLength: 30,
});
