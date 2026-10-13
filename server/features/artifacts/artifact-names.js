/**
 * Session and project names for artifact search. The name table is read at most once
 * per `ttlMs` (polling with a search term reuses it), from session metadata files and
 * a plain projects query. A source that cannot be read contributes no names.
 */
export class ArtifactNames {
  constructor({ sessions, projects, ttlMs = 5000, clock = () => Date.now() }) {
    this.sessions = sessions;
    this.projects = projects;
    this.ttlMs = ttlMs;
    this.clock = clock;
    this.table = null;
  }
  load() {
    const now = this.clock();
    if (this.table && now - this.table.at < this.ttlMs) return this.table.rows;
    const read = (source) =>
      Promise.resolve()
        .then(source)
        .then((rows) => (Array.isArray(rows) ? rows : []))
        .catch(() => []);
    const rows = Promise.all([read(this.sessions), read(this.projects)]).then(
      ([sessions, projects]) => [...sessions, ...projects],
    );
    this.table = { at: now, rows };
    return rows;
  }
  /** IDs of sessions and projects whose name contains `term` (case-insensitive). */
  async matches(term) {
    const needle = term.toLocaleLowerCase();
    return (await this.load())
      .filter((row) =>
        String(row?.name || "")
          .toLocaleLowerCase()
          .includes(needle),
      )
      .map((row) => row.id);
  }
}
