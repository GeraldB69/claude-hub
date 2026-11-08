import { describe, expect, test } from "vitest";

import { renameProjectKey } from "../src/core/claude-json.js";

const serialize = (value: unknown): string => JSON.stringify(value, null, 2);

describe("renameProjectKey", () => {
  const state = {
    userID: "abc",
    projects: { "/a/old": { allowedTools: [], n: 1 }, "/a/other": { hasTrustDialogAccepted: true } },
    lastRepo: "/a/old",
  };

  test("renames the key in projects, keeps its value and its position, and touches nothing else", () => {
    const result = renameProjectKey(serialize(state), "/a/old", "/b/new");

    expect(result.kind).toBe("renamed");
    const text = result.kind === "renamed" ? result.text : "";
    expect(JSON.parse(text)).toEqual({
      userID: "abc",
      projects: { "/b/new": { allowedTools: [], n: 1 }, "/a/other": { hasTrustDialogAccepted: true } },
      lastRepo: "/a/old",
    });
    expect(Object.keys((JSON.parse(text) as { projects: object }).projects)).toEqual(["/b/new", "/a/other"]);
  });

  test("changes only the renamed key in the text: a diff of one line", () => {
    const before = serialize(state);

    const result = renameProjectKey(before, "/a/old", "/b/new");

    const after = result.kind === "renamed" ? result.text : "";
    const changed = before.split("\n").filter((line, index) => line !== after.split("\n")[index]);
    expect(changed).toEqual(['    "/a/old": {']);
  });

  test("also renames the entries of sub-folders of the project, keeping their suffix", () => {
    const withSub = { projects: { "/a/old": {}, "/a/old/pkg/web": { n: 1 }, "/a/old-admin": {}, "/a/older": {} } };

    const result = renameProjectKey(serialize(withSub), "/a/old", "/b/new");

    const keys = Object.keys((JSON.parse(result.kind === "renamed" ? result.text : "{}") as { projects: object }).projects);
    expect(keys).toEqual(["/b/new", "/b/new/pkg/web", "/a/old-admin", "/a/older"]);
  });

  test("renames a sub-folder entry even when the project itself has none", () => {
    const result = renameProjectKey(serialize({ projects: { "/a/old/pkg": {} } }), "/a/old", "/b/new");

    expect(result.kind === "renamed" && Object.keys((JSON.parse(result.text) as { projects: object }).projects)).toEqual([
      "/b/new/pkg",
    ]);
  });

  test("refuses when a renamed sub-folder entry would land on an existing one", () => {
    const clash = { projects: { "/a/old/pkg": {}, "/b/new/pkg": {} } };

    expect(renameProjectKey(serialize(clash), "/a/old", "/b/new")).toMatchObject({ kind: "unsafe" });
  });

  test("accepts a file that ends with a newline and keeps it", () => {
    const result = renameProjectKey(`${serialize(state)}\n`, "/a/old", "/b/new");

    expect(result.kind === "renamed" && result.text.endsWith("}\n")).toBe(true);
  });

  test("reports an absent entry, or a file without projects", () => {
    expect(renameProjectKey(serialize(state), "/nope", "/b/new")).toEqual({ kind: "absent" });
    expect(renameProjectKey(serialize({ userID: "x" }), "/a/old", "/b/new")).toEqual({ kind: "absent" });
  });

  test("refuses to overwrite an entry that already exists at the destination", () => {
    const result = renameProjectKey(serialize(state), "/a/old", "/a/other");

    expect(result).toMatchObject({ kind: "unsafe", reason: expect.stringContaining("existe déjà") });
  });

  test("refuses to rewrite a file whose formatting would change, rather than reformat it", () => {
    const result = renameProjectKey(JSON.stringify(state), "/a/old", "/b/new");

    expect(result).toMatchObject({ kind: "unsafe", reason: expect.stringContaining("formatage") });
  });

  test("refuses a file that is not valid JSON, without echoing its content", () => {
    const result = renameProjectKey('{"token":"SECRET-1', "/a/old", "/b/new");

    expect(result.kind).toBe("unsafe");
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  test.each([{ root: [] }, { root: "x" }])("refuses a root that is %j", ({ root }) => {
    expect(renameProjectKey(serialize(root), "/a/old", "/b/new").kind).toBe("unsafe");
  });

  test("refuses relative paths", () => {
    expect(renameProjectKey(serialize(state), "old", "/b/new").kind).toBe("unsafe");
    expect(renameProjectKey(serialize(state), "/a/old", "new").kind).toBe("unsafe");
  });

  test("keeps a __proto__ entry as plain data", () => {
    const text = serialize(JSON.parse('{"projects":{"/a/old":{},"__proto__":{"x":1}}}'));

    const result = renameProjectKey(text, "/a/old", "/b/new");

    expect(result.kind).toBe("renamed");
    expect(({} as Record<string, unknown>)["x"]).toBeUndefined();
  });
});
