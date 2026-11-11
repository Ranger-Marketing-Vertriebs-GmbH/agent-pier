import test from "node:test";
import assert from "node:assert/strict";
import { shellSegments } from "../../server/features/requests/shell-command.js";
import { riskyForm } from "../../server/features/requests/risky-forms.js";
import { startPlace } from "../../server/features/requests/approval-place.js";

// The session's project is /work/repo and its shell stands there.
const place = startPlace({ cwd: "/work/repo", roots: ["/work/repo"] });
const risky = (command, at = place) => riskyForm(shellSegments(command)[0], at);

test("forms that lose data, write elsewhere or choose what git runs are risky", () => {
  for (const command of [
    // branches and tags
    "git branch -D main",
    "git branch -d old",
    "git branch -M old new",
    "git branch -C old new",
    "git branch -f main HEAD~3",
    "git branch --delete old",
    "git branch --del old",
    "git branch --force main HEAD~3",
    "git branch -dr origin/old",
    "git -C sub branch -D old",
    "git --no-pager branch -D old",
    "git tag -d v1",
    "git tag --delete v1",
    "git tag -af v1 -m again",
    // a file written wherever the option says
    "git log --output=/tmp/x",
    "git diff --output /tmp/x",
    "git show --outp=x HEAD",
    "git log --ou=x",
    // a program the option names
    "git fetch --upload-pack=evil origin",
    "git fetch --upl evil origin",
    "git pull --upload-pack evil",
    "git push --receive-pack=evil origin main",
    "git push --exec=evil origin main",
    "git ls-remote --upload-pack=evil origin",
    "git clone -u evil url",
    "git --exec-path=/tmp/x log",
    "git --git-dir=/other/.git log",
    "git --work-tree=/ clean",
    "git --config-env=core.pager=X log",
    // push that overwrites or deletes
    "git push --force",
    "git push -f origin main",
    "git push -fu origin main",
    "git push --force-with-lease origin main",
    "git push --force-if-includes origin main",
    "git push --forc origin main",
    "git push --delete origin old",
    "git push -d origin old",
    "git push --mirror",
    "git push --prune origin",
    "git push origin +main",
    "git push origin :old",
    "git push origin +refs/heads/*:refs/heads/*",
    // the work tree thrown away
    "git reset --hard",
    "git reset --hard HEAD~1",
    "git reset --har",
    "git clean -f",
    "git clean -fd",
    "git clean -xdf",
    "git clean --force",
    "git checkout -- .",
    "git checkout .",
    "git checkout HEAD -- .",
    "git checkout -f",
    "git checkout --force main",
    "git checkout -- ':/'",
    "git restore .",
    "git restore --staged --worktree .",
    "git restore -s HEAD~1 -- .",
    "git restore -SW .",
    "git switch -f main",
    "git switch --force main",
    "git switch --discard-changes main",
    "git stash drop",
    "git stash clear",
    "git stash drop stash@{1}",
    "git worktree remove --force ../x",
    "git worktree remove -f x",
    // configuration
    "git config user.name x",
    "git config --global core.pager x",
    "git config --unset user.name",
    "git config --add remote.origin.fetch x",
    "git config --replace-all a.b c",
    "git config -e",
    "git config --edit",
    "git config set a.b c",
    "git config unset a.b",
    "git config --global",
    // rm of a tree, or outside the project
    "rm -rf build",
    "rm -r build",
    "rm -R build",
    "rm -fr build",
    "rm --recursive build",
    "rm --recurs build",
    "rm /etc/hosts",
    "rm ~/notes.md",
    "rm ../other/a.txt",
    "rm a.txt /other/b.txt",
    "rm -f -- /other/b.txt",
    "rm /oth*/x",
    "rm x{a,/../../y}",
  ])
    assert.equal(risky(command), true, command);
});

test("the everyday forms of the same programs are not", () => {
  for (const command of [
    "git branch feature",
    "git branch -m old new",
    "git branch -a",
    "git branch --set-upstream-to=origin/main",
    "git branch -u origin/main",
    "git tag v1",
    "git tag -l 'v*'",
    "git tag -a v1 -m release",
    "git log --oneline",
    "git log --show-signature",
    "git log --onel",
    "git diff --output-indicator-new=x",
    "git fetch origin",
    "git fetch --unshallow",
    "git push",
    "git push origin main",
    "git push -u origin feature",
    "git push --follow-tags",
    "git push --tags",
    "git push --dry-run",
    "git push origin main:main",
    "git push -o ci.skip origin main",
    "git reset",
    "git reset HEAD~1",
    "git reset --soft HEAD~1",
    "git reset -- file.js",
    "git clean -n",
    "git clean --dry-run",
    "git checkout main",
    "git checkout -b feature",
    "git checkout -- src/a.js",
    "git checkout HEAD~1 -- src",
    "git restore src/a.js",
    "git restore --staged .",
    "git restore -S .",
    "git switch main",
    "git switch -c feature",
    "git stash",
    "git stash push -m wip",
    "git stash pop",
    "git stash list",
    "git stash apply",
    "git worktree add ../x",
    "git worktree remove x",
    "git worktree list",
    "git config user.name",
    "git config --get user.name",
    "git config --get-regexp '^remote'",
    "git config --list",
    "git config -l --show-origin",
    "git config get user.name",
    "git config list",
    "git --no-pager log",
    "git -C sub commit -m x",
    "git commit --amend",
    "git rebase main",
    "rm a.txt",
    "rm -f a.txt b.txt",
    "rm -i a.txt",
    "rm src/*.tmp",
    "rm /work/repo/a.txt",
    "rm -- -r",
    "npm run build",
    "npm run deploy -- --force",
    "npm install",
    "cargo build",
    "docker rm -f x",
    "ls -R",
  ])
    assert.equal(risky(command), false, command);
});

test("rm is judged where it runs", () => {
  const elsewhere = { ...place, strayed: true };
  assert.equal(risky("rm a.txt", elsewhere), true);
  const sub = startPlace({ cwd: "/work/repo/sub", roots: ["/work/repo"] });
  assert.equal(risky("rm ../a.txt", sub), false);
  assert.equal(risky("rm ../../a.txt", sub), true);
  // Without a known folder a relative path that never goes up counts as inside.
  const unknown = startPlace(null);
  assert.equal(risky("rm a.txt", unknown), false);
  assert.equal(risky("rm ../a.txt", unknown), true);
  assert.equal(risky("rm /work/repo/a.txt", unknown), true);
});
