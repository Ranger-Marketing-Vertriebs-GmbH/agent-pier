import { Router } from "express";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";
import { record } from "../../features/extensions/mcp-config.js";
import { packageProblem } from "../../features/mcp-packages/package-errors.js";
import {
  packageConstraints,
  packageName,
} from "../../features/mcp-packages/package-spec.js";

const invalid = () => packageProblem("MCP_PACKAGE_INVALID", 400);

/** One owner confirmation per install; it replaces the stdio confirmation. */
export const requireInstallConfirmation = (body) => {
  if (body?.confirmInstall !== true)
    throw packageProblem("MCP_PACKAGE_CONFIRMATION_REQUIRED", 409);
};

/** The constraints an accepted source carried, canonical; none when unreadable. */
function auditConstraints(source) {
  try {
    return packageConstraints(source, {
      registry: source.registry,
      name: packageName(source),
    });
  } catch {
    return [];
  }
}

/** Audit details of a package: never env values, args or paths. Constraints are not secret. */
export const auditDetails = (source) => ({
  registry: source?.registry,
  name: source?.name,
  version: source?.version,
  allowScripts: source?.allowScripts === true,
  constraints: auditConstraints(source),
});

export const packagesOf = (services) => {
  if (!services.mcpPackages) throw assistantProblem("unavailable", 503);
  return services.mcpPackages;
};

/**
 * `PUT /mcp-servers/:id` with `source`: `null` detaches a packaged server to the own
 * command in the body; an object switches an own-command server to a package (D1).
 */
export async function changeSource(services, { changes, auditMcp }, req, res) {
  const packages = packagesOf(services);
  const id = req.params.id;
  const {
    confirmStdio,
    confirmInstall: _confirm,
    clis,
    source,
    previewId,
    program,
    ...patch
  } = req.body;
  const options = {
    confirmStdio: confirmStdio === true,
    ...(clis === undefined ? {} : { clis }),
  };
  if (source === null) {
    if (!packages.isPackaged(id) || typeof patch.command !== "string") throw invalid();
    const before = services.mcpServers.get(id).source;
    // The own command needs the stdio confirmation like any command change.
    // Without new args the owner's stay; the generated program path never does.
    await packages.detach(id, () =>
      changes().update(
        id,
        patch.args === undefined ? { ...patch, args: packages.ownerArgs(id) } : patch,
        options,
      ),
    );
    auditMcp("mcp.package.removed", id, auditDetails(before));
    return res.json(services.mcpServers.get(id));
  }
  if (!record(source) || packages.isPackaged(id) || patch.command !== undefined)
    throw invalid();
  requireInstallConfirmation(req.body);
  const edits =
    Object.keys(patch).some((key) => key !== "revision") || clis !== undefined;
  // The install confirmation covers the other stdio fields saved with it.
  const server = await packages.attach(
    id,
    { source, previewId, program },
    edits
      ? () => changes().update(id, patch, { ...options, confirmStdio: true })
      : undefined,
  );
  auditMcp("mcp.package.installed", id, auditDetails(source));
  return res.status(202).json(server);
}

/**
 * Package versions and previews, and the package of a server: status, update and
 * reinstall. Responses carry codes, versions and the redacted job log; never a path,
 * lock text or raw npm output.
 */
export function mcpPackageRoutes(services, { auditMcp }) {
  const packages = () => packagesOf(services);
  const router = Router();
  router.get("/mcp-packages/versions", async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(
      await packages().versions({ registry: req.query.registry, name: req.query.name }),
    );
  });
  router.post("/mcp-packages/preview", async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(await packages().preview(record(req.body) ? req.body : {}));
  });
  router.get("/mcp-servers/:id/package", (req, res) =>
    res.json(packages().status(req.params.id)),
  );
  router.post("/mcp-servers/:id/package/update", async (req, res) => {
    const body = record(req.body) ? req.body : {};
    requireInstallConfirmation(body);
    const result = await packages().updatePackage(req.params.id, body);
    const current = services.mcpServers.get(req.params.id).source;
    auditMcp(
      "mcp.package.updated",
      req.params.id,
      auditDetails({
        ...current,
        version: body.version,
        allowScripts: body.allowScripts,
        // An update without constraints kept the stored ones.
        ...(body.constraints === undefined ? {} : { constraints: body.constraints }),
      }),
    );
    res.status(202).json(result);
  });
  router.post("/mcp-servers/:id/package/reinstall", (req, res) => {
    const result = packages().reinstall(req.params.id);
    auditMcp(
      "mcp.package.reinstalled",
      req.params.id,
      auditDetails(services.mcpServers.get(req.params.id).source),
    );
    res.status(202).json(result);
  });
  return router;
}
