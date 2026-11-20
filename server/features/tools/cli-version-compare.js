// CLI version comparison without Node built-ins, shared by the server (cli-version.js)
// and the browser (the chat's outdated-CLI notice).

const triple = (version) => {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(typeof version === "string" ? version : "");
  return match ? match.slice(1).map(Number) : null;
};

/** Whether `version` starts with `major.minor.patch`. */
export const isCliVersion = (version) => triple(version) !== null;

/** Whether `version` is `minimum` or newer; an unparseable version never is. */
export function atLeast(version, minimum) {
  const found = triple(version),
    required = triple(minimum);
  if (!found || !required) return false;
  for (let index = 0; index < 3; index++)
    if (found[index] !== required[index]) return found[index] > required[index];
  return true;
}
