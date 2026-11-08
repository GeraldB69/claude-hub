import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { executeMove, executeMoveWith, MOVE_ACTIONS, type MoveActions } from "../src/core/fs-safe.js";

import { createMoveFixture, type MoveFixture } from "./helpers/move-fixture.js";
import { createFakeHome, type FakeHome } from "./helpers/fake-home.js";

const isRoot = process.getuid?.() === 0;

describe("executeMove", () => {
  let fake: FakeHome;
  let fixture: MoveFixture;

  const statuses = (result: ReturnType<typeof executeMove>): string[] =>
    result.steps.map((step) => `${step.name}:${step.status}`);
  const claudeJson = (): { projects: Record<string, unknown> } =>
    JSON.parse(readFileSync(fixture.claudeJson, "utf8")) as { projects: Record<string, unknown> };

  beforeEach(() => {
    fake = createFakeHome();
    fixture = createMoveFixture(fake);
  });

  afterEach(() => {
    chmodSync(fake.home, 0o755);
    fake.cleanup();
  });

  test("moves the folder, renames the history keys, rewrites ~/.claude.json and the registry", () => {
    const result = executeMove(fixture.plan, { dryRun: false });

    expect(result.ok).toBe(true);
    expect(readFileSync(join(fixture.destination, "file.txt"), "utf8")).toBe("content");
    expect(existsSync(fixture.source)).toBe(false);
    const { plan } = fixture;
    expect(existsSync(join(plan.projectsDir, plan.oldKey))).toBe(false);
    expect(readFileSync(join(plan.projectsDir, plan.newKey, "memory/MEMORY.md"), "utf8")).toBe("memory");
    const sub = plan.subfolderKeys[0];
    expect(existsSync(join(plan.projectsDir, sub?.from ?? ""))).toBe(false);
    expect(existsSync(join(plan.projectsDir, sub?.to ?? "", "session.jsonl"))).toBe(true);
    expect(Object.keys(claudeJson().projects)).toEqual([fixture.destination, "/other"]);
    expect(readFileSync(fixture.registry, "utf8")).toBe(fixture.originalRegistry.replace("path: site", "path: perso/site"));
    expect(statuses(result)).toEqual([
      "backup:done",
      "parents:done",
      "directory:done",
      "history:done",
      "claude-json:done",
      "registry:done",
    ]);
  });

  test("keeps a copy of ~/.claude.json and of the registry before touching them", () => {
    const result = executeMove(fixture.plan, { dryRun: false });

    const backups = readdirSync(fixture.plan.backupDir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"));
    expect(result.ok).toBe(true);
    expect(backups).toContain(fixture.originalClaudeJson);
    expect(backups).toContain(fixture.originalRegistry);
  });

  test("does nothing in dry-run mode", () => {
    const result = executeMove(fixture.plan, { dryRun: true });

    expect(result.ok).toBe(true);
    expect(existsSync(fixture.source)).toBe(true);
    expect(existsSync(fixture.destination)).toBe(false);
    expect(readFileSync(fixture.claudeJson, "utf8")).toBe(fixture.originalClaudeJson);
    expect(statuses(result).every((status) => status.endsWith(":dry-run"))).toBe(true);
  });

  test("skips what does not exist: no history folder, no ~/.claude.json", () => {
    const result = executeMove(
      { ...fixture.plan, claudeJsonPath: join(fake.home, "missing.json"), projectsDir: join(fake.home, "no-projects") },
      { dryRun: false }
    );

    expect(result.ok).toBe(true);
    expect(statuses(result)).toContain("history:skipped");
    expect(statuses(result)).toContain("claude-json:skipped");
    expect(existsSync(fixture.destination)).toBe(true);
  });

  test("moves the folder but leaves ~/.claude.json untouched when its formatting is not the standard one", () => {
    writeFileSync(fixture.claudeJson, JSON.stringify(JSON.parse(fixture.originalClaudeJson)));

    const result = executeMove(fixture.plan, { dryRun: false });

    expect(result.ok).toBe(true);
    expect(statuses(result)).toContain("claude-json:skipped");
    expect(readFileSync(fixture.claudeJson, "utf8")).toBe(JSON.stringify(JSON.parse(fixture.originalClaudeJson)));
    expect(existsSync(fixture.destination)).toBe(true);
  });

  describe("sub-folder entries and special files", () => {
    test("renames the ~/.claude.json entries of sub-folders too", () => {
      const withSub = JSON.stringify(
        { projects: { [fixture.source]: {}, [join(fixture.source, "sub")]: { n: 2 }, "/other": {} } },
        null,
        2
      );
      writeFileSync(fixture.claudeJson, withSub);

      executeMove(fixture.plan, { dryRun: false });

      expect(Object.keys(claudeJson().projects)).toEqual([
        fixture.destination,
        join(fixture.destination, "sub"),
        "/other",
      ]);
    });

    test("leaves a ~/.claude.json that is a symbolic link alone, and still moves the folder", () => {
      const real = fake.writeFile("dotfiles/claude.json", fixture.originalClaudeJson);
      renameSync(fixture.claudeJson, `${fixture.claudeJson}.orig`);
      symlinkSync(real, fixture.claudeJson);

      const result = executeMove(fixture.plan, { dryRun: false });

      expect(result.ok).toBe(true);
      expect(result.steps.find((step) => step.name === "claude-json")).toMatchObject({ status: "skipped" });
      expect(readFileSync(real, "utf8")).toBe(fixture.originalClaudeJson);
      expect(existsSync(fixture.destination)).toBe(true);
    });
  });

  describe("failures inside the steps, and an undo that itself fails", () => {
    const noop = () => ({});
    const inert: MoveActions = {
      backup: noop,
      parents: noop,
      directory: noop,
      history: noop,
      "claude-json": noop,
      registry: noop,
    };
    const boom = (): never => {
      throw new Error("boom");
    };

    test("keeps undoing the other steps when one undo fails, and says what to do by hand", () => {
      const undone: string[] = [];
      const actions: MoveActions = {
        ...inert,
        directory: () => ({ undo: () => undone.push("directory") }),
        history: () => ({
          undo: () => {
            undone.push("history");
            boom();
          },
        }),
        registry: boom,
      };

      const result = executeMoveWith(fixture.plan, { dryRun: false }, actions);

      expect(result.ok).toBe(false);
      expect(result.rolledBack).toBe(false);
      expect(undone).toEqual(["history", "directory"]);
      expect(result.steps.find((step) => step.name === "history")?.status).toBe("rollback-failed");
      expect(result.steps.find((step) => step.name === "directory")?.status).toBe("rolled-back");
      expect(result.manual.join("\n")).toContain(fixture.plan.newKey);
    });

    test("gives a specific hand-written instruction for each step whose undo failed", () => {
      const actions: MoveActions = {
        ...inert,
        parents: () => ({ undo: boom }),
        directory: () => ({ undo: boom }),
        history: () => ({ undo: boom }),
        "claude-json": () => ({ undo: boom }),
        registry: boom,
      };

      const manual = executeMoveWith(fixture.plan, { dryRun: false }, actions).manual.join("\n");

      expect(manual).toContain(`mv "${fixture.destination}" "${fixture.source}"`);
      expect(manual).toContain(fixture.plan.claudeJsonPath);
      expect(manual).toContain(`« ${fixture.plan.newKey} » en « ${fixture.plan.oldKey} »`);
      expect(manual).toContain(join(fake.home, "ws/perso"));
    });

    test("warns that mv would nest the project when the original place is occupied again", () => {
      const occupied = Object.assign(new Error("occupied"), { code: "SOURCE_OCCUPIED" });
      const actions: MoveActions = {
        ...inert,
        directory: () => ({
          undo: () => {
            throw occupied;
          },
        }),
        registry: boom,
      };

      const manual = executeMoveWith(fixture.plan, { dryRun: false }, actions).manual.join("\n");

      expect(manual).toContain("occupé");
      expect(manual).toContain("ailleurs");
    });

    test("fails and undoes everything, instead of skipping silently, when the registry is a symbolic link", () => {
      const real = fake.writeFile("dotfiles/projects.yaml", fixture.originalRegistry);
      rmSync(fixture.registry);
      symlinkSync(real, fixture.registry);

      const result = executeMove(fixture.plan, { dryRun: false });

      expect(result.ok).toBe(false);
      expect(result.steps.find((step) => step.name === "registry")).toMatchObject({
        status: "failed",
        detail: "REGISTRY_UNUSABLE",
      });
      expect(result.rolledBack).toBe(true);
      expect(readFileSync(join(fixture.source, "file.txt"), "utf8")).toBe("content");
      expect(readFileSync(real, "utf8")).toBe(fixture.originalRegistry);
    });

    test("tells not to restore the backup when ~/.claude.json was changed by someone else meanwhile", () => {
      const actions: MoveActions = {
        ...MOVE_ACTIONS,
        registry: () => {
          writeFileSync(fixture.claudeJson, `${readFileSync(fixture.claudeJson, "utf8").slice(0, -1)},"intruder":1}`);
          throw new Error("registry failed");
        },
      };

      const result = executeMoveWith(fixture.plan, { dryRun: false }, actions);

      expect(result.ok).toBe(false);
      expect(result.rolledBack).toBe(false);
      expect(result.steps.find((step) => step.name === "claude-json")).toMatchObject({
        status: "rollback-failed",
        detail: "MODIFIED_BY_OTHER",
      });
      expect(result.manual.join("\n")).toContain("ne PAS restaurer");
      expect(readFileSync(fixture.claudeJson, "utf8")).toContain("intruder");
      expect(readFileSync(join(fixture.source, "file.txt"), "utf8")).toBe("content");
    });

    test("undoes the history renames already made when a later one conflicts", () => {
      const subTarget = fixture.plan.subfolderKeys[0]?.to ?? "";
      mkdirSync(join(fixture.projectsDir, subTarget), { recursive: true });

      const result = executeMove(fixture.plan, { dryRun: false });

      expect(result.ok).toBe(false);
      expect(result.rolledBack).toBe(true);
      expect(result.steps.find((step) => step.name === "history")?.detail).toBe("KEY_CONFLICT");
      expect(existsSync(join(fixture.projectsDir, fixture.plan.oldKey, "memory/MEMORY.md"))).toBe(true);
      expect(existsSync(join(fixture.projectsDir, fixture.plan.newKey))).toBe(false);
      expect(readFileSync(join(fixture.source, "file.txt"), "utf8")).toBe("content");
    });

    test("reports an invalid registry as a refusal with a readable detail, and undoes everything", () => {
      writeFileSync(fixture.registry, "projects: [oops");

      const result = executeMove(fixture.plan, { dryRun: false });

      expect(result.ok).toBe(false);
      expect(result.steps.find((step) => step.name === "registry")?.detail).toBe("REGISTRY_INVALID");
      expect(result.rolledBack).toBe(true);
      expect(readFileSync(join(fixture.source, "file.txt"), "utf8")).toBe("content");
      expect(readFileSync(fixture.claudeJson, "utf8")).toBe(fixture.originalClaudeJson);
    });

    test("is not interrupted by Ctrl-C while it works, and restores the handlers afterwards", () => {
      const before = process.listenerCount("SIGINT");
      let during = -1;
      const actions: MoveActions = {
        ...inert,
        directory: () => {
          during = process.listenerCount("SIGINT");
          return {};
        },
      };

      executeMoveWith(fixture.plan, { dryRun: false }, actions);

      expect(during).toBe(before + 1);
      expect(process.listenerCount("SIGINT")).toBe(before);
    });

    test("restores the handlers even when a step throws", () => {
      const before = process.listenerCount("SIGTERM");

      executeMoveWith(fixture.plan, { dryRun: false }, { ...inert, registry: boom });

      expect(process.listenerCount("SIGTERM")).toBe(before);
    });
  });

  describe("rollback", () => {
    test.skipIf(isRoot)("leaves no empty destination folder behind when the rename itself fails", () => {
      mkdirSync(join(fake.home, "ws/perso"));
      chmodSync(join(fake.home, "ws"), 0o555);

      const result = executeMove(fixture.plan, { dryRun: false });
      chmodSync(join(fake.home, "ws"), 0o755);

      expect(result.ok).toBe(false);
      expect(existsSync(fixture.destination)).toBe(false);
      expect(readFileSync(join(fixture.source, "file.txt"), "utf8")).toBe("content");
    });

    const expectPristine = () => {
      expect(readFileSync(join(fixture.source, "file.txt"), "utf8")).toBe("content");
      expect(existsSync(fixture.destination)).toBe(false);
      expect(existsSync(join(fake.home, "ws/perso"))).toBe(false);
      expect(existsSync(join(fixture.plan.projectsDir, fixture.plan.oldKey, "memory/MEMORY.md"))).toBe(true);
      expect(existsSync(join(fixture.plan.projectsDir, fixture.plan.newKey))).toBe(false);
      expect(existsSync(join(fixture.plan.projectsDir, fixture.plan.subfolderKeys[0]?.from ?? "", "session.jsonl"))).toBe(true);
    };

    test.skipIf(isRoot)("undoes the folder move and the history rename when ~/.claude.json cannot be written", () => {
      chmodSync(fake.home, 0o555);

      const result = executeMove(fixture.plan, { dryRun: false });
      chmodSync(fake.home, 0o755);

      expect(result.ok).toBe(false);
      expect(result.rolledBack).toBe(true);
      expect(statuses(result)).toContain("claude-json:failed");
      expect(statuses(result)).toContain("directory:rolled-back");
      expectPristine();
      expect(readFileSync(fixture.claudeJson, "utf8")).toBe(fixture.originalClaudeJson);
      expect(readFileSync(fixture.registry, "utf8")).toBe(fixture.originalRegistry);
    });

    test.skipIf(isRoot)("also restores ~/.claude.json when the registry cannot be written", () => {
      chmodSync(join(fake.home, "config"), 0o555);

      const result = executeMove(fixture.plan, { dryRun: false });
      chmodSync(join(fake.home, "config"), 0o755);

      expect(result.ok).toBe(false);
      expect(result.rolledBack).toBe(true);
      expect(statuses(result)).toContain("registry:failed");
      expect(statuses(result)).toContain("claude-json:rolled-back");
      expectPristine();
      expect(readFileSync(fixture.claudeJson, "utf8")).toBe(fixture.originalClaudeJson);
    });

    test("refuses, and changes nothing, when the destination appeared after the plan was made", () => {
      mkdirSync(fixture.destination, { recursive: true });

      const result = executeMove(fixture.plan, { dryRun: false });

      expect(result.ok).toBe(false);
      expect(result.steps.find((step) => step.status === "failed")?.detail).toBe("DEST_EXISTS");
      expect(readFileSync(join(fixture.source, "file.txt"), "utf8")).toBe("content");
      expect(readdirSync(fixture.destination)).toEqual([]);
    });

    test("refuses, and changes nothing, when the source became a symbolic link after the plan was made", () => {
      const real = fake.makeDir("real");
      writeFileSync(join(real, "file.txt"), "elsewhere");
      renameSync(fixture.source, `${fixture.source}.moved`);
      symlinkSync(real, fixture.source);

      const result = executeMove(fixture.plan, { dryRun: false });

      expect(result.ok).toBe(false);
      expect(existsSync(fixture.destination)).toBe(false);
      expect(readFileSync(join(real, "file.txt"), "utf8")).toBe("elsewhere");
    });

    test("removes the parent folders it created when it has to roll back", () => {
      expect(existsSync(join(fake.home, "ws/perso"))).toBe(false);
      writeFileSync(join(fixture.plan.projectsDir, fixture.plan.newKey), "a file where the history folder should go");

      const result = executeMove(fixture.plan, { dryRun: false });

      expect(result.ok).toBe(false);
      expect(result.rolledBack).toBe(true);
      expect(existsSync(join(fake.home, "ws/perso"))).toBe(false);
      expect(readFileSync(join(fixture.source, "file.txt"), "utf8")).toBe("content");
    });
  });
});
