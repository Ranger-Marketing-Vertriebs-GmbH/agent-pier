import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { isManagedInstall, withCliVersions } from "./cli-version.js";

/**
 * What GET /tool-installations answers: every installation (the installer's job
 * record and catalog row) with the installed version beside it, and whether the
 * installer is busy. With `tool`, only that tool's installation (the live
 * `job.tool:<tool>` value); an unknown tool is refused (404).
 */
export async function toolInstallations(installer, tool) {
  return withVersions(installer, select(installer, tool));
}

function select(installer, tool) {
  const list = installer.list();
  if (tool !== undefined) {
    list.installations = list.installations.filter((item) => item.tool === tool);
    if (!list.installations.length)
      throw problem(serverMessages.common.unknownCliTool, 404);
  }
  return list;
}

const versions = (installer, wait, tool) =>
  withCliVersions(
    installer.detect().filter((found) => tool === undefined || found.id === tool),
    {
      wait,
      managed: (found) =>
        isManagedInstall(found.id, found.path, {
          home: installer.home,
          dataDir: installer.dataDir,
        }),
    },
  );

/**
 * Resolves once the installed version of `tool` (every installed CLI's without it) is
 * known: a list read while it was still being probed (`versionStatus: "checking"`)
 * answers differently now.
 */
export const versionsSettled = (installer, tool) => versions(installer, true, tool);

async function withVersions(installer, list) {
  const detected = await versions(installer, false);
  // The installed version beside the job record, whose own `version` is what the
  // last installation or update reported.
  for (const item of list.installations) {
    const found = detected.find((candidate) => candidate.id === item.tool);
    if (found?.minimumVersion)
      Object.assign(item, {
        installedVersion: found.version,
        minimumVersion: found.minimumVersion,
        versionStatus: found.versionStatus,
        managedInstall: found.managedInstall,
      });
  }
  return list;
}
