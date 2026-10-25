import { isDeepStrictEqual } from "node:util";
import { compareReleaseVersions } from "../operations/version.js";
import { readNetworkConfig } from "../remote/network-access.js";

// Row statuses for the settings tabs. Only local state is read: no diagnostics run
// and no network update check. A part that cannot be read is null, never a zero.
const attempt = (read) => {
  try {
    return read() ?? null;
  } catch {
    return null;
  }
};

function activeGrants(mcpAccess, now) {
  let offset = 0;
  let active = 0;
  for (;;) {
    const page = mcpAccess.listGrants({ offset, limit: 100 });
    for (const grant of page.grants)
      if (
        !grant.revokedAt &&
        (!grant.expiresAt || new Date(grant.expiresAt).getTime() > now)
      )
        active++;
    offset += page.grants.length;
    if (!page.grants.length || offset >= page.total) return active;
  }
}

function updates(releases) {
  const { current } = releases.status();
  const last = releases.lastCheck();
  return {
    current: current ?? null,
    checked: Boolean(last),
    available:
      last?.version && current && compareReleaseVersions(last.version, current) > 0
        ? last.version
        : null,
  };
}

export function settingsSummary(services, now = Date.now()) {
  const {
    mcpAccess,
    effectiveConfig,
    sshAccesses,
    secrets,
    repositories,
    operations,
    config,
    users,
  } = services;
  return {
    access: {
      mcp: attempt(
        () =>
          mcpAccess && {
            available: Boolean(mcpAccess.status().available),
            activeGrants: activeGrants(mcpAccess, now),
          },
      ),
      remote: attempt(() => {
        const running = effectiveConfig?.();
        return (
          running && {
            tailscale: Boolean(running.remoteUrl),
            network: Boolean(running.network?.enabled),
            // A saved network change applies only after a restart (as in GET /remote).
            restartRequired: config?.dataDir
              ? !isDeepStrictEqual(
                  readNetworkConfig(config.dataDir).network,
                  running.network,
                )
              : null,
          }
        );
      }),
      ssh: attempt(() => sshAccesses && { count: sshAccesses.list().length }),
      secrets: attempt(() => secrets && { count: secrets.list().length }),
      github: attempt(
        () => repositories && { count: repositories.listCredentials().length },
      ),
      users: attempt(() => users && { count: users.list().length }),
    },
    operations: {
      diagnostics: attempt(() => {
        const report = operations?.report();
        return (
          report && {
            generatedAt: report.generatedAt,
            failed: report.checks.filter((check) => check.status === "fail").length,
            warnings: report.checks.filter((check) => check.status === "warn").length,
          }
        );
      }),
      backups: attempt(() => {
        const list = operations?.backup.list();
        return list && { count: list.length, lastAt: list[0]?.createdAt ?? null };
      }),
      updates: attempt(() => operations?.releases && updates(operations.releases)),
    },
  };
}
