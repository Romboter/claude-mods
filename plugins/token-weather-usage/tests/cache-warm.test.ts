import { expect, test } from "claude-code/testing";

import { defaultEvery, overLine, parseDuration, TTL_1H, TTL_5M } from "../hooks/brew";
import { parseWake } from "../hooks/wake";

test("cache warming: poke at 80% of the TTL", () => {
  expect(defaultEvery(TTL_1H)).toBe(48 * 60_000);
  expect(defaultEvery(TTL_5M)).toBe(4 * 60_000);
});

test("cache warming: durations, wakes and the usage lines it will not cross", () => {
  expect(parseDuration("1h30m")).toBe(90 * 60_000);
  expect(parseDuration("soon")).toBeNull();
  expect(parseWake("20 min check the build", 0)).toEqual({ at: 20 * 60_000, text: "check the build" });
  expect(overLine([{ kind: "five_hour", percentUsed: 91 }])?.label).toBe("5h");
  expect(overLine([{ kind: "five_hour", percentUsed: 50 }])).toBeNull();
});
