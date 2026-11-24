import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { privateDatabase } from "../../lib/private-database.js";
import { problem } from "../../lib/storage.js";
// A replacement session receives fresh credentials; its managed order keeps this
// private receipt namespace. OAuth grants and ordinary session IDs are unchanged.
export const orderGrantPrefix = "autopilot-";
export const orderGrantId = (orderId) => orderGrantPrefix + orderId;

export class StartRequests {
  constructor(dataDir) {
    this.db = privateDatabase(path.join(dataDir, "mcp-requests"), "starts.sqlite");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS starts(grant_id TEXT NOT NULL, request_id TEXT NOT NULL, input_hash TEXT NOT NULL, run_id TEXT UNIQUE NOT NULL, project_id TEXT NOT NULL, PRIMARY KEY(grant_id,request_id));",
    );
  }
  hash(input) {
    return createHash("sha256").update(JSON.stringify(input)).digest("hex");
  }
  get(grantId, requestId, input) {
    const row = this.db
      .prepare("SELECT * FROM starts WHERE grant_id=? AND request_id=?")
      .get(grantId, requestId);
    if (row && row.input_hash !== this.hash(input))
      throw problem("This request ID was already used for a different start.", 409);
    return row && { runId: row.run_id, projectId: row.project_id, grantId: row.grant_id };
  }
  reserve(grantId, requestId, input) {
    if (this.db.prepare("SELECT COUNT(*) AS count FROM starts").get().count >= 100000)
      throw problem("The durable MCP start registry has reached its capacity.", 503);
    const runId = randomUUID();
    this.db
      .prepare("INSERT INTO starts VALUES(?,?,?,?,?)")
      .run(grantId, requestId, this.hash(input), runId, input.projectId);
    return { runId, projectId: input.projectId, grantId };
  }
  owner(runId) {
    const row = this.db
      .prepare("SELECT grant_id,project_id FROM starts WHERE run_id=?")
      .get(runId);
    return row && { grantId: row.grant_id, projectId: row.project_id };
  }
  orderReceipt(grant, runId) {
    if (grant?.sessionId && grant.id.startsWith(orderGrantPrefix))
      return this.db
        .prepare(
          "SELECT request_id AS requestId FROM starts WHERE grant_id=? AND run_id=?",
        )
        .get(grant.id, runId);
  }
  forOrder(orderId, projectId) {
    return this.db
      .prepare(
        "SELECT request_id AS requestId, run_id AS runId FROM starts WHERE grant_id=? AND project_id=? ORDER BY rowid",
      )
      .all(orderGrantId(orderId), projectId);
  }
  close() {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
}
