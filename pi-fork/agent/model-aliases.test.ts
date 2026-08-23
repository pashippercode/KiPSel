import assert from "node:assert/strict";
import test from "node:test";
import { modelAliasTable, resolveModelAlias } from "./model-aliases.ts";

test("resolves common Luna aliases to the registered provider/model", () => {
  for (const alias of ["luna", "gpt-5.6-luna", "111/luna", "lavenda/luna"]) {
    assert.equal(resolveModelAlias(alias), "111/gpt-5.6-luna");
  }
});

test("preserves exact provider/model ids and supports explicit additions", () => {
  assert.equal(resolveModelAlias("111/gpt-5.6-luna"), "111/gpt-5.6-luna");
  assert.equal(resolveModelAlias("other/model"), "other/model");
  assert.equal(resolveModelAlias("team-fast", { "team-fast": "111/gpt-5.6-luna" }), "111/gpt-5.6-luna");
  assert.equal(modelAliasTable().luna, "111/gpt-5.6-luna");
});
