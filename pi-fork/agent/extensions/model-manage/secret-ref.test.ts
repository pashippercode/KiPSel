import assert from "node:assert/strict";
import test from "node:test";
import { isSecretReference, resolveSecretReference, secretEnvName } from "./secret-ref.ts";

test("accepts only simple and braced environment references", () => {
  assert.equal(secretEnvName("$TAVILY_API_KEY"), "TAVILY_API_KEY");
  assert.equal(secretEnvName("${TAVILY_API_KEY}"), "TAVILY_API_KEY");
  assert.equal(isSecretReference("literal-secret"), false);
  assert.equal(isSecretReference("!cat /tmp/key"), false);
  assert.equal(isSecretReference("$bad-name"), false);
});

test("resolves references from the supplied environment without exposing values", () => {
  const env = { TEST_SECRET: "value-not-logged" };
  assert.equal(resolveSecretReference("$TEST_SECRET", env), "value-not-logged");
  assert.equal(resolveSecretReference("${TEST_SECRET}", env), "value-not-logged");
  assert.equal(resolveSecretReference("$MISSING_SECRET", env), undefined);
  assert.throws(() => resolveSecretReference("literal-secret", env), /external environment reference/);
});
