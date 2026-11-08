import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { findReferences } from "../src/core/references.js";

import { createFakeHome, type FakeHome } from "./helpers/fake-home.js";

describe("findReferences", () => {
  let fake: FakeHome;
  let root: string;

  beforeEach(() => {
    fake = createFakeHome();
    root = fake.makeDir("project");
  });

  afterEach(() => {
    fake.cleanup();
  });

  test("lists the files and lines that mention the old path", () => {
    fake.writeFile("project/run.sh", "echo hi\ncd /old/site && go\n");
    fake.writeFile("project/docs/a.md", "see /old/site/docs\n");

    expect(findReferences(root, "/old/site").hits).toEqual([
      { file: "docs/a.md", line: 1 },
      { file: "run.sh", line: 2 },
    ]);
  });

  test("does not match a longer path that merely starts with the old one", () => {
    fake.writeFile("project/a.txt", "/old/site-admin and /old/sitex and /old/site.bak\n");

    expect(findReferences(root, "/old/site").hits).toEqual([]);
  });

  test("matches the path at the end of a line, in quotes and followed by a slash", () => {
    fake.writeFile("project/a.txt", '"/old/site"\n/old/site\n/old/site/x\n');

    expect(findReferences(root, "/old/site").hits.map((hit) => hit.line)).toEqual([1, 2, 3]);
  });

  test("skips dependencies, build output, git data and binary files", () => {
    fake.writeFile("project/node_modules/p/x.js", "/old/site\n");
    fake.writeFile("project/.git/config", "/old/site\n");
    fake.writeFile("project/.next/cache.txt", "/old/site\n");
    fake.writeFile("project/bin.dat", "\0/old/site\n");

    expect(findReferences(root, "/old/site").hits).toEqual([]);
  });

  test("skips files above the size limit and stops at the hit limit", () => {
    fake.writeFile("project/big.txt", `${"x".repeat(2000)}/old/site\n`);
    fake.writeFile("project/a.txt", "/old/site\n".repeat(5));

    const { hits, truncated } = findReferences(root, "/old/site", { maxFiles: 100, maxFileBytes: 1000, maxHits: 3 });

    expect(hits).toHaveLength(3);
    expect(hits.every((hit) => hit.file === "a.txt")).toBe(true);
    expect(truncated).toBe(true);
  });

  test("reports that the search was cut short when the file budget runs out before the end", () => {
    fake.writeFile("project/a/1.txt", "x\n");
    fake.writeFile("project/a/2.txt", "x\n");
    fake.writeFile("project/z.sh", "cd /old/site\n");

    const result = findReferences(root, "/old/site", { maxFiles: 2, maxFileBytes: 1000, maxHits: 20 });

    expect(result.truncated).toBe(true);
    expect(result.hits).toEqual([]);
  });

  test("does not count unreadable or oversized files against the file budget", () => {
    fake.writeFile("project/a-big.txt", "x".repeat(5000));
    fake.writeFile("project/b-bin.dat", "\0x");
    fake.writeFile("project/c.sh", "cd /old/site\n");

    const result = findReferences(root, "/old/site", { maxFiles: 1, maxFileBytes: 1000, maxHits: 20 });

    expect(result.hits).toEqual([{ file: "c.sh", line: 1 }]);
    expect(result.truncated).toBe(false);
  });

  test("is not truncated when everything was read and the hits fit", () => {
    fake.writeFile("project/a.sh", "cd /old/site\n");

    expect(findReferences(root, "/old/site").truncated).toBe(false);
  });

  test("does not follow symbolic links", () => {
    fake.writeFile("outside/secret.txt", "/old/site\n");
    fake.symlink("project/link", "../outside");

    expect(findReferences(root, "/old/site").hits).toEqual([]);
  });

  test("returns nothing for a folder that does not exist", () => {
    expect(findReferences(`${fake.home}/missing`, "/old/site")).toEqual({ hits: [], truncated: false });
  });
});
