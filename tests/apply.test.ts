import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { applyCommand } from "../src/commands/apply.js";
import type { Env, Io, Runtime } from "../src/core/env.js";

import { testEnv } from "./helpers/env.js";
import { createFakeHome, type FakeHome } from "./helpers/fake-home.js";

function fingerprint(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      return [`${path} -> ${readlinkSync(path)}`];
    }
    if (entry.isDirectory()) {
      return [`${path}/`, ...fingerprint(path)];
    }
    return [`${path} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`];
  });
}

const listFiles = (directory: string): string[] =>
  existsSync(directory)
    ? readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? listFiles(join(directory, entry.name)) : [join(directory, entry.name)]
      )
    : [];

interface Launch {
  readonly cwd: string;
  readonly args: readonly string[];
}

describe("applyCommand", () => {
  let fake: FakeHome;
  let env: Env;
  let project: string;
  let launches: Launch[];
  let exitCodes: number[];
  let onLaunch: (launch: Launch) => void;
  let stdout: string[];
  let stderr: string[];

  const io = (): Io => ({ out: (line) => stdout.push(line), err: (line) => stderr.push(line) });
  const runtime = (): Runtime => ({
    claudeProcesses: () => [],
    launchClaude(cwd, args) {
      const launch = { cwd, args };
      launches.push(launch);
      onLaunch(launch);
      return exitCodes.shift() ?? 0;
    },
  });
  const run = (argv: readonly string[]) => {
    const code = applyCommand(argv, env, io(), runtime());
    return { code, text: stdout.join("\n"), errors: stderr.join("\n") };
  };
  const settingsPath = () => join(project, ".claude/settings.json");
  const settings = (): unknown => JSON.parse(readFileSync(settingsPath(), "utf8"));
  const installArgs = (id: string, extra: readonly string[] = []) => ["plugin", "install", id, "--scope", "project", ...extra];

  beforeEach(() => {
    fake = createFakeHome();
    env = testEnv(fake);
    project = fake.makeDir("ws/site");
    launches = [];
    exitCodes = [];
    onLaunch = () => undefined;
    stdout = [];
    stderr = [];
    fake.writeFile(
      "config/profiles/web.yaml",
      "plugins:\n  - ctx@market\n  - other@market\nskillsOff:\n  - noisy\nconnectors: disabled\n"
    );
    fake.writeFile("config/profiles/bare.yaml", "");
    fake.writeFile("config/projects.yaml", "projects:\n  - { name: site, path: site, profile: web }\n");
  });

  afterEach(() => {
    fake.cleanup();
  });

  test("merges the profile into an existing settings.json, keeps the rest, and backs the original up", () => {
    mkdirSync(join(project, ".claude"));
    const original = '{\n  "model": "sonnet"\n}\n';
    writeFileSync(settingsPath(), original);

    const { code, text } = run(["site"]);

    expect(code).toBe(0);
    expect(settings()).toEqual({
      model: "sonnet",
      enabledPlugins: { "ctx@market": true, "other@market": true },
      skillOverrides: { noisy: "off" },
      disableClaudeAiConnectors: true,
    });
    const backups = listFiles(join(fake.home, "state/backups"));
    expect(backups.length).toBeGreaterThanOrEqual(1);
    expect(backups.map((file) => readFileSync(file, "utf8"))).toContain(original);
    expect(text).toContain("Sauvegarde");
  });

  test("backs the original up before claude touches it, so a rewrite by claude cannot lose it", () => {
    mkdirSync(join(project, ".claude"));
    const original = '{\n  "model": "sonnet"\n}\n';
    writeFileSync(settingsPath(), original);
    onLaunch = () => writeFileSync(settingsPath(), '{"claudeWrote":1}');

    run(["site"]);

    const contents = listFiles(join(fake.home, "state/backups")).map((file) => readFileSync(file, "utf8"));
    expect(contents).toContain(original);
  });

  test("makes no backup in a dry run or when the file does not exist yet, and reuses a copy that is still identical", () => {
    run(["site", "--dry-run"]);
    expect(listFiles(join(fake.home, "state/backups"))).toEqual([]);

    run(["site"]);
    expect(listFiles(join(fake.home, "state/backups"))).toEqual([]);

    run(["site"]);
    const backups = listFiles(join(fake.home, "state/backups"));
    expect(backups).toHaveLength(1);

    run(["site"]);
    expect(listFiles(join(fake.home, "state/backups"))).toEqual(backups);
  });

  test("backs the original up before claude runs even when the settings are already aligned", () => {
    mkdirSync(join(project, ".claude"));
    const aligned =
      '{"enabledPlugins":{"ctx@market":true,"other@market":true},"skillOverrides":{"noisy":"off"},"disableClaudeAiConnectors":true}';
    writeFileSync(settingsPath(), aligned);
    onLaunch = () => writeFileSync(settingsPath(), '{"claudeReformatted":true}');

    run(["site"]);

    const contents = listFiles(join(fake.home, "state/backups")).map((file) => readFileSync(file, "utf8"));
    expect(contents).toContain(aligned);
  });

  test("has already saved the original when claude starts", () => {
    mkdirSync(join(project, ".claude"));
    const original = '{"model":"sonnet"}';
    writeFileSync(settingsPath(), original);
    const savedWhenClaudeStarted: string[][] = [];
    onLaunch = () =>
      savedWhenClaudeStarted.push(listFiles(join(fake.home, "state/backups")).map((file) => readFileSync(file, "utf8")));

    run(["site"]);

    expect(savedWhenClaudeStarted[0]).toContain(original);
  });

  test.skipIf(process.getuid?.() === 0)("refuses a read-only settings.json before installing anything", () => {
    mkdirSync(join(project, ".claude"));
    writeFileSync(settingsPath(), "{}");
    chmodSync(settingsPath(), 0o444);

    const { code, errors } = run(["site"]);

    expect(code).toBe(3);
    expect(launches).toEqual([]);
    expect(errors).toContain("inscriptible");
  });

  test.skipIf(process.getuid?.() === 0)("refuses a .claude folder that cannot be written to, before installing anything", () => {
    mkdirSync(join(project, ".claude"));
    writeFileSync(settingsPath(), "{}");
    chmodSync(join(project, ".claude"), 0o555);

    try {
      const { code } = run(["site"]);

      expect(code).toBe(3);
      expect(launches).toEqual([]);
    } finally {
      chmodSync(join(project, ".claude"), 0o755);
    }
  });

  test.skipIf(process.getuid?.() === 0)("refuses a project folder that cannot be written to when it has no .claude yet", () => {
    chmodSync(project, 0o555);

    try {
      const { code } = run(["site"]);

      expect(code).toBe(3);
      expect(launches).toEqual([]);
    } finally {
      chmodSync(project, 0o755);
    }
  });

  test("refuses a settings.json that starts with a UTF-8 byte order mark, before installing", () => {
    mkdirSync(join(project, ".claude"));
    writeFileSync(settingsPath(), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("{}")]));

    const { code, errors } = run(["site"]);

    expect(code).toBe(3);
    expect(launches).toEqual([]);
    expect(errors).toContain("BOM");
  });

  test("tells which plugins stay installed, and where the original is saved, when a later install fails", () => {
    mkdirSync(join(project, ".claude"));
    writeFileSync(settingsPath(), '{"model":"sonnet"}');
    exitCodes = [0, 1];

    const { code, errors } = run(["site"]);

    expect(code).toBe(3);
    expect(launches).toHaveLength(2);
    expect(errors).toContain("other@market");
    expect(errors).toMatch(/déjà installés : ctx@market/);
    expect(errors).toContain("sauvegarde");
  });

  test("tells which plugins stay installed when the merge fails after the installs", () => {
    mkdirSync(join(project, ".claude"));
    writeFileSync(settingsPath(), "{}");
    onLaunch = () => writeFileSync(settingsPath(), "{oops");

    const { code, errors } = run(["site"]);

    expect(code).toBe(3);
    expect(errors).toContain("JSON invalide");
    expect(errors).toContain("ctx@market");
    expect(errors).toContain("other@market");
  });

  test("with --yes, says in plain words what claude will accept without asking", () => {
    const { text } = run(["site", "--yes", "--dry-run"]);

    expect(text).toContain("sans demander");
    expect(text).toContain("marketplaces");
  });

  test("without --yes, does not mention accepting anything silently", () => {
    expect(run(["site", "--dry-run"]).text).not.toContain("sans demander");
  });

  test("shows when the profile overrides an explicit contrary value, instead of presenting it as an addition", () => {
    mkdirSync(join(project, ".claude"));
    writeFileSync(
      settingsPath(),
      '{"enabledPlugins":{"ctx@market":false},"skillOverrides":{"noisy":"on"},"disableClaudeAiConnectors":false}'
    );

    const { text } = run(["site", "--dry-run"]);

    expect(text).toContain('~ctx@market (était false)');
    expect(text).toContain('~noisy (était "on")');
    expect(text).toContain("disableClaudeAiConnectors (était false)");
    expect(text).toContain("+other@market");
  });

  test("does not install anything when the backup cannot be made", () => {
    mkdirSync(join(project, ".claude"));
    writeFileSync(settingsPath(), "{}");
    writeFileSync(join(fake.home, "state"), "a file where the backup folder should be");

    const { code } = run(["site"]);

    expect(code).toBe(3);
    expect(launches).toEqual([]);
  });

  test("creates settings.json when the project has none", () => {
    const { code } = run(["site"]);

    expect(code).toBe(0);
    expect(settings()).toHaveProperty("enabledPlugins");
    expect(listFiles(join(fake.home, "state/backups"))).toEqual([]);
  });

  test("asks claude to install each plugin at project scope, in order, interactively by default", () => {
    run(["site"]);

    expect(launches).toEqual([
      { cwd: project, args: installArgs("ctx@market") },
      { cwd: project, args: installArgs("other@market") },
    ]);
  });

  test("passes -y to claude only when --yes is given", () => {
    run(["site", "--yes"]);

    expect(launches.map((launch) => launch.args)).toEqual([
      installArgs("ctx@market", ["-y"]),
      installArgs("other@market", ["-y"]),
    ]);
  });

  test("installs before merging, so the merge keeps what claude itself wrote", () => {
    onLaunch = () => {
      mkdirSync(join(project, ".claude"), { recursive: true });
      writeFileSync(settingsPath(), '{"fromClaude":1,"enabledPlugins":{"ctx@market":true}}');
    };

    run(["site"]);

    expect(settings()).toMatchObject({ fromClaude: 1, disableClaudeAiConnectors: true });
    expect(settings()).toMatchObject({ enabledPlugins: { "ctx@market": true, "other@market": true } });
  });

  test("stops at the first failed install, exits 3, and does not touch settings.json", () => {
    exitCodes = [1];

    const { code, errors } = run(["site"]);

    expect(code).toBe(3);
    expect(launches).toHaveLength(1);
    expect(errors).toContain("ctx@market");
    expect(existsSync(settingsPath())).toBe(false);
  });

  test("--dry-run prints the plan and the commands, runs nothing and writes nothing", () => {
    const before = fingerprint(fake.home);

    const { code, text } = run(["site", "--dry-run"]);

    expect(code).toBe(0);
    expect(launches).toEqual([]);
    expect(fingerprint(fake.home)).toEqual(before);
    expect(text).toContain("simulation");
    expect(text).toContain("claude plugin install ctx@market --scope project");
    expect(text).toContain("enabledPlugins");
  });

  test("a second run changes no project file, and a third one adds no backup at all", () => {
    run(["site"]);
    const afterFirst = fingerprint(project);

    run(["site"]);
    const backupsAfterSecond = listFiles(join(fake.home, "state/backups"));
    const { code, text } = run(["site"]);

    expect(code).toBe(0);
    expect(fingerprint(project)).toEqual(afterFirst);
    expect(listFiles(join(fake.home, "state/backups"))).toEqual(backupsAfterSecond);
    expect(backupsAfterSecond).toHaveLength(1);
    expect(text).toContain("réglages déjà alignés");
  });

  test("with a profile that has no plugin, only the settings are merged", () => {
    const { code } = run(["site", "--profile", "bare"]);

    expect(code).toBe(0);
    expect(launches).toEqual([]);
    expect(existsSync(settingsPath())).toBe(false);
  });

  test("lets --profile override the registry profile", () => {
    run(["site", "--profile", "bare"]);

    expect(launches).toEqual([]);
  });

  test("refuses an invalid settings.json before installing anything, and leaves it untouched", () => {
    mkdirSync(join(project, ".claude"));
    writeFileSync(settingsPath(), "{oops");

    const { code, errors } = run(["site"]);

    expect(code).toBe(3);
    expect(launches).toEqual([]);
    expect(readFileSync(settingsPath(), "utf8")).toBe("{oops");
    expect(errors).toContain("settings.json");
  });

  test("never echoes the content of an invalid settings.json", () => {
    mkdirSync(join(project, ".claude"));
    writeFileSync(settingsPath(), '{"token":"SECRET-123');

    const { errors } = run(["site"]);

    expect(errors).not.toContain("SECRET");
  });

  test("refuses a settings.json whose managed key has an unusable shape, before installing", () => {
    mkdirSync(join(project, ".claude"));
    writeFileSync(settingsPath(), '{"enabledPlugins":"nope"}');

    const { code } = run(["site"]);

    expect(code).toBe(3);
    expect(launches).toEqual([]);
  });

  test("refuses a .claude that is a symbolic link before installing anything", () => {
    const outside = fake.makeDir("outside");
    symlinkSync(outside, join(project, ".claude"));

    const { code, errors } = run(["site"]);

    expect(code).toBe(3);
    expect(launches).toEqual([]);
    expect(readdirSync(outside)).toEqual([]);
    expect(errors).toContain("lien symbolique");
  });

  test("refuses a settings.json that is a symbolic link before installing anything", () => {
    mkdirSync(join(project, ".claude"));
    const outside = fake.writeFile("outside.json", "{}");
    symlinkSync(outside, settingsPath());

    const { code } = run(["site"]);

    expect(code).toBe(3);
    expect(launches).toEqual([]);
    expect(readFileSync(outside, "utf8")).toBe("{}");
  });

  test.each([
    ["the home folder", (home: string) => home],
    ["the workspace root", (home: string) => `${home}/ws`],
  ])("refuses to apply a profile to %s", (_label, pick) => {
    const { code, errors } = run([pick(fake.home), "--profile", "web"]);

    expect(code).toBe(3);
    expect(errors).toContain("Refus");
    expect(launches).toEqual([]);
  });

  test("asks for a profile when the project is not registered and none is given", () => {
    const other = fake.makeDir("ws/other");

    const { code, errors } = run([other]);

    expect(code).toBe(2);
    expect(errors).toContain("--profile");
  });

  test("exits 3 and names an unknown profile", () => {
    const { code, errors } = run(["site", "--profile", "ghost"]);

    expect(code).toBe(3);
    expect(errors).toContain("ghost");
  });

  test("exits 3 when the target is not a directory", () => {
    const { code } = run([`${project}/missing`, "--profile", "bare"]);

    expect(code).toBe(3);
  });

  test.each([[[]], [["a", "b"]]])("exits 2 when the target is missing or doubled: %j", (argv) => {
    expect(run(argv).code).toBe(2);
  });

  test("exits 2 on an unknown option", () => {
    const { code, errors } = run(["site", "--bogus"]);

    expect(code).toBe(2);
    expect(errors).toContain("--bogus");
  });

  test("warns that claude installs the marketplace's current version, which may differ from the user-scope one", () => {
    const { text } = run(["site", "--dry-run"]);

    expect(text).toContain("version");
  });
});
