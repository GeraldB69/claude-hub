import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { discoverRepos } from "../src/core/discover.js";

import { createFakeHome, type FakeHome } from "./helpers/fake-home.js";

describe("discoverRepos", () => {
  let fake: FakeHome;

  beforeEach(() => {
    fake = createFakeHome();
  });

  afterEach(() => {
    fake.cleanup();
  });

  test("finds git repositories two levels deep", () => {
    fake.makeDir("ws/perso/site/.git");
    fake.makeDir("ws/labs/tool/.git");

    expect(discoverRepos(`${fake.home}/ws`)).toEqual([
      `${fake.home}/ws/labs/tool`,
      `${fake.home}/ws/perso/site`,
    ]);
  });

  test("accepts a .git file, as in a worktree", () => {
    fake.writeFile("ws/labs/wt/.git", "gitdir: elsewhere");

    expect(discoverRepos(`${fake.home}/ws`)).toEqual([`${fake.home}/ws/labs/wt`]);
  });

  test("does not descend into a repository", () => {
    fake.makeDir("ws/labs/factory/.git");
    fake.makeDir("ws/labs/factory/apps/todo/.git");

    expect(discoverRepos(`${fake.home}/ws`)).toEqual([`${fake.home}/ws/labs/factory`]);
  });

  test("skips hidden folders and node_modules", () => {
    fake.makeDir("ws/.cache/x/.git");
    fake.makeDir("ws/labs/node_modules/pkg/.git");

    expect(discoverRepos(`${fake.home}/ws`)).toEqual([]);
  });

  test("does not look deeper than the depth limit", () => {
    fake.makeDir("ws/a/b/c/d/.git");

    expect(discoverRepos(`${fake.home}/ws`)).toEqual([]);
    expect(discoverRepos(`${fake.home}/ws`, 4)).toEqual([`${fake.home}/ws/a/b/c/d`]);
  });

  test("does not follow symbolic links", () => {
    fake.makeDir("elsewhere/real/.git");
    fake.symlink("ws/labs/link", `${fake.home}/elsewhere/real`);

    expect(discoverRepos(`${fake.home}/ws`)).toEqual([]);
  });

  test("returns an empty list when the root does not exist", () => {
    expect(discoverRepos(`${fake.home}/missing`)).toEqual([]);
  });
});
