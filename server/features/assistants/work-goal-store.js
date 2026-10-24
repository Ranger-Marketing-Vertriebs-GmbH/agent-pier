// Work goals of an agent's chat, kept beside its team records. A chat holds at most
// one open goal; ended ones stay for the chat's notes, the newest 20 per chat.
import { randomUUID } from "node:crypto";

export const keptEndedGoals = 20;

export class WorkGoalStore {
  constructor(teams) {
    this.teams = teams;
  }
  list(conversationId) {
    return this.teams.db
      .prepare(
        "SELECT body FROM assistant_team_records WHERE kind='work-goal' AND json_extract(body,'$.conversationId')=? ORDER BY rowid",
      )
      .all(conversationId)
      .map((r) => JSON.parse(r.body));
  }
  open(conversationId) {
    return this.list(conversationId).find((g) => g.state === "open") ?? null;
  }
  openGoals() {
    return this.teams.rows("work-goal").filter((g) => g.state === "open");
  }
  insert(fields) {
    return this.teams.insert({
      id: randomUUID(),
      kind: "work-goal",
      revision: 1,
      steps: "",
      state: "open",
      summary: null,
      reason: null,
      reasonCode: null,
      nudges: 0,
      failures: 0,
      idleTurns: 0,
      lastAttemptId: null,
      evaluatedAttemptId: null,
      endedAt: null,
      ...fields,
    });
  }
  write(goal, patch) {
    const next = this.teams.write(goal, patch);
    if (next.state !== "open") this.prune(next.conversationId);
    return next;
  }
  // The oldest ended goals beyond the kept ones go.
  prune(conversationId) {
    const ended = this.list(conversationId).filter((g) => g.state !== "open");
    const remove = this.teams.db.prepare("DELETE FROM assistant_team_records WHERE id=?");
    for (const goal of ended.slice(0, Math.max(0, ended.length - keptEndedGoals)))
      remove.run(goal.id);
  }
  forget(conversationId) {
    this.teams.db
      .prepare(
        "DELETE FROM assistant_team_records WHERE kind='work-goal' AND json_extract(body,'$.conversationId')=?",
      )
      .run(conversationId);
  }
}
