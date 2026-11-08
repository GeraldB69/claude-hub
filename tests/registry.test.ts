import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { loadRegistry, parseRegistry, resolveProject, type Project } from "../src/core/registry.js";

import { createFakeHome, type FakeHome } from "./helpers/fake-home.js";

const WORKSPACE = "/ws";

describe("parseRegistry", () => {
  test("returns no project for an empty document", () => {
    expect(parseRegistry("", WORKSPACE)).toEqual([]);
  });

  test("resolves relative paths against the workspace root and keeps absolute ones", () => {
    const projects = parseRegistry(
      "projects:\n  - { name: site, path: perso/site, profile: web }\n  - { name: tool, path: /opt/tool, profile: web, remote: git@example.com:o/tool.git }\n",
      WORKSPACE
    );

    expect(projects).toEqual([
      { name: "site", path: "/ws/perso/site", profile: "web" },
      { name: "tool", path: "/opt/tool", profile: "web", remote: "git@example.com:o/tool.git" },
    ]);
  });

  test("rejects a relative path that escapes the workspace root", () => {
    expect(() =>
      parseRegistry("projects:\n  - { name: x, path: ../outside, profile: web }\n", WORKSPACE)
    ).toThrow(/hors de la racine/);
  });

  test.each([".", "./", "/ws", "/ws/"])("rejects a project path that is the workspace root: %j", (path) => {
    expect(() => parseRegistry(`projects:\n  - { name: x, path: "${path}", profile: web }\n`, WORKSPACE)).toThrow(
      /racine de travail/
    );
  });

  test("accepts a sibling of the root that merely shares its name prefix, as an absolute path", () => {
    expect(parseRegistry("projects:\n  - { name: x, path: /ws-other/x, profile: web }\n", WORKSPACE)).toEqual([
      { name: "x", path: "/ws-other/x", profile: "web" },
    ]);
  });

  test("rejects a relative path that climbs into a sibling sharing the root name prefix", () => {
    expect(() =>
      parseRegistry("projects:\n  - { name: x, path: ../ws-evil/x, profile: web }\n", WORKSPACE)
    ).toThrow(/hors de la racine/);
  });

  test("accepts the tooling projects whose names start with an underscore", () => {
    const projects = parseRegistry(
      "projects:\n  - { name: _engine, path: _engine, profile: web }\n  - { name: _config, path: _config, profile: web }\n",
      WORKSPACE
    );

    expect(projects.map((project) => project.name)).toEqual(["_engine", "_config"]);
  });

  test.each(["__x", "_", "_-x"])("rejects the project name %j", (name) => {
    expect(() =>
      parseRegistry(`projects:\n  - { name: "${name}", path: a, profile: web }\n`, WORKSPACE)
    ).toThrow(/name/);
  });

  test("rejects duplicate names", () => {
    expect(() =>
      parseRegistry(
        "projects:\n  - { name: x, path: a, profile: web }\n  - { name: x, path: b, profile: web }\n",
        WORKSPACE
      )
    ).toThrow(/x/);
  });

  test("rejects duplicate paths", () => {
    expect(() =>
      parseRegistry(
        "projects:\n  - { name: x, path: a, profile: web }\n  - { name: y, path: a/, profile: web }\n",
        WORKSPACE
      )
    ).toThrow(/même chemin/);
  });

  test.each(["", "Has Space", "../x", "a/b"])("rejects the project name %j", (name) => {
    expect(() =>
      parseRegistry(`projects:\n  - { name: "${name}", path: a, profile: web }\n`, WORKSPACE)
    ).toThrow(/name/);
  });

  test("rejects an unknown key", () => {
    expect(() =>
      parseRegistry("projects:\n  - { name: x, path: a, profile: web, color: red }\n", WORKSPACE)
    ).toThrow(/color/);
  });

  test("reports a YAML syntax error without echoing content", () => {
    const attempt = () => parseRegistry("projects: [SECRET", WORKSPACE);

    expect(attempt).toThrow(/YAML invalide/);
    expect(attempt).not.toThrow(/SECRET/);
  });
});

describe("loadRegistry", () => {
  let fake: FakeHome;

  beforeEach(() => {
    fake = createFakeHome();
  });

  afterEach(() => {
    fake.cleanup();
  });

  test("returns no project when projects.yaml is absent", () => {
    expect(loadRegistry(`${fake.home}/config`, WORKSPACE)).toEqual([]);
  });

  test("reads projects.yaml and names the file on error", () => {
    fake.writeFile("config/projects.yaml", "projects:\n  - { name: x, path: a }\n");

    expect(() => loadRegistry(`${fake.home}/config`, WORKSPACE)).toThrow(/projects\.yaml/);
  });
});

describe("resolveProject", () => {
  const projects: readonly Project[] = [
    { name: "site", path: "/ws/site", profile: "web" },
    { name: "site-admin", path: "/ws/site-admin", profile: "web" },
    { name: "tool", path: "/ws/tool", profile: "web" },
  ];

  test("finds a project by exact name even when it is also a prefix of another", () => {
    expect(resolveProject(projects, "site")).toEqual({ kind: "found", project: projects[0] });
  });

  test("finds a project by unique prefix", () => {
    expect(resolveProject(projects, "to")).toEqual({ kind: "found", project: projects[2] });
  });

  test("lists the candidates when a prefix is ambiguous", () => {
    expect(resolveProject(projects, "si")).toEqual({
      kind: "ambiguous",
      candidates: ["site", "site-admin"],
    });
  });

  test("finds a project by its absolute path", () => {
    expect(resolveProject(projects, "/ws/tool")).toEqual({ kind: "found", project: projects[2] });
  });

  test("reports an unknown query", () => {
    expect(resolveProject(projects, "ghost")).toEqual({ kind: "unknown" });
  });

  test("ignores prefixes in exact-only mode, but still finds an exact name or an absolute path", () => {
    expect(resolveProject(projects, "to", { exactOnly: true })).toEqual({ kind: "unknown" });
    expect(resolveProject(projects, "tool", { exactOnly: true })).toEqual({ kind: "found", project: projects[2] });
    expect(resolveProject(projects, "/ws/tool", { exactOnly: true })).toEqual({
      kind: "found",
      project: projects[2],
    });
  });

  test("does not treat an empty query as a prefix of everything", () => {
    expect(resolveProject(projects, "")).toEqual({ kind: "unknown" });
  });
});
