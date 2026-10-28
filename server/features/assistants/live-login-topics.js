// The live `job.chatgpt-login:current` topic, owner only, a kind of the `job.<kind>`
// family (live/job-topics.js): the latest ChatGPT device sign-in of the agents, the
// value GET /assistant-model-login/current answers (the attempt's id and status, and
// while it waits the device code and sign-in page the owner must open, exactly what
// the owner's REST read shows; never the Gateway's reasons, which only the log gets).
// AssistantAccountLogin signals every change of its attempt; all of them happen in
// this process, so the topic is not sampled. Each attempt has its own id, so a new
// attempt reads differently from the one before it. Without an attempt the route
// answers 404, without the agent services 503: both are expected and not logged.
import { assistantProblem } from "./assistant-validation.js";

const CURRENT = /current/;

/** The sign-in attempt changed: signals its topic on `hub` (services.live). */
export function chatgptLoginChanged(hub) {
  hub?.invalidate("job.chatgpt-login");
}

/** The `job.chatgpt-login` options for defineJobTopic (live/job-topics.js). */
export function chatgptLoginJob(services) {
  return {
    kind: "chatgpt-login",
    param: CURRENT,
    read: () => {
      if (!services.assistantModelLogin)
        throw Object.assign(assistantProblem("unavailable", 503), { expected: true });
      return services.assistantModelLogin.status();
    },
    // Agent services switched on or off replace the sign-in service.
    watch({ invalidate }) {
      const events = services.assistantFeature?.events;
      events?.on("started", invalidate);
      events?.on("stopped", invalidate);
      return () => {
        events?.off("started", invalidate);
        events?.off("stopped", invalidate);
      };
    },
  };
}
