// The value of GET /api/inbox and the live `inbox` topic when nothing waits. Fixtures
// answer it because the start page follows the topic even with an empty inbox.
export const emptyInbox = Object.freeze({
  instance: "fixture",
  revision: 0,
  counts: Object.freeze({ all: 0, questions: 0, approvals: 0, gates: 0, agents: 0 }),
  items: Object.freeze([]),
});
