// A mail text extractor that reports what it inherited: its environment variable
// names and whether stdout and stderr lead to /dev/null.
import fs from "node:fs";

const isNull = (fd) => {
  const [stat, devNull] = [fs.fstatSync(fd), fs.statSync("/dev/null")];
  return stat.rdev === devNull.rdev && stat.ino === devNull.ino;
};

process.once("message", () => {
  const text = JSON.stringify({
    env: Object.keys(process.env),
    discarded: isNull(1) && isNull(2),
  });
  process.send({ text, truncated: false }, () => process.exit(0));
});
