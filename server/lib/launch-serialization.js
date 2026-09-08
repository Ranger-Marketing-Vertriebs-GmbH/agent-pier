/** Quote one literal POSIX shell argument, including embedded single quotes. */
export function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Serialize values supported by native CLI TOML overrides. */
export function tomlValue(value) {
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}=${tomlValue(item)}`)
      .join(",")}}`;
  }
  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return JSON.stringify(value);
  throw new TypeError("Unsupported native TOML configuration value");
}
