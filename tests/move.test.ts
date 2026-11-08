import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { moveCommand } from "../src/commands/move.js";
import type { ClaudeProcess, Env, Io, Runtime } from "../src/core/env.js";
import { main } from "../src/main.js";

import { createMoveFixture, type MoveFixture } from "./helpers/move-fixture.js";
import { testEnv } from "./helpers/env.js";
import { createFakeHome, type FakeHome } from "./helpers/fake-home.js";

const isRoot = process.getuid?.() === 0;

describe("moveCommand", () => {
  let fake: FakeHome;
  let env: Env;
  let fixture: MoveFixture;
  let processes: readonly ClaudeProcess[];
  let stdout: string[];
  let stderr: string[];

  const io = (): Io => ({ out: (line) => stdout.push(line), err: (line) => stderr.push(line) });
  const runtime = (): Runtime => ({ launchClaude: () => 0, claudeProcesses: () => processes });
  const run = (argv: readonly string[]) => {
    const code = moveCommand(argv, env, io(), runtime());
    return { code, text: stdout.join("\n"), errors: stderr.join("\n") };
  };
  const untouched = (): boolean =>
    existsSync(join(fixture.source, "file.txt")) && !existsSync(fixture.destination);

  beforeEach(() => {
    fake = createFakeHome();
    env = testEnv(fake);
    fixture = createMoveFixture(fake);
    processes = [];
    stdout = [];
    stderr = [];
  });

  afterEach(() => {
    chmodSync(fake.home, 0o755);
    fake.cleanup();
  });

  test("shows the plan but moves nothing without --yes, and says how to proceed", () => {
    const { code, text, errors } = run(["site", "perso/site"]);

    expect(code).toBe(2);
    expect(untouched()).toBe(true);
    expect(text).toContain(fixture.source);
    expect(text).toContain(fixture.destination);
    expect(text).toContain(fixture.plan.newKey);
    expect(text).toContain("perso/site");
    expect(errors).toContain("--yes");
  });

  test("--dry-run shows the plan and moves nothing", () => {
    const { code, text } = run(["site", "perso/site", "--dry-run"]);

    expect(code).toBe(0);
    expect(untouched()).toBe(true);
    expect(text).toContain("simulation");
  });

  test("--yes moves the project, its history and its registry entry, and says how to reopen it", () => {
    const { code, text } = run(["site", "perso/site", "--yes"]);

    expect(code).toBe(0);
    expect(readFileSync(join(fixture.destination, "file.txt"), "utf8")).toBe("content");
    expect(existsSync(fixture.source)).toBe(false);
    expect(existsSync(join(fixture.projectsDir, fixture.plan.newKey, "memory/MEMORY.md"))).toBe(true);
    expect(readFileSync(fixture.registry, "utf8")).toContain("path: perso/site");
    expect(text).toContain("ch open site");
  });

  test("renames the registry entry too when the project carried its folder's name, and says so", () => {
    const { code, text } = run(["site", "perso/vitrine", "--yes"]);

    expect(code).toBe(0);
    expect(text).toContain("nom site → vitrine");
    expect(text).toContain("ch open vitrine");
    expect(text).not.toContain("ch open site");
    const registry = readFileSync(fixture.registry, "utf8");
    expect(registry).toContain("name: vitrine");
    expect(registry).toContain("path: perso/vitrine");
    expect(registry).not.toContain("name: site");
  });

  test("keeps a registry name that was not the folder's name", () => {
    writeFileSync(fixture.registry, "projects:\n  - { name: alias, path: site, profile: base }\n");

    const { code, text } = run(["alias", "perso/vitrine", "--yes"]);

    expect(code).toBe(0);
    expect(text).not.toContain("nom alias");
    expect(text).toContain("ch open alias");
    expect(readFileSync(fixture.registry, "utf8")).toContain("name: alias");
  });

  test("refuses a rename that would collide with another project's name, and moves nothing", () => {
    writeFileSync(
      fixture.registry,
      "projects:\n  - { name: site, path: site, profile: base }\n  - { name: vitrine, path: autre, profile: base }\n"
    );

    const { code, errors } = run(["site", "perso/vitrine", "--yes"]);

    expect(code).toBe(3);
    expect(errors).toContain("« vitrine » est déjà pris");
    expect(untouched()).toBe(true);
  });

  test("refuses while a session runs in the project, lists the pid, and moves nothing", () => {
    processes = [{ pid: 4242, cwd: join(fixture.source, "sub"), ancestor: false }];

    const { code, errors } = run(["site", "perso/site", "--yes"]);

    expect(code).toBe(3);
    expect(errors).toContain("4242");
    expect(untouched()).toBe(true);
  });

  test("tells the user to leave Claude and use an ordinary terminal when the session running ch is in the project", () => {
    processes = [{ pid: 31, cwd: fixture.source, ancestor: true }];

    const { code, errors } = run(["site", "perso/site", "--yes"]);

    expect(code).toBe(3);
    expect(errors).toContain("terminal ordinaire");
    expect(errors).toContain("31");
    expect(untouched()).toBe(true);
  });

  test("fails closed, and says why, when the running sessions cannot be listed", () => {
    const failing: Runtime = {
      launchClaude: () => 0,
      claudeProcesses: () => {
        throw new Error("/proc est illisible : la détection des sessions Claude est impossible.");
      },
    };

    const code = moveCommand(["site", "perso/site", "--yes"], env, io(), failing);

    expect(code).toBe(3);
    expect(stderr.join("\n")).toContain("/proc");
    expect(untouched()).toBe(true);
  });

  test("says whether there is a history folder to rename", () => {
    const withHistory = run(["site", "perso/site", "--dry-run"]).text;
    stdout.length = 0;
    fake.cleanup();
    fake = createFakeHome();
    env = testEnv(fake);
    fixture = createMoveFixture(fake);
    rmSync(join(fixture.projectsDir, fixture.plan.oldKey), { recursive: true });

    const without = run(["site", "perso/site", "--dry-run"]).text;

    expect(withHistory).toContain("présent");
    expect(without).toContain("aucun");
  });

  test("repeats, after the move, that the project settings stay attached to the old path when ~/.claude.json was left alone", () => {
    writeFileSync(fixture.claudeJson, JSON.stringify(JSON.parse(fixture.originalClaudeJson)));

    const { text } = run(["site", "perso/site", "--yes"]);

    expect(text).toContain("ATTENTION");
    expect(text).toContain("ancien chemin");
  });

  test("does not add that warning when the ~/.claude.json entry was renamed", () => {
    expect(run(["site", "perso/site", "--yes"]).text).not.toContain("ATTENTION");
  });

  test("only warns about sessions elsewhere and still moves", () => {
    processes = [{ pid: 7, cwd: "/elsewhere", ancestor: false }];

    const { code, text } = run(["site", "perso/site", "--yes"]);

    expect(code).toBe(0);
    expect(text).toContain("session");
    expect(existsSync(fixture.destination)).toBe(true);
  });

  test("refuses an unknown project, and a prefix of a project name", () => {
    expect(run(["ghost", "perso/site", "--yes"]).code).toBe(2);
    expect(run(["si", "perso/site", "--yes"]).code).toBe(2);
    expect(untouched()).toBe(true);
  });

  test("refuses a destination that already exists", () => {
    fake.makeDir("ws/perso/site");

    const { code, errors } = run(["site", "perso/site", "--yes"]);

    expect(code).toBe(3);
    expect(errors).toContain("existe déjà");
    expect(existsSync(join(fixture.source, "file.txt"))).toBe(true);
  });

  test("reports every problem it found, not only the first", () => {
    fake.makeDir("ws/perso/site");
    processes = [{ pid: 9, cwd: fixture.source, ancestor: false }];

    const { errors } = run(["site", "perso/site", "--yes"]);

    expect(errors).toContain("existe déjà");
    expect(errors).toContain("9");
  });

  test("lists hard-coded references to the old path so they can be fixed afterwards", () => {
    writeFileSync(join(fixture.source, "run.sh"), `cd ${fixture.source}\n`);

    const { text } = run(["site", "perso/site", "--dry-run"]);

    expect(text).toContain("run.sh:1");
  });

  test("moves the folder and warns when ~/.claude.json cannot be rewritten safely", () => {
    writeFileSync(fixture.claudeJson, JSON.stringify(JSON.parse(fixture.originalClaudeJson)));

    const { code, text } = run(["site", "perso/site", "--yes"]);

    expect(code).toBe(0);
    expect(text).toContain(".claude.json");
    expect(text).toMatch(/ignoré/);
    expect(existsSync(fixture.destination)).toBe(true);
  });

  test.skipIf(isRoot)("undoes everything and says so when a step fails midway", () => {
    chmodSync(fake.home, 0o555);

    const { code, errors } = run(["site", "perso/site", "--yes"]);
    chmodSync(fake.home, 0o755);

    expect(code).toBe(3);
    expect(errors).toContain("annulé");
    expect(untouched()).toBe(true);
    expect(existsSync(join(fixture.projectsDir, fixture.plan.oldKey, "memory/MEMORY.md"))).toBe(true);
  });

  test("exits 3 when the registry is invalid", () => {
    writeFileSync(fixture.registry, "bogus: 1\n");

    expect(run(["site", "perso/site", "--yes"]).code).toBe(3);
  });

  test.each([[[]], [["site"]], [["a", "b", "c"]]])("exits 2 when the arguments are wrong: %j", (argv) => {
    expect(run(argv).code).toBe(2);
  });

  test("exits 2 on an unknown option", () => {
    const { code, errors } = run(["site", "perso/site", "--bogus"]);

    expect(code).toBe(2);
    expect(errors).toContain("--bogus");
  });

  test("is reachable through main", () => {
    const code = main(["move", "site", "perso/site", "--dry-run"], env, io(), runtime());

    expect(code).toBe(0);
  });
});
