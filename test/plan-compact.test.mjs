import assert from "node:assert/strict";
import { test } from "node:test";
import { fillStep } from "../src/llm.ts";

test("fillStep: a compact step gets the fields the code reads, and keeps what it set", () => {
  const s = fillStep({ kind: "browse", goal: "Open the orders grid", open_url: "http://x/orders", save_as: "orders" });
  assert.deepEqual(s, {
    open_url: "http://x/orders",
    use_tab: -1,
    done_when: "",
    rules: "",
    max_moves: 0,
    question: "",
    choices: [],
    texts: [],
    save_as: "orders",
    kind: "browse",
    goal: "Open the orders grid",
  });
  // a step the model wrote in full is unchanged
  const full = {
    kind: "read",
    goal: "g",
    open_url: "",
    use_tab: 0,
    done_when: "d",
    rules: "r",
    max_moves: 3,
    question: "q",
    choices: [],
    texts: [{ name: "n", text: "t" }],
    save_as: "a",
  };
  assert.deepEqual(fillStep(full), full);
});
