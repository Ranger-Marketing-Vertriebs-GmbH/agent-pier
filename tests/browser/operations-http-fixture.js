export function operationState() {
  return {
    backups: [],
    report: null,
    jobStatus: "succeeded",
    jobs: {},
    releases: {
      current: "1.0.0",
      installed: true,
      supported: true,
      releases: [{ version: "0.9.0", current: false, canRollback: true }],
      staged: [],
      channel: "stable",
    },
    inspection: {
      manifest: { version: 1 },
      projects: [
        { id: "old-project", name: "Imported project", cwd: "/old/project", kind: "git" },
      ],
      requiresPassphrase: false,
      credentialsIncluded: false,
      omissions: ["External local CLI profiles and OS keychains"],
    },
  };
}
export function operationResponse(state, path, method, body, query) {
  const operation = path.slice("/operations".length);
  if (operation === "/imported-history/agentbus")
    return { projects: state.importedProjects || [] };
  if (operation.startsWith("/imported-history/agentbus/")) {
    const page = Number(query.get("page") || 1),
      items = state.importedMessages || [];
    return {
      projectId: operation.split("/").at(-1),
      historyOnly: true,
      items: items.slice((page - 1) * 20, page * 20),
      total: items.length,
      page,
      pageSize: 20,
      truncated: false,
    };
  }
  const job = (kind, result) => {
    const next = {
      id: "job-" + kind,
      kind,
      status: "running",
      createdAt: "2026-09-07T12:00:00Z",
      result,
    };
    state.jobs[next.id] = next;
    return { job: next };
  };
  if (operation === "/doctor") {
    if (method === "POST")
      state.report = {
        version: 1,
        generatedAt: "2026-09-07T12:00:00Z",
        checks: [
          { id: "git", status: "ok", summary: "Git 2.50" },
          {
            id: "tmux",
            status: "warn",
            summary: "Not installed",
            remedy: "Install tmux",
          },
        ],
      };
    return { report: state.report };
  }
  if (operation === "/backups/plan")
    return {
      plan: {
        components: ["preferences", "chat", "pipeline-history"],
        omissions: ["External local CLI profiles and OS keychains"],
        consistency: "coordinated-application-snapshot; independent-native-captures",
        requiresPassphrase: Boolean(body.withCredentials),
      },
    };
  if (operation === "/backups") {
    if (method === "POST") {
      const backup = {
        id: "backup-one",
        createdAt: "2026-09-07T12:00:00Z",
        bytes: 4096,
        withCredentials: body.withCredentials,
        includeHistory: body.includeHistory,
      };
      state.backups.push(backup);
      return job("backup", { backup, manifest: { version: 1 } });
    }
    return { backups: state.backups };
  }
  if (operation.startsWith("/backups/") && method === "DELETE") {
    state.backups = state.backups.filter((item) => item.id !== operation.split("/")[2]);
    return {};
  }
  if (operation === "/restore/upload") return { archiveId: "archive-one" };
  if (operation === "/restore/inspect") return { inspection: state.inspection };
  if (operation === "/restore")
    return job("restore", {
      targetDataDir: body.targetDataDir,
      credentialsRestored: 0,
      credentialsNeedingLogin: 1,
      projectMappings: body.projectMap,
      importedSessions: 2,
      importedRuns: 1,
      omissions: state.inspection.omissions,
    });
  if (operation.startsWith("/jobs/"))
    return { job: { ...state.jobs[operation.split("/")[2]], status: state.jobStatus } };
  if (operation === "/releases") return state.releases;
  if (operation.startsWith("/releases/notes/"))
    return { version: operation.split("/").at(-1), body: null, url: null };
  if (operation === "/releases/check")
    return {
      plan: {
        current: "1.0.0",
        version: "1.1.0",
        upToDate: false,
        platform: "darwin-arm64",
        sha256: "a".repeat(64),
        bytes: 4096,
        schemaVersion: 1,
      },
    };
  if (operation === "/releases/stage") {
    state.releases.staged = [{ id: "staged-one", version: body.version }];
    return job("stage", { stagedId: "staged-one", version: body.version });
  }
  if (operation === "/releases/activate")
    return job("activate", {
      from: "1.0.0",
      to: "1.1.0",
      activated: true,
      rolledBack: false,
    });
  if (operation === "/releases/rollback")
    return job("rollback", {
      from: "1.1.0",
      to: body.version,
      activated: true,
      rolledBack: false,
    });
  throw Error("Unexpected operations fixture " + method + " " + path);
}
