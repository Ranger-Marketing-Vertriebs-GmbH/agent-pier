import test from "node:test";
import assert from "node:assert/strict";
import { RebuildQuestionWatch } from "../../server/application/craft-rebuilds-wiring.js";
import {
  ownerQuestions,
  questionNotice,
} from "../../server/features/craft/rebuild-questions.js";
import { pushEvent } from "../../server/features/notifications/push-validation.js";

const id = "0b8c1f7e-3d2a-4c5b-9e6f-7a8b9c0d1e2f";
const other = "1c9d2a8f-4e3b-4d6c-8f7a-8b9c0d1e2f3a";
const question = { id: "q1", kind: "question", title: "Which colour?" };
const approval = { id: "q2", kind: "approval", title: "Run it?", action: "npm install" };

function fixture(views) {
  const rebuilds = {
    views,
    list: () => rebuilds.views,
    get: (wanted) => rebuilds.views.find((view) => view.id === wanted) ?? null,
  };
  const opened = [];
  let changes = 0;
  const watch = new RebuildQuestionWatch({
    rebuilds,
    opened: (view, q) => opened.push(`${view.id}:${q.id}`),
    changed: () => changes++,
  });
  return { rebuilds, watch, opened, changes: () => changes };
}

test("a new question announces once; samples without a new one stay quiet", () => {
  const view = { id, name: "shop-clone", autoMode: false, questions: [] };
  const f = fixture([view]);
  f.watch.update({ id });
  assert.deepEqual(f.opened, []);
  assert.equal(f.changes(), 0);
  view.questions = [question];
  f.watch.update({ id });
  f.watch.update({ id });
  f.watch.update({ list: true });
  assert.deepEqual(f.opened, [`${id}:q1`]);
  assert.equal(f.changes(), 1);
  // Answered: the inbox hears it, nothing is announced; asked again it announces.
  view.questions = [];
  f.watch.update({ id });
  assert.equal(f.changes(), 2);
  view.questions = [question, approval];
  f.watch.update({ id });
  assert.deepEqual(f.opened, [`${id}:q1`, `${id}:q1`, `${id}:q2`]);
});

test("questions open at a restart are not announced again", () => {
  const f = fixture([{ id, autoMode: false, questions: [question] }]);
  f.watch.update({ list: true });
  assert.deepEqual(f.opened, []);
  assert.equal(f.changes(), 0);
});

test("a removed rebuild or auto mode takes its questions out of the inbox", () => {
  const f = fixture([
    { id, autoMode: false, questions: [question, approval] },
    { id: other, autoMode: false, questions: [approval] },
  ]);
  f.rebuilds.views[0].autoMode = true;
  f.watch.update({ id });
  assert.equal(f.changes(), 1);
  f.rebuilds.views = [f.rebuilds.views[0]];
  f.watch.update({ list: true });
  assert.equal(f.changes(), 2);
  assert.deepEqual(f.opened, []);
});

test("a failing notifier never breaks the watch", async () => {
  const view = { id, autoMode: false, questions: [] };
  const rebuilds = { list: () => [view], get: () => view };
  const errors = [];
  const original = console.error;
  console.error = (line) => errors.push(line);
  try {
    const watch = new RebuildQuestionWatch({
      rebuilds,
      opened: async () => {
        throw new Error("offline");
      },
      changed: () => {},
    });
    view.questions = [question];
    watch.update({ id });
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 1);
});

test("the notice is a valid push event: a question previews, an approval does not", () => {
  const view = { id, name: "shop-clone", autoMode: false, questions: [question] };
  assert.deepEqual(ownerQuestions(view), [question]);
  const notice = questionNotice(view, question);
  assert.deepEqual(pushEvent(notice), {
    kind: "craft-question",
    eventId: `${id}:q1`,
    rebuildId: id,
    label: "shop-clone",
    preview: "Which colour?",
    inbox: { type: "craft", id: `${id}:q1` },
  });
  assert.equal(questionNotice(view, approval).preview, undefined);
  assert.throws(() => pushEvent({ ...notice, rebuildId: "../x" }));
  assert.throws(() => pushEvent({ ...notice, eventId: `${id}:../q1` }));
});
