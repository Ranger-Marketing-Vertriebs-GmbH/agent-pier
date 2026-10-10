/**
 * Assistant services built for the application graph are constructed first and
 * connected in one step afterwards. A service marked here refuses to run before that
 * step has supplied every reference it needs, instead of failing later on `undefined`.
 * Services constructed on their own (tests, tools) are never marked and stay usable.
 */
export const ASSISTANT_WIRING_INCOMPLETE = "ASSISTANT_WIRING_INCOMPLETE";
const pending = Symbol("assistantWiring");

function incomplete(name, missing) {
  return Object.assign(
    Error(`Assistant service ${name} is not connected: ${missing.join(", ")}.`),
    { code: ASSISTANT_WIRING_INCOMPLETE },
  );
}
const absent = (value) => value === undefined || value === null;

/** Declares the references the connect step must supply before first use. */
export function expectWiring(service, name, references) {
  service[pending] = { name, references };
  return service;
}

/** Throws an explicit wiring error naming every absent reference. */
export function requireReferences(name, references) {
  const missing = Object.keys(references).filter((key) => absent(references[key]));
  if (missing.length) throw incomplete(name, missing);
}

/** Assigns references after verifying each one; throws before assigning anything. */
export function wire(service, name, references) {
  requireReferences(name, references);
  Object.assign(service, references);
  assertWired(service);
  return service;
}

/** Called at a service's entry points; a no-op once connected or when unmarked. */
export function assertWired(service) {
  const expected = service[pending];
  if (!expected) return;
  const missing = expected.references.filter((key) => absent(service[key]));
  if (missing.length) throw incomplete(expected.name, missing);
  delete service[pending];
}
