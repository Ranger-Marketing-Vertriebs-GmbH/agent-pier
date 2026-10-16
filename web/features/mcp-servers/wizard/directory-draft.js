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

// Names come from the directory, so only own string values count: `{toString}` must
// never pick up an inherited member.
const valueOf = (values, name) =>
  Object.hasOwn(values, name) && typeof values[name] === "string" ? values[name] : "";

const fill = (text, values, encode) =>
  text.replace(templates, (_, name) => encode(valueOf(values, name)));

// A lone surrogate pasted by the owner would make encodeURIComponent throw.
const encodeUrlPart = (value) => encodeURIComponent(value.toWellFormed());

/** The address with every `{var}` replaced by its URL-encoded value. */
export const composeUrl = ({ url, values = {} }) => fill(url, values, encodeUrlPart);

/**
 * A header or env value with every `{var}` replaced as typed (`Token {key}`); the
 * browser composes it and saves the result as a literal.
 */
export const composeValue = ({ value, values = {} }) => fill(value, values, String);

const hasValue = (value) => value !== null && value !== undefined;

function hint(item, extra = {}) {
  const choices = item.choices?.length ? item.choices : extra.choices;
  const fallback = hasValue(item.default) ? item.default : extra.default;
  return {
    description: item.description || extra.description || "",
    required: item.required === true || extra.required === true,
    secret: item.secret === true || extra.secret === true || isSecretName(item.name),
    ...(choices?.length ? { choices } : {}),
    ...(item.format === "boolean" ? { format: "boolean" } : {}),
    ...(hasValue(fallback) ? { default: fallback } : {}),
    ...(extra.template ? { template: extra.template } : {}),
  };
}

/** What a value's own metadata leaves out: its template, or the variable it is. */
function extraOf(item) {
  if (isWrapped(item)) return { template: item.value };
  if (!isTemplated(item)) return {};
  const variable = item.variables?.[0];
  return variable
    ? {
        description: variable.description,
        required: variable.required,
        secret: variable.secret,
        default: variable.default,
        choices: variable.choices,
      }
    : {};
}

/** The first of several items with the same name wins, as the CLI would see it. */
function firstByName(items, keyOf) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyOf(item.name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

const draftable = new Set(["npm", "pypi", "remote-http", "remote-sse"]);

export function draftFromEntry(entry, option, { taken = [] } = {}) {
  if (!isSelectable(option) || !draftable.has(option?.kind))
    throw new TypeError(`Cannot draft a directory option of kind ${option?.kind}`);
  const base =
    sanitiseName(entry.name.split("/").pop()) || sanitiseName(entry.title) || "server";
  // Keyed by names from the directory: no inherited members to collide with.
  const settings = Object.create(null);
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
    const env = firstByName(option.env, String).map((item, index) => {
      const own = isWrapped(item);
      settings[item.name] = hint(item, extraOf(item));
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
  // HTTP header names are case-insensitive.
  const unique = firstByName(option.headers, (name) => name.toLowerCase());
  const headers = unique.map((item, index) => {
    const bearer = bearerTemplate.test(item.value ?? "");
    const own = !bearer && isWrapped(item);
    const token = item.variables?.[0];
    settings[item.name] = hint(
      item,
      bearer
        ? { required: true, secret: true, description: token?.description }
        : extraOf(item),
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
