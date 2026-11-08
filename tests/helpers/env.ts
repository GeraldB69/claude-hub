import type { Env } from "../../src/core/env.js";

import type { FakeHome } from "./fake-home.js";

/** Environnement de test : tout vit sous le faux home, rien ne touche au vrai poste. */
export function testEnv(fake: FakeHome, overrides: Partial<Env> = {}): Env {
  return {
    home: fake.home,
    configDir: `${fake.home}/config`,
    defaultRoots: [],
    workspaceRoot: `${fake.home}/ws`,
    examplesDir: `${fake.home}/examples`,
    cwd: fake.home,
    stateDir: `${fake.home}/state`,
    ...overrides,
  };
}
