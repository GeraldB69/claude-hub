import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { lsCommand } from "../src/commands/ls.js";
import type { Env, Io } from "../src/core/env.js";

import { testEnv } from "./helpers/env.js";
import { createFakeHome, type FakeHome } from "./helpers/fake-home.js";

describe("lsCommand", () => {
  let fake: FakeHome;
  let env: Env;
  let stdout: string[];
  let stderr: string[];

  const io = (): Io => ({ out: (line) => stdout.push(line), err: (line) => stderr.push(line) });
  const run = (argv: readonly string[] = []) => lsCommand(argv, env, io());

  beforeEach(() => {
    fake = createFakeHome();
    env = testEnv(fake);
    stdout = [];
    stderr = [];
    fake.makeDir("ws/perso/site/.git");
    fake.makeDir("ws/labs/tool/.git");
    fake.makeDir("ws/labs/new-thing/.git");
    fake.writeFile(
      "config/projects.yaml",
      [
        "projects:",
        "  - { name: site, path: perso/site, profile: web }",
        "  - { name: tool, path: labs/tool, profile: base }",
        "  - { name: gone, path: labs/gone, profile: base }",
        "",
      ].join("\n")
    );
  });

  afterEach(() => {
    fake.cleanup();
  });

  test("groups registered projects by folder", () => {
    const code = run();

    expect(code).toBe(0);
    const text = stdout.join("\n");
    expect(text).toContain("labs");
    expect(text).toContain("perso");
    expect(text.indexOf("labs")).toBeLessThan(text.indexOf("tool"));
    expect(text.indexOf("perso")).toBeLessThan(text.indexOf("site"));
  });

  test("flags a registered project missing on disk", () => {
    run();

    expect(stdout.find((line) => line.includes("gone"))).toContain("introuvable");
  });

  test("lists repositories found on disk but absent from the registry", () => {
    run();

    const text = stdout.join("\n");
    expect(text).toContain("Hors registre");
    expect(text).toContain("labs/new-thing");
    expect(text).not.toMatch(/Hors registre[\s\S]*labs\/tool/);
  });

  test("prints no unregistered section when everything is registered", () => {
    fake.cleanup();
    fake = createFakeHome();
    env = testEnv(fake);
    fake.makeDir("ws/labs/tool/.git");
    fake.writeFile("config/projects.yaml", "projects:\n  - { name: tool, path: labs/tool, profile: base }\n");

    run();

    expect(stdout.join("\n")).not.toContain("Hors registre");
  });

  test("emits json with --json", () => {
    run(["--json"]);

    const data = JSON.parse(stdout.join("\n")) as {
      projects: { name: string; folder: string; exists: boolean }[];
      unregistered: string[];
    };
    expect(data.projects.map((p) => p.name).toSorted()).toEqual(["gone", "site", "tool"]);
    expect(data.projects.find((p) => p.name === "gone")?.exists).toBe(false);
    expect(data.projects.find((p) => p.name === "site")?.folder).toBe("perso");
    expect(data.unregistered).toEqual(["labs/new-thing"]);
  });

  test("rejects an unknown option", () => {
    const code = run(["--bogus"]);

    expect(code).toBe(2);
    expect(stderr.join("\n")).toContain("ch ls");
  });

  test("fails with an explicit message when the registry is invalid", () => {
    fake.writeFile("config/projects.yaml", "projects: [ {");

    const code = run();

    expect(code).toBe(3);
    expect(stderr.join("\n")).toContain("ch ls");
  });
});
