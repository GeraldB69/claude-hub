import { describe, expect, test } from "vitest";

import { describeDetail } from "../src/core/operations.js";

describe("describeDetail", () => {
  test.each([
    ["SYMLINK", "lien symbolique"],
    ["OUTSIDE_ROOT", "hors du projet"],
    ["NOT_A_FILE", "fichier ordinaire"],
    ["READ_ONLY", "protégé en écriture"],
    ["EXISTS", "existe déjà"],
    ["INVALID_JSON", "JSON invalide"],
    ["INVALID_STRUCTURE", "structure inattendue"],
    ["BOM", "BOM"],
    ["REGISTRY_UNUSABLE", "registre"],
    ["CLAUDE_JSON_BUSY", "en continu"],
  ])("explains %s in French", (code, fragment) => {
    expect(describeDetail(code)).toContain(fragment);
  });

  test("falls back to the raw system code, or to a neutral text when there is none", () => {
    expect(describeDetail("EACCES")).toBe("EACCES");
    expect(describeDetail(undefined)).toBe("raison inconnue");
  });
});
