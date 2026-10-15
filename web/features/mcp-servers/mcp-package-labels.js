/** The form field a package refusal belongs to, else null (shown in the bar). */
export function refusalField(error, registry) {
  const key = error?.messageKey;
  if (key === "mcpPackages.invalidConstraints") return "packageConstraints";
  // Only PyPI has constraints; for npm another version is the fix.
  if (key === "mcpPackages.unsatisfiable")
    return registry === "pypi" ? "packageConstraints" : "packageVersion";
  // A release that excludes the managed Python: another version is the first fix.
  if (key === "mcpPackages.pythonUnsupported") return "packageVersion";
  if (key === "mcpPackages.versionYanked") return "packageVersion";
  return null;
}

/** A nested copy of a name that appears more than once shows where it sits in the graph. */
export const showsPath = (entry, list) =>
  typeof entry.path === "string" &&
  entry.path !== entry.name &&
  list.filter((other) => other.name === entry.name).length > 1;
