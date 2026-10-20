import assert from "node:assert/strict";
import { test } from "node:test";
import { agentMayRead, agentRunOver } from "../src/agent-access.ts";

test("a coding agent's run always asks before a risky action", () => {
  assert.equal(agentRunOver("a page", undefined).approvals, true);
  assert.equal(agentRunOver(undefined, false).approvals, true);
  assert.deepEqual(agentRunOver("x", true), { report: { expect: "x" }, approvals: true, planning: true });
});

test("a coding agent reads only the tabs its runs opened or worked in", () => {
  const seen = new Set([7, 12]);
  assert.equal(agentMayRead(7, seen), true);
  assert.equal(agentMayRead(12, seen), true);
  assert.equal(agentMayRead(3, seen), false); // the person's own tab
  assert.equal(agentMayRead(3, new Set()), false);
});
