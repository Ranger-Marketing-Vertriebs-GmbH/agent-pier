// A slower machine, for example a local run on old hardware, sets AGENTPIER_CONTRACT_TIME_SCALE so the native contracts' wait
// budgets grow with the hardware. A real hang still fails, only later.
const scale = Math.max(1, Number(process.env.AGENTPIER_CONTRACT_TIME_SCALE) || 1);

export function contractTimeout(ms) {
  return Math.round(ms * scale);
}
