import test from "node:test";
import assert from "node:assert/strict";
import { CONFIRMED_TOOLS, ConfirmationGate } from "./confirm-gate.ts";

test("only relay tools require confirmation", () => {
  assert.deepEqual([...CONFIRMED_TOOLS], ["send_to_thread", "start_thread", "delegate"]);
});

test("take refuses when nothing is staged", () => {
  const gate = new ConfirmationGate();

  const result = gate.take();

  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.output, /no request is staged/i);
});

test("a staged call cannot be taken before the user answers", () => {
  const gate = new ConfirmationGate();
  const output = gate.propose("send_to_thread", { thread_id: "thr_work", message: "Run tests" });

  assert.match(output, /nothing was sent/i);
  assert.match(output, /read it back/i);
  assert.equal(gate.hasPending(), true);
  const result = gate.take();
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.output, /has not answered/i);
  assert.equal(gate.hasPending(), true);
});

test("exactly one user turn releases the staged call once", () => {
  const gate = new ConfirmationGate();
  const args = { project_id: "proj_work", prompt: "Fix CI" };
  gate.propose("start_thread", args);
  gate.noteUserTurn();

  assert.deepEqual(gate.take(), { ok: true, name: "start_thread", args });
  assert.equal(gate.hasPending(), false);
  assert.equal(gate.take().ok, false);
});

test("two user turns expire and clear the staged call", () => {
  const gate = new ConfirmationGate();
  gate.propose("delegate", { task: "Clone the repository" });
  gate.noteUserTurn();
  gate.noteUserTurn();

  const result = gate.take();
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.output, /expired/i);
  assert.equal(gate.hasPending(), false);
});

test("a new proposal replaces the old staged call", () => {
  const gate = new ConfirmationGate();
  gate.propose("send_to_thread", { thread_id: "thr_old", message: "Old request" });
  gate.noteUserTurn();
  const replacementArgs = { task: "Corrected request" };
  gate.propose("delegate", replacementArgs);
  gate.noteUserTurn();

  assert.deepEqual(gate.take(), { ok: true, name: "delegate", args: replacementArgs });
});

test("reset clears a staged call", () => {
  const gate = new ConfirmationGate();
  gate.propose("send_to_thread", { thread_id: "thr_work", message: "Run tests" });

  gate.reset();

  assert.equal(gate.hasPending(), false);
  const result = gate.take();
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.output, /no request is staged/i);
});
