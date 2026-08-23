import assert from "node:assert/strict";
import test from "node:test";
import { canonicalizeReadOnlyShellCommand, isReadOnlyShellCommand } from "./utils.ts";

test("canonicalizes quoted read-only arguments into argv", () => {
  assert.deepEqual(canonicalizeReadOnlyShellCommand("rg -n 'kipfel|theme' /tmp"), [
    { id: "rg", executable: "rg", argv: ["rg", "-n", "kipfel|theme", "/tmp"] },
  ]);
  assert.deepEqual(canonicalizeReadOnlyShellCommand("git   status --short"), [
    { id: "git:status", executable: "git", argv: ["git", "status", "--short"] },
  ]);
});

test("allows quoted arguments for read-only inspection commands", () => {
  assert.equal(isReadOnlyShellCommand("printf '%s\\n' 'Kipfel'"), true);
  assert.equal(isReadOnlyShellCommand("rg -n 'kipfel|theme' /tmp"), true);
  assert.equal(isReadOnlyShellCommand("find /tmp -maxdepth 2 -type f -name '*.json'"), true);
});

test("allows read-only pipelines and command sequences", () => {
  assert.equal(isReadOnlyShellCommand("rg -n 'theme' /tmp | head -20"), true);
  assert.equal(isReadOnlyShellCommand("echo ready; printf '%s\\n' done"), true);
  assert.equal(isReadOnlyShellCommand("echo ready || echo fallback"), true);
});

test("rejects expansion, redirection, wrappers, and destructive commands", () => {
  assert.equal(isReadOnlyShellCommand("printf '%s\\n' \"$HOME\""), false);
  assert.equal(isReadOnlyShellCommand("printf ready > /tmp/out"), false);
  assert.equal(isReadOnlyShellCommand("echo ready && cat file"), false);
  assert.equal(isReadOnlyShellCommand("bash -c 'cat file'"), false);
  assert.equal(isReadOnlyShellCommand("python3 -c 'print(1)'"), false);
  assert.equal(isReadOnlyShellCommand("find . -exec cat {} \\;"), false);
  assert.equal(isReadOnlyShellCommand("rm -rf /tmp/example"), false);
});

test("keeps restricted read-only command options blocked", () => {
  assert.equal(isReadOnlyShellCommand("rg --pre 'cat file' pattern ."), false);
  assert.equal(isReadOnlyShellCommand("git diff --output=/tmp/diff"), false);
  assert.equal(isReadOnlyShellCommand("date --set='tomorrow'"), false);
});
