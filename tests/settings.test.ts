import { describe, expect, test } from "vitest";

import type { Profile } from "../src/core/profile.js";
import { mergeSettings, serializeSettings, settingsPatchOf, summarizeMerge } from "../src/core/settings.js";

const profile = (overrides: Partial<Profile> = {}): Profile => ({
  name: "web",
  plugins: [],
  skillsOff: [],
  connectors: "default",
  ...overrides,
});

describe("settingsPatchOf", () => {
  test("returns an empty patch for a profile that configures nothing", () => {
    expect(settingsPatchOf(profile())).toEqual({});
  });

  test("turns plugins, skills and connectors into the keys they drive", () => {
    expect(
      settingsPatchOf(profile({ plugins: ["a@m", "b@m"], skillsOff: ["noisy"], connectors: "disabled" }))
    ).toEqual({
      enabledPlugins: { "a@m": true, "b@m": true },
      skillOverrides: { noisy: "off" },
      disableClaudeAiConnectors: true,
    });
  });
});

describe("mergeSettings", () => {
  test("adds the managed keys and keeps every other key, in its original order", () => {
    const existing = { permissions: { deny: ["Read(./.env*)"] }, model: "sonnet", env: { A: "1" } };

    const result = mergeSettings(existing, { enabledPlugins: { "a@m": true }, disableClaudeAiConnectors: true });

    expect(result?.changed).toBe(true);
    expect(Object.keys(result?.merged ?? {})).toEqual([
      "permissions",
      "model",
      "env",
      "enabledPlugins",
      "disableClaudeAiConnectors",
    ]);
    expect(result?.merged["permissions"]).toEqual({ deny: ["Read(./.env*)"] });
  });

  test("unites the plugin maps instead of replacing them", () => {
    const result = mergeSettings({ enabledPlugins: { "keep@m": true, "off@m": false } }, { enabledPlugins: { "a@m": true } });

    expect(result?.merged["enabledPlugins"]).toEqual({ "keep@m": true, "off@m": false, "a@m": true });
  });

  test("turns on a plugin the profile wants, even when the file had it disabled", () => {
    const result = mergeSettings({ enabledPlugins: { "a@m": false } }, { enabledPlugins: { "a@m": true } });

    expect(result?.merged["enabledPlugins"]).toEqual({ "a@m": true });
    expect(result?.changed).toBe(true);
  });

  test("forces a skill to off when the file gave it another override", () => {
    const result = mergeSettings({ skillOverrides: { noisy: "name-only", other: "off" } }, { skillOverrides: { noisy: "off" } });

    expect(result?.merged["skillOverrides"]).toEqual({ noisy: "off", other: "off" });
  });

  test("reports no change when the file is already aligned", () => {
    const existing = { enabledPlugins: { "a@m": true }, disableClaudeAiConnectors: true, extra: 1 };

    const result = mergeSettings(existing, { enabledPlugins: { "a@m": true }, disableClaudeAiConnectors: true });

    expect(result?.changed).toBe(false);
    expect(result?.merged).toEqual(existing);
  });

  test("does not change anything for an empty patch", () => {
    expect(mergeSettings({ a: 1 }, {})).toEqual({ merged: { a: 1 }, changed: false });
  });

  test("never mutates its input", () => {
    const existing = { enabledPlugins: { "keep@m": true } };
    const snapshot = JSON.stringify(existing);

    mergeSettings(existing, { enabledPlugins: { "a@m": true } });

    expect(JSON.stringify(existing)).toBe(snapshot);
  });

  test.each([
    [{ enabledPlugins: "oops" }],
    [{ enabledPlugins: [] }],
    [{ skillOverrides: 3 }],
  ])("returns undefined when a managed key has an unusable shape: %j", (existing) => {
    expect(mergeSettings(existing, { enabledPlugins: { "a@m": true }, skillOverrides: { x: "off" } })).toBeUndefined();
  });

  test("stores a hostile skill name as plain data without touching prototypes", () => {
    const result = mergeSettings({}, { skillOverrides: { ["__proto__"]: "off" } });

    const overrides = result?.merged["skillOverrides"] as Record<string, unknown>;
    expect(Object.keys(overrides)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(overrides)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)["off"]).toBeUndefined();
  });
});

describe("summarizeMerge", () => {
  test("lists only what would change", () => {
    const summary = summarizeMerge(
      { enabledPlugins: { "a@m": true }, skillOverrides: { done: "off" } },
      {
        enabledPlugins: { "a@m": true, "b@m": true },
        skillOverrides: { done: "off", todo: "off" },
        disableClaudeAiConnectors: true,
      }
    );

    expect(summary).toEqual(["enabledPlugins +b@m", "skillOverrides +todo", "disableClaudeAiConnectors"]);
  });

  test("is empty when nothing changes", () => {
    expect(summarizeMerge({ disableClaudeAiConnectors: true }, { disableClaudeAiConnectors: true })).toEqual([]);
  });
});

describe("summarizeMerge with contrary values", () => {
  test("marks an override of an explicit value with its previous value", () => {
    expect(
      summarizeMerge(
        { enabledPlugins: { "a@m": false }, skillOverrides: { s: "name-only" }, disableClaudeAiConnectors: false },
        { enabledPlugins: { "a@m": true }, skillOverrides: { s: "off" }, disableClaudeAiConnectors: true }
      )
    ).toEqual(['enabledPlugins ~a@m (était false)', 'skillOverrides ~s (était "name-only")', "disableClaudeAiConnectors (était false)"]);
  });
});

describe("serializeSettings", () => {
  test("uses two-space indentation and ends with a newline", () => {
    expect(serializeSettings({ a: { b: 1 } })).toBe('{\n  "a": {\n    "b": 1\n  }\n}\n');
  });
});
