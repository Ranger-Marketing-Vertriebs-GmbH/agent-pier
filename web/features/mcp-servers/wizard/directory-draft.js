import { sanitiseName, uniqueName } from "./server-name.js";
import { isSecretName } from "./setting-hints.js";

// A directory entry's chosen way to run → the wizard draft. Values are never taken
// from the directory except fixed literal ones; templates become fields to fill.
const variable = "[A-Za-z_][A-Za-z0-9_-]{0,63}";
const template = new RegExp(`\\{${variable}\\}`);
const templates = new RegExp(`\\{(${variable})\\}`, "g");
const wholeTemplate = new RegExp(`^\\{${variable}\\}$`);
const bearerTemplate = new RegExp(`^Bearer \\{${variable}\\}$`);

/** Whether the owner may pick this way to run (Q5: unsupported ones are greyed). */
export const isSelectable = (option) => option?.kind !== "unsupported";

const fill = (text, values, encode) =>
  text.replace(templates, (_, name) => encode(values[name] ?? ""));

/** The address with every `{var}` replaced by its URL-encoded value. */
export const composeUrl = ({ url, values = {} }) => fill(url, values, encodeURIComponent);

/**
 * A header or env value with every `{var}` replaced as typed (`Token {key}`); the
 * browser composes it and saves the result as a literal.
 */
export const composeValue = ({ value, values = {} }) => fill(value, values, String);

function hint(item, extra = {}) {
  return {
    description: item.description || extra.description || "",
    required: item.required === true || extra.required === true,
    secret: item.secret === true || extra.secret === true || isSecretName(item.name),
    ...(item.choices?.length ? { choices: item.choices } : {}),
    ...(item.format === "boolean" ? { format: "boolean" } : {}),
    ...(item.default !== null && item.default !== undefined
      ? { default: item.default }
      : {}),
    ...(extra.template ? { template: extra.template } : {}),
  };
}

const isTemplated = (item) => typeof item.value === "string" && template.test(item.value);
// `{var}` alone is the field itself; anything around it must survive the save.
const isWrapped = (item) => isTemplated(item) && !wholeTemplate.test(item.value);

/** A value that wraps templates in other text keeps them for the owner to fill. */
const templateOf = (item) => ({
  template: { value: item.value, variables: item.variables ?? [], values: {} },
});

const literal = (value) =>
  typeof value === "string" && !template.test(value) ? value : "";

export function draftFromEntry(entry, option, { taken = [] } = {}) {
  const base =
    sanitiseName(entry.name.split("/").pop()) || sanitiseName(entry.title) || "server";
  const settings = {};
  const common = {
    name: uniqueName(base, taken),
    origin: "directory",
    directoryOrigin: { name: entry.name, version: entry.version },
  };
  const hints = () => ({
    settings,
    directory: { name: entry.name, title: entry.title, version: entry.version },
  });
  if (option.kind === "npm" || option.kind === "pypi") {
    const env = option.env.map((item, index) => {
      const own = isWrapped(item);
      settings[item.name] = hint(item, own ? { template: item.value } : {});
      return {
        key: `directory-env-${index}`,
        name: item.name,
        value: literal(item.value),
        fixed: true,
        ...(own ? templateOf(item) : {}),
      };
    });
    return {
      ...common,
      path: "package",
      transport: "stdio",
      source: "package",
      registry: option.kind,
      packageName: option.identifier,
      packageVersion: option.version,
      argRows: [...option.packageArgs],
      env,
      hints: hints(),
    };
  }
  let authTaken = false;
  const headers = option.headers.map((item, index) => {
    const bearer = bearerTemplate.test(item.value ?? "");
    const own = !bearer && isWrapped(item);
    const token = item.variables?.[0];
    settings[item.name] = hint(
      item,
      bearer
        ? { required: true, secret: true, description: token?.description }
        : own
          ? { template: item.value }
          : {},
    );
    const auth = bearer && !authTaken;
    if (auth) authTaken = true;
    return {
      key: auth ? "auth" : `directory-header-${index}`,
      name: item.name,
      value: literal(item.value),
      fixed: true,
      ...(bearer ? { bearer: true } : {}),
      ...(own ? templateOf(item) : {}),
    };
  });
  const variables = option.urlVariables ?? [];
  return {
    ...common,
    path: "remote",
    transport: option.kind === "remote-sse" ? "sse" : "http",
    source: "command",
    url: variables.length ? "" : option.url,
    urlTemplate: variables.length ? { url: option.url, variables, values: {} } : null,
    signIn: headers.length ? "headers" : "none",
    headers,
    hints: hints(),
  };
}
