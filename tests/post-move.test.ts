import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { planPostMove, shellQuote } from "../src/core/post-move.js";

import { createFakeHome, type FakeHome } from "./helpers/fake-home.js";

describe("planPostMove", () => {
  let fake: FakeHome;
  let source: string;
  let destination: string;

  beforeEach(() => {
    fake = createFakeHome();
    source = join(fake.home, "old/site");
    destination = fake.makeDir("new/site");
  });

  afterEach(() => {
    fake.cleanup();
  });

  test("says so when nothing mentions the old path", () => {
    fake.writeFile("new/site/README.md", "rien");

    expect(planPostMove(destination, source)).toEqual({ commands: [], notes: [] });
  });

  test("gives a command that rewrites the old path in files and in git hooks, and not in look-alike paths", () => {
    fake.writeFile("new/site/lefthook.yml", `run: node "${source}/scripts/a.mjs"\nother: ${source}-admin/x\n`);
    fake.writeFile("new/site/.git/hooks/pre-commit", `exec ${source}/bin/hook\n`);
    fake.writeFile("new/site/.git/hooks/pre-push.sample", `${source}\n`);

    const { commands, notes } = planPostMove(destination, source);

    expect(commands).toHaveLength(2);
    expect(commands[1]).toContain("rm -f --");
    expect(commands[0]).toContain("perl -pi.bak -e");
    expect(commands[0]).toContain(join(destination, "lefthook.yml"));
    expect(commands[0]).toContain(join(destination, ".git/hooks/pre-commit"));
    expect(commands[0]).not.toContain("pre-push.sample");
    expect(notes.join(" ")).toContain("relire le diff");

    execSync(commands[0] as string, { shell: "/bin/bash" });
    expect(readFileSync(join(destination, "lefthook.yml"), "utf8")).toBe(
      `run: node "${destination}/scripts/a.mjs"\nother: ${source}-admin/x\n`
    );
    expect(readFileSync(join(destination, ".git/hooks/pre-commit"), "utf8")).toBe(`exec ${destination}/bin/hook\n`);
  });

  test("gives the git command that repairs a linked worktree, run in the repository that owns it", () => {
    fake.writeFile("new/site/.worktrees/wt/.git", `gitdir: ${source}/.git/worktrees/wt\n`);
    mkdirSync(join(destination, ".git"), { recursive: true });

    const { commands } = planPostMove(destination, source);

    expect(commands).toEqual([`git -C '${destination}' worktree repair '${join(destination, ".worktrees/wt")}'`]);
  });

  test("uses the nested repository for a worktree of an app inside the project", () => {
    fake.writeFile("new/site/apps/todo/.worktrees/s1/.git", `gitdir: ${source}/apps/todo/.git/worktrees/s1\n`);
    mkdirSync(join(destination, "apps/todo/.git"), { recursive: true });

    const { commands } = planPostMove(destination, source);

    expect(commands).toEqual([
      `git -C '${join(destination, "apps/todo")}' worktree repair '${join(destination, "apps/todo/.worktrees/s1")}'`,
    ]);
  });

  test("leaves a path with special characters to the user instead of building an unsafe command", () => {
    const odd = join(fake.home, "old/it's here");
    fake.writeFile("new/site/a.txt", `${odd}\n`);

    const { commands, notes } = planPostMove(destination, odd);

    expect(commands).toEqual([]);
    expect(notes.join(" ")).toContain("caractères spéciaux");
  });

  test("reports a worktree link it cannot read", () => {
    fake.writeFile("new/site/wt/.git", `gitdir: ${source}/elsewhere\n`);

    const { commands, notes } = planPostMove(destination, source);

    expect(commands).toEqual([]);
    expect(notes.join(" ")).toContain("Worktrees non reconnus");
  });
});

describe("planPostMove, hostile or unusual projects", () => {
  let fake: FakeHome;
  let source: string;
  let destination: string;

  beforeEach(() => {
    fake = createFakeHome();
    source = join(fake.home, "old/site");
    destination = fake.makeDir("new/site");
  });

  afterEach(() => {
    fake.cleanup();
  });

  test("does not touch a path that merely ends with the old one, nor one that merely starts with it", () => {
    fake.writeFile("new/site/a.txt", `/mnt/x${source}/f\n${source}-admin/f\n${source}/ok\n`);

    const { commands } = planPostMove(destination, source);
    execSync(commands[0] as string, { shell: "/bin/bash" });

    expect(readFileSync(join(destination, "a.txt"), "utf8")).toBe(`/mnt/x${source}/f\n${source}-admin/f\n${destination}/ok\n`);
  });

  test("never throws on a broken symbolic link in .git/hooks, and ignores hooks that are links", () => {
    fake.writeFile("new/site/.git/hooks/keep", "x\n");
    symlinkSync("/nonexistent/target", join(destination, ".git/hooks/broken"));
    const shared = fake.writeFile("shared/hook", `${source}/x\n`);
    symlinkSync(shared, join(destination, ".git/hooks/linked"));

    expect(planPostMove(destination, source)).toEqual({ commands: [], notes: [] });
  });

  test("refuses a gitdir that climbs out of the project with .., and one that points at no repository", () => {
    fake.writeFile("new/site/a/.git", `gitdir: ${source}/../../victim/.git/worktrees/x\n`);
    fake.writeFile("new/site/b/.git", `gitdir: ${source}/missing/.git/worktrees/y\n`);

    const { commands, notes } = planPostMove(destination, source);

    expect(commands).toEqual([]);
    expect(notes.join(" ")).toContain("Worktrees non reconnus");
  });

  test("keeps shell metacharacters of a gitdir literal", () => {
    const repository = fake.makeDir("outside/it's $(touch pwned)");
    mkdirSync(join(repository, ".git"), { recursive: true });
    fake.writeFile("new/site/wt/.git", `gitdir: ${repository}/.git/worktrees/w\n`);

    const { commands } = planPostMove(destination, source);

    expect(commands).toEqual([`git -C '${repository.replaceAll("'", `'\\''`)}' worktree repair '${join(destination, "wt")}'`]);
  });

  test("repairs, from the repository that owns it, a worktree that stayed outside the moved project", () => {
    const outside = fake.makeDir("elsewhere/wt");
    fake.writeFile("elsewhere/wt/.git", `gitdir: ${source}/.git/worktrees/wt\n`);
    fake.writeFile("new/site/.git/worktrees/wt/gitdir", `${outside}/.git\n`);

    const { commands } = planPostMove(destination, source);

    expect(commands).toEqual([`git -C '${destination}' worktree repair '${outside}'`]);
  });

  test("proposes no command for a path with a control character, and shows it escaped", () => {
    fake.writeFile("new/site/bad\u001b[2Jname.txt", `${source}\n`);

    const { commands, notes } = planPostMove(destination, source);

    expect(commands).toEqual([]);
    expect(notes.join(" ")).toContain("\\u001b");
    expect(notes.join(" ")).not.toContain("\u001b");
  });

  test("a destination with special characters gets no command either", () => {
    const odd = fake.makeDir("new/it's here");
    fake.writeFile("new/it's here/a.txt", `${source}\n`);

    const { commands, notes } = planPostMove(odd, source);

    expect(commands).toEqual([]);
    expect(notes.join(" ")).toContain("caractères spéciaux");
  });
});

describe("shellQuote", () => {
  test("keeps any text literal, including a single quote", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(execSync(`printf %s ${shellQuote("a b $x `y` it's")}`, { shell: "/bin/bash" }).toString()).toBe("a b $x `y` it's");
  });
});
