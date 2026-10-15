import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { auditEvent } from "../../server/features/audit/audit-schema.js";
import { requestAudit } from "../../server/features/audit/audit-http.js";

/**
 * Every audit event the server writes must pass the audit schema, or the store
 * rejects it and the activity log silently misses the change. This guard parses all
 * of server/ and checks each audit event it can find statically:
 *
 * - An object literal with an `action` and a `resourceType` (or an `action` with
 *   `source` and `outcome`) is an audit event; its action and resourceType must pass
 *   auditEvent(). An object literal whose `action` is a dotted string literal is an
 *   audit action too (events handed to a helper that adds the rest).
 * - Values are resolved through string literals, `a ? "x" : "y"`, template literals,
 *   `const` bindings and parameters of helpers called in the same file
 *   (`record("x.created", …)`, `this.emit("x.created", …)`).
 * - What stays dynamic must be listed in `dynamic` below with the reason it is safe;
 *   a new dynamic site, or a listed one that disappeared, fails this test. Prefer a
 *   literal at the call site over a new entry.
 */
const dynamic = {
  // Built from the request route; the last test of this file runs every route shape.
  "server/features/audit/audit-http.js action `${resourceType}.${action}`":
    "route-derived HTTP audits",
  "server/features/audit/audit-http.js resourceType resourceType":
    "route-derived HTTP audits",
  // The access service's events carry literal actions, checked by the dotted-action rule.
  "server/application/mcp.js action event.action": "MCP access service events",
  // The schema's own validated copy of an event.
  "server/features/audit/audit-schema.js action action": "the audit schema",
  "server/features/audit/audit-schema.js resourceType input.resourceType":
    "the audit schema",
};

const root = path.resolve(import.meta.dirname, "../..");
const base = { source: "user", outcome: "success" };

function sources(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sources(file);
    return /\.m?js$/.test(entry.name) ? [file] : [];
  });
}

const isFunction = (node) =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node);

function functionName(fn) {
  if (fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  const parent = fn.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name))
    return parent.name.text;
  return null;
}

function properties(object) {
  const found = new Map();
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) && !ts.isComputedPropertyName(property.name))
      found.set(property.name.text, property.initializer);
    else if (ts.isShorthandPropertyAssignment(property))
      found.set(property.name.text, property.name);
  }
  return found;
}

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/** The strings an expression can be, or null when it is not static. */
function resolve(expression, file, depth = 0) {
  if (depth > 8) return null;
  if (ts.isParenthesizedExpression(expression))
    return resolve(expression.expression, file, depth);
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
    return [expression.text];
  if (ts.isConditionalExpression(expression)) {
    const whenTrue = resolve(expression.whenTrue, file, depth + 1);
    const whenFalse = resolve(expression.whenFalse, file, depth + 1);
    return whenTrue && whenFalse ? [...whenTrue, ...whenFalse] : null;
  }
  if (ts.isTemplateExpression(expression)) {
    let values = [expression.head.text];
    for (const span of expression.templateSpans) {
      const parts = resolve(span.expression, file, depth + 1);
      if (!parts) return null;
      values = values.flatMap((value) =>
        parts.map((part) => value + part + span.literal.text),
      );
    }
    return values;
  }
  // A lookup table: `table[key]` is any of the constant object's values.
  if (ts.isElementAccessExpression(expression)) {
    let table = expression.expression;
    while (ts.isParenthesizedExpression(table)) table = table.expression;
    if (ts.isIdentifier(table)) table = binding(table)?.initializer;
    if (!table || !ts.isObjectLiteralExpression(table)) return null;
    const values = [];
    for (const value of properties(table).values()) {
      const resolved = resolve(value, file, depth + 1);
      if (!resolved) return null;
      values.push(...resolved);
    }
    return values;
  }
  if (ts.isIdentifier(expression)) {
    const found = binding(expression);
    if (found?.initializer) return resolve(found.initializer, file, depth + 1);
    if (found?.parameter) return resolveParameter(found.fn, found.index, file, depth);
  }
  return null;
}

