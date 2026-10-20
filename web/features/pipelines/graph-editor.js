export function stagesToGraph(stages) {
  const nodes = [],
    edges = [];
  stages.forEach((stage, index) => {
    const id = stage.key;
    nodes.push(
      stage.kind === "parallel"
        ? {
            id,
            kind: "parallel",
            members: stage.members.map((m) => ({ id: m.key, profileId: m.profileId })),
            ...(stage.concurrency !== undefined
              ? { concurrency: stage.concurrency }
              : {}),
          }
        : { id, kind: "profile", profileId: stage.profileId },
    );
    let tail = id;
    for (const kind of ["verify", "gate", "createPr"])
      if (stage[kind]) {
        const next = stage.sideEffectIds?.[kind] || `${id}-${kind}`;
        nodes.push({ id: next, kind });
        edges.push({ from: tail, to: next, condition: "default" });
        tail = next;
      }
    if (index + 1 < stages.length)
      edges.push({ from: tail, to: stages[index + 1].key, condition: "default" });
    if (stage.loopBackTo)
      edges.push({
        from: id,
        to: stage.loopBackTo,
        condition: "fail",
        maxIterations: stage.maxIterations,
        ...(stage.continueSession ? { continueSession: true } : {}),
      });
  });
  return { entry: stages[0]?.key || "", nodes, edges };
}
export function graphToStages(graph) {
  if (!graph?.nodes?.length || !Array.isArray(graph.edges)) return null;
  const hasExtraKeys = (value, keys) =>
    Object.keys(value).some((key) => !keys.includes(key));
  if (
    hasExtraKeys(graph, ["entry", "nodes", "edges"]) ||
    graph.nodes.some((node) =>
      hasExtraKeys(node, ["id", "kind", "profileId", "members", "concurrency"]),
    ) ||
    graph.edges.some((edge) =>
      hasExtraKeys(edge, ["from", "to", "condition", "maxIterations", "continueSession"]),
    )
  )
    return null;
  const seen = new Set(),
    stages = [];
  let id = graph.entry;
  while (id) {
    if (seen.has(id)) return null;
    const node = graph.nodes.find((n) => n.id === id);
    if (!node || !isStage(node)) return null;
    seen.add(id);
    const stage = {
      key: id,
      ...(node.kind === "parallel"
        ? {
            kind: "parallel",
            members: (node.members || []).map((m) => ({
              key: m.id,
              profileId: m.profileId,
            })),
            concurrency: node.concurrency,
          }
        : { profileId: node.profileId }),
      gate: false,
      verify: false,
      createPr: false,
      sideEffectIds: {},
      loopBackTo: "",
      maxIterations: 2,
      continueSession: false,
    };
    const loops = graph.edges.filter((e) => e.from === id && e.condition === "fail");
    if (loops.length > 1) return null;
    if (loops.length) {
      // A loop returns to an earlier profile stage, never into a parallel group.
      if (!stages.some((s) => s.key === loops[0].to && s.kind !== "parallel"))
        return null;
      stage.loopBackTo = loops[0].to;
      stage.maxIterations = loops[0].maxIterations;
      stage.continueSession = loops[0].continueSession === true;
    }
    let tail = id;
    for (;;) {
      const next = graph.edges.filter((e) => e.from === tail && e.condition !== "fail");
      if (next.length > 1 || next.some((e) => e.condition !== "default")) return null;
      const target = graph.nodes.find((n) => n.id === next[0]?.to);
      if (!target) {
        if (next.length) return null;
        id = null;
        break;
      }
      if (isStage(target)) {
        id = target.id;
        break;
      }
      if (
        !["verify", "gate", "createPr"].includes(target.kind) ||
        seen.has(target.id) ||
        stage[target.kind] ||
        graph.edges.some((e) => e.from === target.id && e.condition === "fail")
      )
        return null;
      seen.add(target.id);
      stage[target.kind] = true;
      stage.sideEffectIds[target.kind] = target.id;
      tail = target.id;
    }
    stages.push(stage);
  }
  if (seen.size !== graph.nodes.length) return null;
  const rebuilt = stagesToGraph(stages);
  const canonical = (items) =>
    items
      .map((item) =>
        JSON.stringify(
          Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))),
        ),
      )
      .sort()
      .join("\n");
  if (
    canonical(rebuilt.nodes) !== canonical(graph.nodes) ||
    canonical(rebuilt.edges) !== canonical(graph.edges)
  )
    return null;
  return stages;
}
export const MAX_GROUP_MEMBERS = 8;
const isStage = (node) => node.kind === "profile" || node.kind === "parallel";
export function stageError(stages, copy) {
  if (!stages.length || stages.some((s) => s.kind !== "parallel" && !s.profileId))
    return copy.emptyStages;
  if (stages[0].kind === "parallel") return copy.groupFirst;
  if (
    stages.some(
      (s) =>
        s.kind === "parallel" &&
        (s.members.length < 2 ||
          s.members.length > MAX_GROUP_MEMBERS ||
          s.members.some((m) => !m.profileId)),
    )
  )
    return copy.invalidGroup;
  for (const [index, stage] of stages.entries())
    if (
      stage.loopBackTo &&
      (!stages
        .slice(0, index)
        .some((s) => s.key === stage.loopBackTo && s.kind !== "parallel") ||
        !Number.isInteger(stage.maxIterations) ||
        stage.maxIterations < 1 ||
        stage.maxIterations > 5)
    )
      return copy.invalidLoop;
  return "";
}
