import { execSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
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

    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("perl -pi -e");
    expect(commands[0]).toContain(join(destination, "lefthook.yml"));
    expect(commands[0]).toContain(join(destination, ".git/hooks/pre-commit"));
    expect(commands[0]).not.toContain("pre-push.sample");
    expect(notes).toContain("Si certains de ces fichiers sont versionnés, relire le diff avant de commiter.");

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

describe("shellQuote", () => {
  test("keeps any text literal, including a single quote", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(execSync(`printf %s ${shellQuote("a b $x `y` it's")}`, { shell: "/bin/bash" }).toString()).toBe("a b $x `y` it's");
  });
});
