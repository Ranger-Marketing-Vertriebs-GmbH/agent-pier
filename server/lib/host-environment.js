import path from "node:path";

export function hostEnvironment(env = process.env) {
  return {
    ...env,
    PATH: [
      ...new Set([
        ...(env.PATH || "").split(path.delimiter).filter(Boolean),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
      ]),
    ].join(path.delimiter),
  };
}
