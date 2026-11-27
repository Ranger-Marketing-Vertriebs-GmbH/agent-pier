// Token usage and cost as the port answers them (agent-runtime.js sessions.usage and
// agents.usage), from OpenClaw's own usage report (2026.11.6, scope operator.read):
// `sessions.usage` reads the usage OpenClaw recorded per model call, for one session
// (`key`) or all of an agent's (`agentId`), in a range of calendar days of the
// Gateway's own time zone (`mode: "gateway"`). Its `totals` are `{ input, output,
// cacheRead, cacheWrite, totalTokens, totalCost, missingCostEntries, … }`, and
// `aggregates.byProvider` the same per model provider (`{ provider, count, totals }`,
// `count` the model calls). A report still being computed marks its rows `computing`
// or its `cacheStatus.status` other than "fresh" (the first read after a turn).
//
// Cost: OpenClaw records what the provider billed (an OpenRouter answer's
// `usage.cost`), else an estimate from the model entry's `cost` (USD per 1M tokens),
// which AgentPier compiles from the provider catalog (assistant-models.js); a call
// with neither counts in `missingCostEntries`. Only the providers AgentPier compiled
// for a connection of the owner's (`ap-…`, assistant-models.js) are trusted with a
// cost: a ChatGPT account runs on OpenClaw's own `openai` provider, whose catalog
// estimate is no price the owner pays for a subscription, so its calls have none.

/** The currency of every cost OpenClaw records. */
export const usageCurrency = "USD";

const whole = (value) => (Number.isFinite(value) && value > 0 ? Math.round(value) : 0);
const amountOf = (value) => (Number.isFinite(value) && value > 0 ? value : 0);
const ownProvider = (provider) =>
  typeof provider === "string" && provider.startsWith("ap-");

/** `totals` as the port's token counts. */
export function usageTokens(totals) {
  const tokens = {
    input: whole(totals?.input),
    output: whole(totals?.output),
    cacheRead: whole(totals?.cacheRead),
    cacheWrite: whole(totals?.cacheWrite),
  };
  return {
    ...tokens,
    total:
      whole(totals?.totalTokens) ||
      tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
  };
}

/**
 * The cost of the provider rows `rows` (`[{ provider, count, totals }]`): `{ amount,
 * currency, partial }`, or null when no call has a known price. `partial`: some calls
 * have none (another provider's, or one OpenClaw could not price), so the amount is
 * a lower bound.
 */
export function usageCost(rows) {
  let amount = 0;
  let priced = false;
  let partial = false;
  for (const row of Array.isArray(rows) ? rows : []) {
    const totals = row?.totals;
    const calls = whole(row?.count);
    const missing = whole(totals?.missingCostEntries);
    const cost = amountOf(totals?.totalCost);
    if (!calls && !whole(totals?.totalTokens) && !cost) continue;
    if (!ownProvider(row.provider)) {
      partial = true;
      continue;
    }
    if (missing < calls || cost > 0) {
      priced = true;
      amount += cost;
    }
    if (missing > 0) partial = true;
  }
  if (!priced) return null;
  // Sums of floats: a cost is shown to a hundredth of a cent at most.
  return { amount: Math.round(amount * 1e6) / 1e6, currency: usageCurrency, partial };
}

// Whether the report was still being computed when it answered.
const pendingReport = (report) =>
  report?.partial !== undefined ||
  (report?.cacheStatus?.status !== undefined && report.cacheStatus.status !== "fresh") ||
  (Array.isArray(report?.sessions) && report.sessions.some((s) => s?.computing === true));

/** A `sessions.usage` report as `{ tokens, cost, pending }`. */
export function usageOf(report) {
  return {
    tokens: usageTokens(report?.totals),
    cost: usageCost(report?.aggregates?.byProvider),
    pending: pendingReport(report),
  };
}

/**
 * The context of a session's last model call from its `sessions.describe` entry:
 * `{ used, limit }` (`limit` the model's window, or null), or null while OpenClaw
 * holds no current size (`totalTokensFresh`).
 */
export function usageContext(session) {
  if (session?.totalTokensFresh !== true || !(whole(session.totalTokens) > 0))
    return null;
  return {
    used: whole(session.totalTokens),
    limit: whole(session.contextTokens) || null,
  };
}

const pad = (value) => String(value).padStart(2, "0");
/** The calendar day of `date` in the host's zone, as OpenClaw names days. */
export const dayKey = (date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** The last `days` calendar days up to the day of `now`: `{ from, to }` day keys. */
export function dayRange(days, now = Date.now()) {
  const end = new Date(now);
  const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - (days - 1));
  return { from: dayKey(start), to: dayKey(end) };
}

// Every day of the range with its tokens, the days without usage at 0.
function dailyTokens(report, days, now) {
  const known = new Map(
    (Array.isArray(report?.aggregates?.daily) ? report.aggregates.daily : []).map(
      (day) => [day?.date, whole(day?.tokens)],
    ),
  );
  const end = new Date(now);
  return Array.from({ length: days }, (_, index) => {
    const date = dayKey(
      new Date(end.getFullYear(), end.getMonth(), end.getDate() - (days - 1 - index)),
    );
    return { date, tokens: known.get(date) ?? 0 };
  });
}

// A report still computed right after a turn is read again, a few times at most.
const retryMs = [250, 500, 1000];
const contextRetryMs = [250, 500];
const usageTimeoutMs = 20000;
const maxDays = 366;

/**
 * The usage reads over `call` (the Gateway client's of the current connection).
 * `sleep` replaces the wait between reads of a report still being computed (tests).
 */
export function openClawUsage(call, { sleep } = {}) {
  const wait = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const report = async (params) => {
    let answer;
    for (let attempt = 0; ; attempt++) {
      answer = await call("sessions.usage", params, { timeoutMs: usageTimeoutMs });
      if (!pendingReport(answer) || attempt >= retryMs.length) return answer;
      await wait(retryMs[attempt]);
    }
  };
  return {
    // One session's whole usage and the context its last call read. At a run's end
    // the report is complete before the session names its new size (pinned 2026.11.6,
    // assistant-usage-contract): a session with usage and no current size is read
    // again, twice at most (a size stays unknown after a compaction).
    async session({ key }) {
      const usage = usageOf(
        await report({ key, range: "all", mode: "gateway", limit: 1 }),
      );
      let context = null;
      for (let attempt = 0; ; attempt++) {
        const described = await call("sessions.describe", { key }).catch(() => null);
        context = usageContext(described?.session);
        if (context || !usage.tokens.total || attempt >= contextRetryMs.length) break;
        await wait(contextRetryMs[attempt]);
      }
      return { ...usage, context };
    },
    // All of an agent's sessions over the last `days` calendar days.
    async agent({ agentId, days, now = Date.now() }) {
      if (!Number.isInteger(days) || days < 1 || days > maxDays)
        throw new TypeError("A usage range is 1 to 366 days.");
      const { from, to } = dayRange(days, now);
      const answer = await report({
        agentId,
        startDate: from,
        endDate: to,
        mode: "gateway",
        limit: 1,
      });
      return { from, to, ...usageOf(answer), daily: dailyTokens(answer, days, now) };
    },
  };
}
