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
