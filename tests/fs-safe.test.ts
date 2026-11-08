import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { applyOperations } from "../src/core/fs-safe.js";
import type { Operation } from "../src/core/operations.js";
import type { SettingsPatch } from "../src/core/settings.js";

import { createFakeHome, type FakeHome } from "./helpers/fake-home.js";

const isRoot = process.getuid?.() === 0;

describe("applyOperations", () => {
  let fake: FakeHome;
  let project: string;

  const apply = (operations: readonly Operation[], dryRun = false) =>
    applyOperations(operations, { dryRun, root: project });

  beforeEach(() => {
    fake = createFakeHome();
    project = fake.makeDir("project");
  });

  afterEach(() => {
    fake.cleanup();
  });

  test("creates folders recursively and files with their content", () => {
    const dir = join(project, "a/b");
    const file = join(dir, "f.txt");

    const results = apply([
      { kind: "mkdir", path: dir },
      { kind: "create", path: file, content: "hello" },
    ]);

    expect(readFileSync(file, "utf8")).toBe("hello");
    expect(results.map((result) => result.status)).toEqual(["done", "done"]);
  });

  test("refuses to overwrite a file that appeared after the plan was made", () => {
    const file = join(project, "f.txt");
    writeFileSync(file, "original");

    const results = apply([{ kind: "create", path: file, content: "new" }]);

    expect(readFileSync(file, "utf8")).toBe("original");
    expect(results[0]).toMatchObject({ status: "conflict", detail: "EXISTS" });
  });

  describe("append-line", () => {
    test("appends a line, adding the missing final newline", () => {
      const file = join(project, "g.txt");
      writeFileSync(file, "one");

      apply([{ kind: "append-line", path: file, line: "two" }]);

      expect(readFileSync(file, "utf8")).toBe("one\ntwo\n");
    });

    test("does not add the line twice", () => {
      const file = join(project, "g.txt");
      writeFileSync(file, "one\ntwo\n");

      apply([{ kind: "append-line", path: file, line: "two" }]);

      expect(readFileSync(file, "utf8")).toBe("one\ntwo\n");
    });

    test("keeps the file mode", () => {
      const file = join(project, "h.txt");
      writeFileSync(file, "x\n");
      chmodSync(file, 0o600);

      apply([{ kind: "append-line", path: file, line: "y" }]);

      expect(statSync(file).mode & 0o777).toBe(0o600);
    });

    test("leaves no temporary file behind and never touches a file the user named like the old temporary", () => {
      const file = join(project, "g.txt");
      writeFileSync(file, "one\n");
      writeFileSync(`${file}.ch-tmp`, "belongs to the user");

      apply([{ kind: "append-line", path: file, line: "two" }]);

      expect(readFileSync(`${file}.ch-tmp`, "utf8")).toBe("belongs to the user");
      expect(readdirSync(project).sort()).toEqual(["g.txt", "g.txt.ch-tmp"]);
    });

    test("refuses a file that became a symbolic link, and keeps both the link and its target intact", () => {
      const outside = fake.writeFile("outside.txt", "secret\n");
      const file = join(project, ".gitignore");
      symlinkSync(outside, file);

      const results = apply([{ kind: "append-line", path: file, line: "x" }]);

      expect(results[0]).toMatchObject({ status: "conflict", detail: "SYMLINK" });
      expect(readFileSync(outside, "utf8")).toBe("secret\n");
      expect(lstatSync(file).isSymbolicLink()).toBe(true);
    });

    test("refuses a file that does not exist", () => {
      const results = apply([{ kind: "append-line", path: join(project, "missing.txt"), line: "x" }]);

      expect(results[0]).toMatchObject({ status: "conflict", detail: "NOT_A_FILE" });
    });

    test.skipIf(isRoot)("refuses a read-only file instead of replacing it by renaming over it", () => {
      const file = join(project, "ro.txt");
      writeFileSync(file, "x\n");
      chmodSync(file, 0o444);

      const results = apply([{ kind: "append-line", path: file, line: "y" }]);

      expect(results[0]).toMatchObject({ status: "conflict", detail: "READ_ONLY" });
      expect(readFileSync(file, "utf8")).toBe("x\n");
    });
  });

  describe("confinement to the project root", () => {
    test("refuses a path outside the root, including a sibling that shares the name prefix", () => {
      const sibling = `${project}-evil`;
      mkdirSync(sibling);

      const results = apply([{ kind: "create", path: join(sibling, "f.txt"), content: "x" }]);

      expect(results[0]).toMatchObject({ status: "conflict", detail: "OUTSIDE_ROOT" });
      expect(existsSync(join(sibling, "f.txt"))).toBe(false);
    });

    test("refuses a path that climbs out of the root with ..", () => {
      const results = apply([{ kind: "create", path: join(project, "..", "escape.txt"), content: "x" }]);

      expect(results[0]).toMatchObject({ status: "conflict", detail: "OUTSIDE_ROOT" });
      expect(existsSync(join(fake.home, "escape.txt"))).toBe(false);
    });

    test("accepts a file whose name merely starts with two dots", () => {
      const results = apply([{ kind: "create", path: join(project, "..hidden"), content: "x" }]);

      expect(results[0]?.status).toBe("done");
    });

    test("refuses to create folders through a link that replaced a folder after the plan was made", () => {
      const outside = fake.makeDir("outside");
      symlinkSync(outside, join(project, ".claude"));

      const results = apply([
        { kind: "mkdir", path: join(project, ".claude") },
        { kind: "create", path: join(project, ".claude/settings.json"), content: "{}" },
      ]);

      expect(results.map((result) => result.status)).toEqual(["conflict", "skipped"]);
      expect(results[0]?.detail).toBe("SYMLINK");
      expect(readdirSync(outside)).toEqual([]);
    });

    test("refuses to create a file below a linked intermediate folder", () => {
      const outside = fake.makeDir("outside");
      mkdirSync(join(outside, "ai"));
      symlinkSync(outside, join(project, "docs"));

      const results = apply([{ kind: "create", path: join(project, "docs/ai/.gitkeep"), content: "" }]);

      expect(results[0]).toMatchObject({ status: "conflict", detail: "SYMLINK" });
      expect(readdirSync(join(outside, "ai"))).toEqual([]);
    });

    test("refuses to create a file where a dangling link sits", () => {
      symlinkSync(join(fake.home, "nowhere"), join(project, "CLAUDE.md"));

      const results = apply([{ kind: "create", path: join(project, "CLAUDE.md"), content: "x" }]);

      expect(results[0]?.status).toBe("conflict");
      expect(existsSync(join(fake.home, "nowhere"))).toBe(false);
    });
  });

  describe("backup", () => {
    const backupDir = () => join(fake.home, "state/backups");
    const backup = (path: string, dryRun = false) =>
      applyOperations([{ kind: "backup", path, backupDir: backupDir() }], { dryRun, root: project });

    test("copies the file byte for byte into a private timestamped folder", () => {
      const file = join(project, "settings.json");
      const original = '{ "model" :  "sonnet" }\n';
      writeFileSync(file, original);

      const [result] = backup(file);

      expect(result?.status).toBe("done");
      expect(readFileSync(result?.backup ?? "", "utf8")).toBe(original);
      expect(statSync(result?.backup ?? "").mode & 0o777).toBe(0o600);
      expect(readFileSync(file, "utf8")).toBe(original);
    });

    test("keeps bytes that are not valid UTF-8 intact", () => {
      const file = join(project, "binary.json");
      const bytes = Buffer.from([0x7b, 0xff, 0xfe, 0x80, 0x7d]);
      writeFileSync(file, bytes);

      const [result] = backup(file);

      expect(readFileSync(result?.backup ?? "").equals(bytes)).toBe(true);
    });

    test("creates the backup folders readable by the owner only", () => {
      const file = join(project, "settings.json");
      writeFileSync(file, "{}");

      const [result] = backup(file);

      const stampFolder = join(result?.backup ?? "", "..");
      expect(statSync(stampFolder).mode & 0o777).toBe(0o700);
    });

    test("reuses the existing copy when the content is unchanged, and makes a new one when it changes", () => {
      const file = join(project, "settings.json");
      writeFileSync(file, '{"a":1}');

      const first = backup(file)[0]?.backup;
      const again = backup(file)[0]?.backup;
      writeFileSync(file, '{"a":2}');
      const changed = backup(file)[0]?.backup;

      expect(again).toBe(first);
      expect(changed).not.toBe(first);
      expect(readFileSync(first ?? "", "utf8")).toBe('{"a":1}');
      expect(readFileSync(changed ?? "", "utf8")).toBe('{"a":2}');
      expect(readdirSync(backupDir())).toHaveLength(2);
    });

    test("does not mistake the copy of another file with the same content for its own", () => {
      const one = join(project, "one.json");
      const two = join(project, "two.json");
      writeFileSync(one, "{}");
      writeFileSync(two, "{}");

      const first = backup(one)[0]?.backup;
      const second = backup(two)[0]?.backup;

      expect(second).not.toBe(first);
    });

    test("does nothing when the file does not exist", () => {
      const [result] = backup(join(project, "absent.json"));

      expect(result?.status).toBe("done");
      expect(result?.backup).toBeUndefined();
      expect(existsSync(backupDir())).toBe(false);
    });

    test("refuses a symbolic link and a folder", () => {
      const outside = fake.writeFile("outside.json", "{}");
      symlinkSync(outside, join(project, "link.json"));
      mkdirSync(join(project, "folder.json"));

      expect(backup(join(project, "link.json"))[0]).toMatchObject({ status: "conflict", detail: "SYMLINK" });
      expect(backup(join(project, "folder.json"))[0]).toMatchObject({ status: "conflict", detail: "NOT_A_FILE" });
    });

    test("does nothing in dry-run mode", () => {
      const file = join(project, "settings.json");
      writeFileSync(file, "{}");

      expect(backup(file, true)[0]?.status).toBe("dry-run");
      expect(existsSync(backupDir())).toBe(false);
    });
  });

  describe("merge-json", () => {
    let backupDir: string;
    const merge = (path: string, patch: SettingsPatch) =>
      apply([{ kind: "merge-json", path, patch, backupDir }]);

    beforeEach(() => {
      backupDir = join(fake.home, "state/backups");
    });

    test("creates the file, and its folder, when it is absent", () => {
      const file = join(project, ".claude/settings.json");

      const results = merge(file, { enabledPlugins: { "a@m": true } });

      expect(results[0]?.status).toBe("done");
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ enabledPlugins: { "a@m": true } });
      expect(results[0]?.backup).toBeUndefined();
    });

    test("merges into an existing file and backs the original up first, byte for byte", () => {
      const file = join(project, "settings.json");
      const original = '{\n  "model": "sonnet",\n  "enabledPlugins": { "keep@m": true }\n}\n';
      writeFileSync(file, original);

      const results = merge(file, { enabledPlugins: { "a@m": true } });

      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
        model: "sonnet",
        enabledPlugins: { "keep@m": true, "a@m": true },
      });
      const backup = results[0]?.backup;
      expect(backup).toBeDefined();
      expect(readFileSync(backup ?? "", "utf8")).toBe(original);
      expect(backup?.startsWith(backupDir)).toBe(true);
    });

    test("keeps the file mode and makes the backup private", () => {
      const file = join(project, "settings.json");
      writeFileSync(file, "{}");
      chmodSync(file, 0o640);

      const results = merge(file, { disableClaudeAiConnectors: true });

      expect(statSync(file).mode & 0o777).toBe(0o640);
      expect(statSync(results[0]?.backup ?? "").mode & 0o777).toBe(0o600);
    });

    test("touches nothing and makes no backup when the file is already aligned", () => {
      const file = join(project, "settings.json");
      writeFileSync(file, '{"disableClaudeAiConnectors":true}');

      const results = merge(file, { disableClaudeAiConnectors: true });

      expect(results[0]?.status).toBe("done");
      expect(results[0]?.backup).toBeUndefined();
      expect(readFileSync(file, "utf8")).toBe('{"disableClaudeAiConnectors":true}');
      expect(existsSync(backupDir)).toBe(false);
    });

    test("refuses a file that starts with a UTF-8 byte order mark, untouched", () => {
      const file = join(project, "bom.json");
      writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("{}")]));

      const results = merge(file, { disableClaudeAiConnectors: true });

      expect(results[0]).toMatchObject({ status: "conflict", detail: "BOM" });
      expect(existsSync(backupDir)).toBe(false);
    });

    test("keeps a __proto__ key of the existing file as plain data", () => {
      const file = join(project, "proto.json");
      writeFileSync(file, '{"skillOverrides":{"__proto__":"keep"}}');

      merge(file, { skillOverrides: { added: "off" } });

      const parsed = JSON.parse(readFileSync(file, "utf8")) as { skillOverrides: Record<string, string> };
      expect(Object.keys(parsed.skillOverrides).sort()).toEqual(["__proto__", "added"]);
      expect(({} as Record<string, unknown>)["keep"]).toBeUndefined();
    });

    test.each([
      ["not JSON", "{oops", "INVALID_JSON"],
      ["a JSON array", "[]", "INVALID_JSON"],
      ["an unusable managed key", '{"enabledPlugins":"x"}', "INVALID_STRUCTURE"],
    ])("refuses a file that is %s and leaves it untouched", (_label, content, detail) => {
      const file = join(project, "settings.json");
      writeFileSync(file, content);

      const results = merge(file, { enabledPlugins: { "a@m": true } });

      expect(results[0]).toMatchObject({ status: "conflict", detail });
      expect(readFileSync(file, "utf8")).toBe(content);
      expect(existsSync(backupDir)).toBe(false);
    });

    test("never echoes the file content in a refusal", () => {
      const file = join(project, "settings.json");
      writeFileSync(file, '{"token":"SECRET-123');

      const results = merge(file, {});

      expect(JSON.stringify(results)).not.toContain("SECRET");
    });

    test("refuses a symbolic link, leaving link and target intact", () => {
      const outside = fake.writeFile("outside.json", "{}");
      const file = join(project, "settings.json");
      symlinkSync(outside, file);

      const results = merge(file, { disableClaudeAiConnectors: true });

      expect(results[0]).toMatchObject({ status: "conflict", detail: "SYMLINK" });
      expect(readFileSync(outside, "utf8")).toBe("{}");
    });

    test.skipIf(isRoot)("refuses a read-only file", () => {
      const file = join(project, "settings.json");
      writeFileSync(file, "{}");
      chmodSync(file, 0o444);

      expect(merge(file, { disableClaudeAiConnectors: true })[0]).toMatchObject({
        status: "conflict",
        detail: "READ_ONLY",
      });
    });

    test("does nothing in dry-run mode", () => {
      const file = join(project, "settings.json");
      writeFileSync(file, "{}");

      const results = applyOperations(
        [{ kind: "merge-json", path: file, patch: { disableClaudeAiConnectors: true }, backupDir }],
        { dryRun: true, root: project }
      );

      expect(results[0]?.status).toBe("dry-run");
      expect(readFileSync(file, "utf8")).toBe("{}");
    });
  });

  test("does nothing in dry-run mode", () => {
    const file = join(project, "never.txt");

    const results = apply([{ kind: "create", path: file, content: "x" }], true);

    expect(existsSync(file)).toBe(false);
    expect(results[0]?.status).toBe("dry-run");
  });

  test("returns no result for an empty plan", () => {
    expect(apply([])).toEqual([]);
  });

  test("stops at the first failure and reports the operations it did not run as skipped", () => {
    const blocker = join(project, "blocker");
    writeFileSync(blocker, "a file, not a folder");
    const later = join(project, "later.txt");

    const results = apply([
      { kind: "mkdir", path: join(blocker, "sub") },
      { kind: "create", path: later, content: "x" },
    ]);

    expect(results.map((result) => result.status)).toEqual(["error", "skipped"]);
    expect(results[0]?.detail).toBeTruthy();
    expect(existsSync(later)).toBe(false);
  });
});
