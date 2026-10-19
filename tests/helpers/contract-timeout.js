// A slower runner, such as the Intel macOS runner at about 2.2 times the duration of
// Apple silicon, sets AGENTPIER_CONTRACT_TIME_SCALE so the native contracts' wait
// budgets grow with the hardware. A real hang still fails, only later.
const scale = Math.max(1, Number(process.env.AGENTPIER_CONTRACT_TIME_SCALE) || 1);

export function contractTimeout(ms) {
  return Math.round(ms * scale);
}
