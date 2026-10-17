import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pushFigure, submitPlan } from "./publish.mjs";

const identity = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...identity } });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
  return result.stdout.trim();
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "anatomy-push-"));
  const remote = join(root, "remote.git");
  const work = join(root, "work");
  git(root, "init", "--quiet", "--bare", "-b", "main", remote);
  git(root, "clone", "--quiet", remote, work);
  writeFileSync(join(work, "README.md"), "gallery\n");
  git(work, "add", "README.md");
  git(work, "commit", "--quiet", "-m", "start");
  git(work, "push", "--quiet", "origin", "HEAD:refs/heads/main");
  const run = (tool, args) => {
    const result = spawnSync(tool, args, { cwd: work, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`${tool} ${args.slice(0, 2).join(" ")} failed:\n${result.stdout}${result.stderr}`);
    return result.stdout.trim();
  };
  const commitFigure = (author, id, text) => {
    mkdirSync(join(work, "figures", author, id), { recursive: true });
    writeFileSync(join(work, "figures", author, id, "figure.json"), text);
    git(work, "add", "--", `figures/${author}/${id}`);
    git(work, "commit", "--quiet", "-m", `Add ${id}`, "--", `figures/${author}/${id}`);
  };
  const fresh = () => git(work, "switch", "--quiet", "-C", "figure/token-bucket", "origin/main");
  return { root, remote, work, run, commitFigure, fresh };
}

const args = (remote, author = "octo-cat") => ({ url: remote, branch: "figure/token-bucket", folder: `figures/${author}/token-bucket`, target: "upstream/gallery" });

test("--submit's push step is a lease-guarded push, not a bare force", () => {
  const plan = submitPlan({ login: "wheresryan22", canPush: true, upstream: "wheresryan22/anatomy-community", author: "wheresryan22", id: "token-bucket", title: "Token bucket" });
  const push = plan.steps.find((step) => step.push);
  assert.deepEqual(push.push, { url: "https://github.com/wheresryan22/anatomy-community.git", branch: "figure/token-bucket", folder: "figures/wheresryan22/token-bucket", target: "wheresryan22/anatomy-community" });
  assert.ok(!plan.steps.some((step) => step.git?.includes("--force")));
});

test("a first push creates the branch, and a resubmit replaces its own earlier push", () => {
  const { root, remote, work, run, commitFigure, fresh } = setup();
  try {
    fresh();
    commitFigure("octo-cat", "token-bucket", "{\"v\":1}\n");
    pushFigure({ ...args(remote), run });
    assert.equal(git(work, "ls-remote", remote, "refs/heads/figure/token-bucket").split(/\s/)[0], git(work, "rev-parse", "HEAD"));
    fresh();
    commitFigure("octo-cat", "token-bucket", "{\"v\":2}\n");
    pushFigure({ ...args(remote), run });
    assert.equal(git(work, "ls-remote", remote, "refs/heads/figure/token-bucket").split(/\s/)[0], git(work, "rev-parse", "HEAD"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a branch that holds someone else's figure is left alone", () => {
  const { root, remote, work, run, commitFigure, fresh } = setup();
  try {
    fresh();
    commitFigure("someone-else", "token-bucket", "{\"theirs\":true}\n");
    pushFigure({ ...args(remote, "someone-else"), run });
    const theirs = git(work, "ls-remote", remote, "refs/heads/figure/token-bucket").split(/\s/)[0];
    fresh();
    commitFigure("octo-cat", "token-bucket", "{\"mine\":true}\n");
    assert.throws(() => pushFigure({ ...args(remote), run }), /already exists on upstream\/gallery and does not hold figures\/octo-cat\/token-bucket/);
    assert.equal(git(work, "ls-remote", remote, "refs/heads/figure/token-bucket").split(/\s/)[0], theirs);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a push is refused when the branch moved after it was read", () => {
  const { root, remote, work, commitFigure, fresh } = setup();
  try {
    fresh();
    commitFigure("octo-cat", "token-bucket", "{\"v\":1}\n");
    git(work, "push", "--quiet", remote, "HEAD:refs/heads/figure/token-bucket");
    fresh();
    commitFigure("octo-cat", "token-bucket", "{\"v\":2}\n");
    let moved = false;
    const run = (tool, argv) => {
      const result = spawnSync(tool, argv, { cwd: work, encoding: "utf8", env: { ...process.env, ...identity } });
      if (tool === "git" && argv[0] === "fetch" && !moved) {
        moved = true;
        const other = join(root, "other");
        git(root, "clone", "--quiet", remote, other);
        git(other, "switch", "--quiet", "figure/token-bucket");
        writeFileSync(join(other, "figures", "octo-cat", "token-bucket", "figure.json"), "{\"v\":\"raced\"}\n");
        git(other, "commit", "--quiet", "-am", "raced");
        git(other, "push", "--quiet", "origin", "figure/token-bucket");
      }
      if (result.status !== 0) throw new Error(`${tool} ${argv.slice(0, 2).join(" ")} failed:\n${result.stdout}${result.stderr}`);
      return result.stdout.trim();
    };
    assert.throws(() => pushFigure({ ...args(remote), run }), /git push --quiet failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
