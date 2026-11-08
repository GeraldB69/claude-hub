import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { loadProfile, parseProfileDocument } from "../src/core/profile.js";

import { createFakeHome, type FakeHome } from "./helpers/fake-home.js";

describe("parseProfileDocument", () => {
  test("applies defaults to an empty document", () => {
    expect(parseProfileDocument("")).toEqual({ plugins: [], skillsOff: [] });
  });

  test("keeps the declared fields", () => {
    const document = parseProfileDocument(
      "extends: base\nplugins:\n  - a@m\nskillsOff:\n  - noisy\nconnectors: disabled\nclaudeMd: |\n  # Title\n"
    );

    expect(document).toEqual({
      extends: "base",
      plugins: ["a@m"],
      skillsOff: ["noisy"],
      connectors: "disabled",
      claudeMd: "# Title\n",
    });
  });

  test.each([
    "nomarket",
    "a@",
    "@m",
    "a b@m",
    "a@m@n",
    "-x@m",
    "--scope@m",
    "a@-m",
    "a/b@m",
    "a@m/x",
    "../x@m",
    "a\\nb@m",
  ])("rejects the plugin id %j", (id) => {
    expect(() => parseProfileDocument(`plugins:\n  - "${id}"\n`)).toThrow(/plugins/);
  });

  test.each(["ctx@market", "a.b_c-d@claude-plugins-official", "A1@M2", "x@y.z"])("accepts the plugin id %j", (id) => {
    expect(parseProfileDocument(`plugins:\n  - "${id}"\n`).plugins).toEqual([id]);
  });

  test("rejects an unknown key so that typos do not pass silently", () => {
    expect(() => parseProfileDocument("plugin: []\n")).toThrow(/plugin/);
  });

  test("rejects an unknown connectors value", () => {
    expect(() => parseProfileDocument("connectors: maybe\n")).toThrow(/connectors/);
  });

  test("reports a YAML syntax error without echoing content", () => {
    const attempt = () => parseProfileDocument("claudeMd: [SECRET");

    expect(attempt).toThrow(/YAML invalide/);
    expect(attempt).not.toThrow(/SECRET/);
  });
});

describe("loadProfile", () => {
  let fake: FakeHome;
  let configDir: string;
  let examplesDir: string;

  const load = (name: string) => loadProfile(name, { configDir, examplesDir });

  beforeEach(() => {
    fake = createFakeHome();
    configDir = `${fake.home}/config`;
    examplesDir = `${fake.home}/examples`;
  });

  afterEach(() => {
    fake.cleanup();
  });

  test("loads a profile from the private configuration", () => {
    fake.writeFile("config/profiles/web.yaml", "plugins:\n  - a@m\n");

    expect(load("web")).toEqual({
      name: "web",
      plugins: ["a@m"],
      skillsOff: [],
      connectors: "default",
    });
  });

  test("falls back to the example profiles shipped with the engine", () => {
    fake.writeFile("examples/profiles/web.yaml", "connectors: disabled\n");

    expect(load("web").connectors).toBe("disabled");
  });

  test("prefers the private configuration over the examples", () => {
    fake.writeFile("config/profiles/web.yaml", "plugins:\n  - private@m\n");
    fake.writeFile("examples/profiles/web.yaml", "plugins:\n  - example@m\n");

    expect(load("web").plugins).toEqual(["private@m"]);
  });

  test("merges the parent profile: lists are united without duplicates, scalars are overridden", () => {
    fake.writeFile(
      "config/profiles/base.yaml",
      "plugins:\n  - a@m\n  - b@m\nskillsOff:\n  - s1\nconnectors: disabled\nclaudeMd: parent\n"
    );
    fake.writeFile(
      "config/profiles/web.yaml",
      "extends: base\nplugins:\n  - b@m\n  - c@m\nskillsOff:\n  - s2\nconnectors: default\n"
    );

    expect(load("web")).toEqual({
      name: "web",
      plugins: ["a@m", "b@m", "c@m"],
      skillsOff: ["s1", "s2"],
      connectors: "default",
      claudeMd: "parent",
    });
  });

  test("resolves a grandparent through a mix of private and example profiles", () => {
    fake.writeFile("examples/profiles/base.yaml", "plugins:\n  - a@m\n");
    fake.writeFile("config/profiles/mid.yaml", "extends: base\nplugins:\n  - b@m\n");
    fake.writeFile("config/profiles/web.yaml", "extends: mid\n");

    expect(load("web").plugins).toEqual(["a@m", "b@m"]);
  });

  test("detects an inheritance cycle", () => {
    fake.writeFile("config/profiles/a.yaml", "extends: b\n");
    fake.writeFile("config/profiles/b.yaml", "extends: a\n");

    expect(() => load("a")).toThrow(/cycle/i);
  });

  test("names the profile when it does not exist", () => {
    expect(() => load("ghost")).toThrow(/ghost/);
  });

  test.each(["../escape", "a/b", "A", "", ".hidden"])("rejects the profile name %j", (name) => {
    expect(() => load(name)).toThrow(/nom de profil/i);
  });

  test("names the file when a profile is invalid", () => {
    fake.writeFile("config/profiles/web.yaml", "bogus: 1\n");

    expect(() => load("web")).toThrow(/web\.yaml/);
  });
});
