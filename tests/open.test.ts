import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { openCommand } from "../src/commands/open.js";
import type { Env, Io, Runtime } from "../src/core/env.js";

import { testEnv } from "./helpers/env.js";
import { createFakeHome, type FakeHome } from "./helpers/fake-home.js";

interface Launch {
  readonly cwd: string;
  readonly args: readonly string[];
}

describe("openCommand", () => {
  let fake: FakeHome;
  let env: Env;
  let launches: Launch[];
  let exitCode: number;
  let stdout: string[];
  let stderr: string[];

  const io = (): Io => ({ out: (line) => stdout.push(line), err: (line) => stderr.push(line) });
  const runtime = (): Runtime => ({
    claudeProcesses: () => [],
    launchClaude(cwd, args) {
      launches.push({ cwd, args });
      return exitCode;
    },
  });
  const run = (argv: readonly string[]) => openCommand(argv, env, io(), runtime());

  beforeEach(() => {
    fake = createFakeHome();
    env = testEnv(fake);
    launches = [];
    exitCode = 0;
    stdout = [];
    stderr = [];
    fake.makeDir("ws/site/.claude");
    fake.writeFile("ws/site/.claude/settings.json", "{}");
    fake.makeDir("ws/site-admin");
    fake.makeDir("ws/tool");
    fake.writeFile(
      "config/projects.yaml",
      [
        "projects:",
        "  - { name: site, path: site, profile: web }",
        "  - { name: site-admin, path: site-admin, profile: web }",
        "  - { name: tool, path: tool, profile: web }",
        "",
      ].join("\n")
    );
  });

  afterEach(() => {
    fake.cleanup();
  });

  test("launches claude in the project folder and returns its exit code", () => {
    exitCode = 7;

    const code = run(["site"]);

    expect(code).toBe(7);
    expect(launches).toEqual([{ cwd: `${fake.home}/ws/site`, args: [] }]);
  });

  test("finds a project by unique prefix", () => {
    run(["to"]);

    expect(launches[0]?.cwd).toBe(`${fake.home}/ws/tool`);
  });

  test("lists the candidates and does not launch when the prefix is ambiguous", () => {
    const code = run(["si"]);

    expect(code).toBe(2);
    expect(launches).toEqual([]);
    expect(stderr.join("\n")).toContain("site-admin");
  });

  test("refuses an unknown project and mentions --force", () => {
    const code = run(["ghost"]);

    expect(code).toBe(2);
    expect(launches).toEqual([]);
    expect(stderr.join("\n")).toContain("--force");
  });

  test("--force launches in an existing folder that is not registered", () => {
    const other = fake.makeDir("elsewhere");

    const code = run([other, "--force"]);

    expect(code).toBe(0);
    expect(launches[0]?.cwd).toBe(other);
  });

  test("--force still refuses a path that is not a folder", () => {
    const code = run([`${fake.home}/nope`, "--force"]);

    expect(code).toBe(3);
    expect(launches).toEqual([]);
  });

  test("exits 3 when a registered folder is missing on disk", () => {
    fake.cleanup();
    fake = createFakeHome();
    env = testEnv(fake);
    fake.writeFile("config/projects.yaml", "projects:\n  - { name: site, path: site, profile: web }\n");

    const code = run(["site"]);

    expect(code).toBe(3);
    expect(launches).toEqual([]);
    expect(stderr.join("\n")).toContain("site");
  });

  test("--force opens an existing folder even when its name is a prefix of a registered project", () => {
    const local = fake.makeDir("to");
    env = testEnv(fake, { cwd: fake.home });

    run(["to", "--force"]);

    expect(launches[0]?.cwd).toBe(local);
  });

  test("--force accepts a relative path, resolved against the current folder", () => {
    fake.makeDir("elsewhere/sub");
    env = testEnv(fake, { cwd: `${fake.home}/elsewhere` });

    run(["sub", "--force"]);

    expect(launches[0]?.cwd).toBe(`${fake.home}/elsewhere/sub`);
  });

  test.each([
    ["the home folder", (home: string) => home],
    ["the workspace root", (home: string) => `${home}/ws`],
    ["the Claude user configuration folder", (home: string) => `${home}/.claude`],
  ])("refuses to open Claude in %s, even with --force", (_label, pick) => {
    fake.makeDir(".claude");

    const code = run([pick(fake.home), "--force"]);

    expect(code).toBe(3);
    expect(launches).toEqual([]);
    expect(stderr.join("\n")).toContain("Refus");
  });

  test("never turns a name starting with a dash into an option for claude", () => {
    expect(run(["-x"])).toBe(2);
    expect(run(["site", "--add-dir=-x"])).toBe(2);
    expect(launches).toEqual([]);
  });

  test("refuses an --add-dir whose folder is missing on disk", () => {
    fake.cleanup();
    fake = createFakeHome();
    env = testEnv(fake);
    fake.makeDir("ws/site/.claude");
    fake.writeFile("ws/site/.claude/settings.json", "{}");
    fake.writeFile(
      "config/projects.yaml",
      "projects:\n  - { name: site, path: site, profile: web }\n  - { name: gone, path: gone, profile: web }\n"
    );

    const code = run(["site", "--add-dir", "gone"]);

    expect(code).toBe(3);
    expect(launches).toEqual([]);
  });

  test("passes each --add-dir once and skips the main project itself", () => {
    run(["site", "--add-dir", "tool", "--add-dir", "tool", "--add-dir", "site"]);

    expect(launches[0]?.args).toEqual(["--add-dir", `${fake.home}/ws/tool`]);
  });

  test("passes the arguments after -- to claude untouched", () => {
    run(["site", "--", "--model", "haiku", "-p", "hello"]);

    expect(launches[0]?.args).toEqual(["--model", "haiku", "-p", "hello"]);
  });

  test("turns --add-dir <project> into the registered folder, before the passthrough arguments", () => {
    run(["site", "--add-dir", "tool", "--", "--model", "haiku"]);

    expect(launches[0]?.args).toEqual(["--add-dir", `${fake.home}/ws/tool`, "--model", "haiku"]);
  });

  test("refuses an --add-dir that is not a registered project", () => {
    const code = run(["site", "--add-dir", "ghost"]);

    expect(code).toBe(2);
    expect(launches).toEqual([]);
    expect(stderr.join("\n")).toContain("ghost");
  });

  test("warns when the project has no .claude/settings.json yet, and still launches", () => {
    run(["tool"]);

    expect(launches).toHaveLength(1);
    expect(stderr.join("\n")).toContain("ch init");
  });

  test("stays quiet when the project is already configured", () => {
    run(["site"]);

    expect(stderr).toEqual([]);
  });

  test("exits 3 when the registry is invalid", () => {
    fake.writeFile("config/projects.yaml", "bogus: 1\n");

    const code = run(["site"]);

    expect(code).toBe(3);
    expect(launches).toEqual([]);
  });

  test("exits 2 without a project argument", () => {
    expect(run([])).toBe(2);
  });

  test("exits 2 on an unknown option", () => {
    const code = run(["site", "--bogus"]);

    expect(code).toBe(2);
    expect(stderr.join("\n")).toContain("--bogus");
  });
});
