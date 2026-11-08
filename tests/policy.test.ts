import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { DEFAULT_POLICY, loadPolicy, parsePolicy } from "../src/core/policy.js";

describe("parsePolicy", () => {
  test("returns the default policy for an empty document", () => {
    expect(parsePolicy("")).toEqual(DEFAULT_POLICY);
  });

  test("overrides only the fields present in the document", () => {
    const result = parsePolicy("userPluginAllowlist:\n  - caveman@caveman\n");

    expect(result).toEqual({ ...DEFAULT_POLICY, userPluginAllowlist: ["caveman@caveman"] });
  });

  test("lets the policy allow account synchronisation", () => {
    expect(parsePolicy("allowAccountSync: true\n")).toEqual({ ...DEFAULT_POLICY, allowAccountSync: true });
  });

  test("rejects an unknown key so that typos do not pass silently", () => {
    expect(() => parsePolicy("userPluginAllowlst: []\n")).toThrow(/userPluginAllowlst/);
  });

  test("rejects a value of the wrong type", () => {
    expect(() => parsePolicy("agentsSkillsMustBeEmpty: maybe\n")).toThrow(/agentsSkillsMustBeEmpty/);
  });

  test("rejects a document that is not a mapping", () => {
    expect(() => parsePolicy("- a\n- b\n")).toThrow();
  });

  test("reports a YAML syntax error without echoing any file content", () => {
    const attempt = () => parsePolicy("token: [SECRET");

    expect(attempt).toThrow(/YAML invalide/);
    expect(attempt).not.toThrow(/SECRET/);
  });
});

describe("loadPolicy", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "ch-policy-"));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  test("falls back to the default policy when policy.yaml is absent", () => {
    expect(loadPolicy(configDir)).toEqual(DEFAULT_POLICY);
  });

  test("reads policy.yaml from the config directory", () => {
    writeFileSync(join(configDir, "policy.yaml"), "agentsSkillsMustBeEmpty: false\n");

    expect(loadPolicy(configDir)).toEqual({ ...DEFAULT_POLICY, agentsSkillsMustBeEmpty: false });
  });

  test("names the file but never echoes content when policy.yaml has a syntax error", () => {
    writeFileSync(join(configDir, "policy.yaml"), "token: [SECRET\n");

    const attempt = () => loadPolicy(configDir);

    expect(attempt).toThrow(/policy\.yaml/);
    expect(attempt).not.toThrow(/SECRET/);
  });

  test("mentions the file path when policy.yaml is invalid", () => {
    writeFileSync(join(configDir, "policy.yaml"), "bogus: 1\n");

    expect(() => loadPolicy(configDir)).toThrow(/policy\.yaml/);
  });
});
