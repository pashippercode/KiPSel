import assert from "node:assert/strict";
import test from "node:test";
import { mapWithScopedConcurrency, normalizeScopes, scopesOverlap } from "./scheduler.ts";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("normalizes nested paths and detects overlapping scopes", () => {
  assert.deepEqual(normalizeScopes(["/repo/", "/repo/src"]), ["/repo", "/repo/src"]);
  assert.equal(scopesOverlap(["/repo"], ["/repo/src/file.ts"]), true);
  assert.equal(scopesOverlap(["/repo/a"], ["/repo/b"]), false);
});

test("serializes overlapping mutation scopes while preserving result order", async () => {
  let active = 0;
  let maximum = 0;
  const results = await mapWithScopedConcurrency(
    ["first", "second", "third"],
    3,
    () => ["/repo/shared"],
    async (item) => {
      active++;
      maximum = Math.max(maximum, active);
      await delay(5);
      active--;
      return item;
    },
  );

  assert.deepEqual(results, ["first", "second", "third"]);
  assert.equal(maximum, 1);
});

test("runs disjoint and explicitly read-only scopes concurrently", async () => {
  let active = 0;
  let maximum = 0;
  const results = await mapWithScopedConcurrency(
    ["a", "b", "read-1", "read-2"],
    4,
    (item) => (item.startsWith("read") ? [] : [`/repo/${item}`]),
    async (item) => {
      active++;
      maximum = Math.max(maximum, active);
      await delay(5);
      active--;
      return item;
    },
  );

  assert.deepEqual(results, ["a", "b", "read-1", "read-2"]);
  assert.equal(maximum, 4);
});

test("drains active tasks before propagating a task failure", async () => {
  let siblingFinished = false;
  await assert.rejects(
    mapWithScopedConcurrency(
      ["fail", "sibling"],
      2,
      (item) => [`/repo/${item}`],
      async (item) => {
        if (item === "fail") {
          await delay(2);
          throw new Error("expected failure");
        }
        await delay(8);
        siblingFinished = true;
        return item;
      },
    ),
    /expected failure/,
  );
  assert.equal(siblingFinished, true);
});
