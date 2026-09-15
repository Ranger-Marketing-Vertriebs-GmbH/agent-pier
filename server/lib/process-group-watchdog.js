const group = Number(process.argv[2]);
// If the leader died before startup, no native work was allowed to start.
if (
  !Number.isSafeInteger(group) ||
  group <= 1 ||
  group !== process.ppid ||
  !process.connected
)
  process.exit(1);

const stop = () => {
  try {
    // We are still a member: this group ID cannot have been reused elsewhere.
    process.kill(-group, "SIGKILL");
  } catch {
    process.exit(1);
  }
};
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});
process.on("message", () => {});
process.on("disconnect", stop);
process.send("ready", (error) => {
  if (error) stop();
});