/** The nearest `const` declaration or function parameter an identifier names. */
function binding(identifier) {
  const name = identifier.text;
  for (let scope = identifier.parent; scope; scope = scope.parent) {
    if (isFunction(scope)) {
      const index = scope.parameters.findIndex(
        (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === name,
      );
      if (index >= 0) return { parameter: true, fn: scope, index };
    }
    for (const statement of scope.statements || []) {
      if (!ts.isVariableStatement(statement)) continue;
      if (!(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name)
          return declaration.initializer
            ? { initializer: declaration.initializer }
            : null;
    }
  }
  return null;
}

// Helpers whose parameters feed an audit event: name -> parameter indexes.
const helpers = new Map();

/** A helper's parameter: the arguments of every call of that helper in its file. */
function resolveParameter(fn, index, file, depth) {
  const name = functionName(fn);
  if (!name) return null;
  helpers.set(name, (helpers.get(name) || new Set()).add(index));
  const method = ts.isMethodDeclaration(fn);
  const values = [];
  let calls = 0;
  let unresolved = false;
  walk(file, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    const named = method
      ? ts.isPropertyAccessExpression(callee) &&
        callee.expression.kind === ts.SyntaxKind.ThisKeyword &&
        callee.name.text === name
      : ts.isIdentifier(callee) && callee.text === name;
    if (!named) return;
    calls++;
    const argument = node.arguments[index];
    const resolved = argument && resolve(argument, file, depth + 1);
    if (resolved) values.push(...resolved);
    else unresolved = true;
  });
  return calls && !unresolved ? values : null;
}

const calleeName = (callee) =>
  ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : null;

function collect() {
  const sites = [];
  const unresolved = [];
  const files = sources(path.join(root, "server")).map((absolute) => {
    const name = path.relative(root, absolute).split(path.sep).join("/");
    const text = fs.readFileSync(absolute, "utf8");
    return [name, ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true)];
  });
  for (const [name, file] of files)
    walk(file, (node) => {
      if (!ts.isObjectLiteralExpression(node)) return;
      const found = properties(node);
      const action = found.get("action");
      if (!action) return;
      const literal = ts.isStringLiteral(action) && action.text.includes(".");
      const event =
        found.has("resourceType") || (found.has("source") && found.has("outcome"));
      if (!event && !literal) return;
      const { line } = file.getLineAndCharacterOfPosition(node.getStart());
      const at = `${name}:${line + 1}`;
      const values = {};
      for (const key of event ? ["action", "resourceType"] : ["action"]) {
        const expression = found.get(key);
        if (!expression) {
          sites.push({ at, missing: key });
          continue;
        }
        values[key] = resolve(expression, file);
        if (!values[key])
          unresolved.push(
            `${name} ${key} ${expression.getText(file).replace(/\s+/g, " ")}`,
          );
      }
      sites.push({ at, event, ...values });
    });
  // Helpers handed to or called from other files (`auditMcp("package.updated", …)`,
  // `sshManagement.emit("ssh.key.exported", …)`): a dotted literal there is an action.
  for (const [name, file] of files)
    walk(file, (node) => {
      if (!ts.isCallExpression(node)) return;
      for (const index of helpers.get(calleeName(node.expression)) || []) {
        const argument = node.arguments[index];
        if (!argument || !ts.isStringLiteral(argument) || !argument.text.includes("."))
          continue;
        const { line } = file.getLineAndCharacterOfPosition(node.getStart());
        sites.push({ at: `${name}:${line + 1}`, event: false, action: [argument.text] });
      }
    });
  return { sites, unresolved };
}

const { sites, unresolved } = collect();

test("the guard finds the server's audit events", () => {
  // A parser or rule change that finds nothing must not pass silently.
  assert.ok(sites.length >= 50, `only ${sites.length} audit sites found`);
  const actions = new Set(sites.flatMap((site) => site.action || []));
  for (const known of [
    "setting.updated",
    "ssh.tested",
    "ssh.key.exported",
    "notification.subscribed",
    "package.updated",
  ])
    assert.ok(actions.has(known), `${known} not found`);
});

test("every static audit action and resourceType passes the audit schema", () => {
  const invalid = [];
  for (const site of sites) {
    if (site.missing) {
      invalid.push(`${site.at}: audit event without ${site.missing}`);
      continue;
    }
    for (const action of site.action || [])
      for (const resourceType of site.event ? site.resourceType || [] : ["setting"])
        try {
          auditEvent({ ...base, action, resourceType });
        } catch {
          invalid.push(`${site.at}: ${action} (${site.event ? resourceType : "action"})`);
        }
  }
  assert.deepEqual(invalid, []);
});

test("every dynamic audit value is reviewed", () => {
  assert.deepEqual([...new Set(unresolved)].sort(), Object.keys(dynamic).sort());
});

test("every route-derived HTTP audit passes the audit schema", () => {
  // Every word audit-http.js matches a path segment against, plus an id and nothing.
  const source = path.join(root, "server/features/audit/audit-http.js");
  const file = ts.createSourceFile(
    source,
    fs.readFileSync(source, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const words = new Set(["id-1", undefined]);
  walk(file, (node) => {
    if (ts.isStringLiteral(node) && /^[a-z][a-z-]*$/.test(node.text))
      words.add(node.text);
  });
  const invalid = new Set();
  let audited = 0;
  for (const method of ["POST", "PATCH", "PUT", "DELETE"])
    for (const area of words)
      for (const id of words)
        for (const operation of words)
          for (const tail of [[], ["id-1"], ["id-1", "archive"]]) {
            const segments = [area, id, operation, ...tail].filter(Boolean);
            const event = requestAudit({ method, path: `/api/${segments.join("/")}` });
            if (!event) continue;
            audited++;
            try {
              auditEvent({ ...base, ...event });
            } catch {
              invalid.add(`${method} /api/${segments.join("/")}: ${event.action}`);
            }
          }
  assert.ok(audited > 1000, `only ${audited} audited routes`);
  assert.deepEqual([...invalid], []);
});
