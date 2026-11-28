// Time guards that do not depend on what else the machine does. A test that says "this
// stays fast" means the work stays small (no backtracking, no quadratic scan), so it
// measures this thread's CPU time: the time other processes take on a busy runner is
// left out, where a wall-clock budget fails by chance.

const cpu = () => {
  const { user, system } = process.threadCpuUsage();
  return user + system;
};

/**
 * The CPU time `run()` takes on this thread, in milliseconds. For synchronous work
 * with a generous bound; Linux advances the counter only every 0.5 to 1 ms.
 */
export function cpuMs(run) {
  const start = cpu();
  run();
  return (cpu() - start) / 1000;
}

/**
 * How much longer `run(input(bytes * factor))` takes than `run(input(bytes))`: about
 * `factor` for a linear scan, about `factor` squared for a quadratic one (a regex that
 * backtracks from every position), whatever the machine's speed. Each measurement
 * repeats the run until 10 ms of CPU time have passed and takes the mean (the
 * counter's resolution); both sizes are measured in turns and the fastest turn of each
 * counts, so a slow stretch (a slower core, a collection) falls on both or neither.
 */
export function growth(run, input, bytes, { factor = 16, rounds = 3 } = {}) {
  const timed = (text) => {
    const start = cpu();
    let runs = 0;
    let spent = 0;
    do {
      run(text);
      runs++;
      spent = cpu() - start;
    } while (spent < 10000);
    return spent / runs;
  };
  const small = input(bytes);
  const large = input(bytes * factor);
  let fastestSmall = Infinity;
  let fastestLarge = Infinity;
  for (let round = 0; round < rounds; round++) {
    fastestSmall = Math.min(fastestSmall, timed(small));
    fastestLarge = Math.min(fastestLarge, timed(large));
  }
  return fastestLarge / fastestSmall;
}

/** The limit between linear and quadratic growth for `factor`: a factor of √factor from both. */
export const linearAtMost = (factor = 16) => factor ** 1.5;
