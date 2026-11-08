import { describe, expect, test } from "vitest";

import { MAX_KEY_LENGTH, projectKey } from "../src/core/project-key.js";

describe("projectKey", () => {
  test("replaces slashes and underscores with dashes like Claude Code does", () => {
    // Arrange
    const path = "/home/user/repositories/CLAUDE_CODE";

    // Act
    const result = projectKey(path);

    // Assert
    expect(result).toEqual({
      key: "-home-user-repositories-CLAUDE-CODE",
      reliable: true,
    });
  });

  test("replaces every non-alphanumeric character with one dash, accents included", () => {
    expect(projectKey("/tmp/x/a b.c-é_d").key).toBe("-tmp-x-a-b-c---d");
  });

  test("keeps the double dash produced by a slash followed by a dotted or dashed segment", () => {
    expect(projectKey("/tmp/claude-1000/-home-user").key).toBe(
      "-tmp-claude-1000--home-user"
    );
  });

  test("keeps digits and letters of both cases untouched", () => {
    expect(projectKey("/Ab9").key).toBe("-Ab9");
  });

  test("flags a key reaching the limit as unreliable because Claude Code truncates and hashes longer ones", () => {
    // Arrange: encoded key is exactly MAX_KEY_LENGTH characters (boundary not verified, so treated as unsafe)
    const path = `/${"x".repeat(MAX_KEY_LENGTH - 1)}`;

    // Act
    const result = projectKey(path);

    // Assert
    expect(result.key).toHaveLength(MAX_KEY_LENGTH);
    expect(result.reliable).toBe(false);
  });

  test("accepts a key shorter than the limit", () => {
    const path = `/${"x".repeat(MAX_KEY_LENGTH - 2)}`;

    expect(projectKey(path).reliable).toBe(true);
  });

  test("flags paths containing characters outside the basic multilingual plane as unreliable", () => {
    expect(projectKey("/tmp/😀").reliable).toBe(false);
  });

  test("throws on a relative path", () => {
    expect(() => projectKey("relative/path")).toThrow(/absolu/);
  });
});
