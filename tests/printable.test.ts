import { describe, expect, test } from "vitest";

import { printable, singleLine } from "../src/core/printable.js";

describe("printable", () => {
  test("keeps ordinary text, accents, newlines and tabs", () => {
    expect(printable("héllo\nworld\tok")).toBe("héllo\nworld\tok");
  });

  test("neutralises terminal escape sequences and other control characters", () => {
    expect(printable("a\u001b[31mred\u001b[0m\u0007b")).toBe("a?[31mred?[0m?b");
    expect(printable("x\u0085y\u009bz\u007f")).toBe("x?y?z?");
  });
});

describe("singleLine", () => {
  test("also neutralises newlines and tabs, so a file name cannot forge a line", () => {
    expect(singleLine("evil\nAVERTISSEMENT : ok\tx")).toBe("evil?AVERTISSEMENT : ok?x");
  });
});
