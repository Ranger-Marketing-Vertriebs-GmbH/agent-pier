import { projectScope } from "../memory/project-scope.js";

export class SessionProjects {
  constructor() {
    this.cache = new Map();
  }

  async enrich(sessions) {
    const directories = new Set(sessions.map((session) => session.cwd));
    for (const cwd of this.cache.keys())
      if (!directories.has(cwd)) this.cache.delete(cwd);
    return Promise.all(
      sessions.map(async (session) => {
        let entry = this.cache.get(session.cwd);
        if (!entry || Date.now() - entry.time > 30000) {
          entry = {
            time: Date.now(),
            name: projectScope(session.cwd)
              .then((project) => (project.kind === "git" ? project.name : null))
              .catch(() => null),
          };
          this.cache.set(session.cwd, entry);
        }
        return { ...session, repositoryName: await entry.name };
      }),
    );
  }
}
