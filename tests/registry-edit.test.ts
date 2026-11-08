import { describe, expect, test } from "vitest";

import { parseRegistry } from "../src/core/registry.js";
import { setProjectPath } from "../src/core/registry-edit.js";

const SAMPLE = [
  "# Registre des projets",
  "projects:",
  "  # le portfolio",
  "  - { name: site, path: /old/site, profile: web, remote: git@example.com:o/site.git }",
  "  - { name: tool, path: tool, profile: web } # un outil",
  "",
].join("\n");

describe("setProjectPath", () => {
  test("changes only the path of the named project and keeps comments and style", () => {
    const result = setProjectPath(SAMPLE, "site", "perso/site");

    expect(result).toBe(SAMPLE.replace("/old/site", "perso/site"));
  });

  test("leaves every other project untouched", () => {
    const projects = parseRegistry(setProjectPath(SAMPLE, "tool", "labs/tool"), "/ws");

    expect(projects.map((project) => [project.name, project.path])).toEqual([
      ["site", "/old/site"],
      ["tool", "/ws/labs/tool"],
    ]);
  });

  test("quotes a path that needs it, so the file stays valid YAML", () => {
    const result = setProjectPath(SAMPLE, "site", "/odd: path #1");

    expect(parseRegistry(result, "/ws").find((project) => project.name === "site")?.path).toBe("/odd: path #1");
  });

  test("reports an unknown project", () => {
    expect(() => setProjectPath(SAMPLE, "ghost", "x")).toThrow(/ghost/);
  });

  test("refuses a document that is not a registry, without echoing content", () => {
    expect(() => setProjectPath("projects: [SECRET", "site", "x")).toThrow(/YAML invalide/);
    expect(() => setProjectPath("a: 1\n", "site", "x")).toThrow(/site/);
  });
});
