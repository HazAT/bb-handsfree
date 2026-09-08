import test, { mock } from "node:test";
import assert from "node:assert/strict";
import {
  UpdateSchedule,
  formatProgressUpdate,
  type ActivityResult,
  type UpdateScheduleDeps,
} from "./progress-updates.ts";

const liveResult = (overrides: Partial<ActivityResult> = {}): ActivityResult => ({
  threadId: "thr_work",
  title: "Fix the build",
  status: "active",
  live: true,
  cursor: "10",
  activity: true,
  summary: "The agent updated the tests.",
  raw: null,
  ...overrides,
});

async function settleTick() {
  await Promise.resolve();
  await Promise.resolve();
}

function scheduleHarness(fetchActivity: UpdateScheduleDeps["fetchActivity"]) {
  const delivered: { instruction: string; logText: string }[] = [];
  const logs: { kind: string; payload?: Record<string, unknown> }[] = [];
  let deliverable = true;
  let now = 100_000;
  const schedule = new UpdateSchedule({
    fetchActivity,
    deliver: (instruction, logText) => delivered.push({ instruction, logText }),
    canDeliver: () => deliverable,
    log: (kind, payload) => logs.push({ kind, payload }),
    now: () => now,
  });
  return {
    schedule,
    delivered,
    logs,
    setDeliverable(value: boolean) {
      deliverable = value;
    },
    setNow(value: number) {
      now = value;
    },
  };
}

test("formatProgressUpdate grounds the spoken instruction and maps terminal status", () => {
  const update = formatProgressUpdate(
    liveResult({ live: false, status: "error", summary: null, raw: "test command failed" }),
    "whether CI passes",
  );

  assert.match(update.instruction, /title: "Fix the build"/);
  assert.match(update.instruction, /status: failed/);
  assert.match(update.instruction, /focus: "whether CI passes"/);
  assert.match(update.instruction, /summary: "test command failed"/);
  assert.match(update.logText, /Progress update — Fix the build: test command failed/);
});

test("first tick uses sinceMs and later ticks continue from the cursor", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const calls: Parameters<UpdateScheduleDeps["fetchActivity"]>[0][] = [];
    const harness = scheduleHarness(async (args) => {
      calls.push(args);
      return liveResult({ cursor: String(calls.length * 10) });
    });
    harness.schedule.start({ threadId: "thr_work", intervalMs: 5_000, focus: "CI" });

    mock.timers.tick(5_000);
    await settleTick();
    assert.deepEqual(calls[0], {
      threadId: "thr_work",
      afterSeq: null,
      sinceMs: 95_000,
      focus: "CI",
    });

    harness.setNow(110_000);
    mock.timers.tick(5_000);
    await settleTick();
    assert.deepEqual(calls[1], {
      threadId: "thr_work",
      afterSeq: "10",
      sinceMs: null,
      focus: "CI",
    });
  } finally {
    mock.timers.reset();
  }
});

test("delivery waits while busy, skips ticks while pending, and flushes when quiet", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let fetches = 0;
    const harness = scheduleHarness(async () => {
      fetches += 1;
      return liveResult();
    });
    harness.setDeliverable(false);
    harness.schedule.start({ threadId: "thr_work", intervalMs: 1_000, focus: null });

    mock.timers.tick(1_000);
    await settleTick();
    assert.equal(fetches, 1);
    assert.equal(harness.delivered.length, 0);

    mock.timers.tick(1_000);
    await settleTick();
    assert.equal(fetches, 1);

    harness.setDeliverable(true);
    harness.schedule.flush();
    assert.equal(harness.delivered.length, 1);
    assert.match(harness.delivered[0].instruction, /The agent updated the tests/);
  } finally {
    mock.timers.reset();
  }
});

test("a non-live result delivers the final update and stops", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = scheduleHarness(async () => liveResult({ live: false, status: "idle" }));
    harness.schedule.start({ threadId: "thr_work", intervalMs: 1_000, focus: null });

    mock.timers.tick(1_000);
    await settleTick();

    assert.equal(harness.delivered.length, 1);
    assert.match(harness.delivered[0].instruction, /status: finished/);
    assert.equal(harness.schedule.isActive(), false);
    assert.deepEqual(harness.logs.at(-1), {
      kind: "updates.stopped",
      payload: { reason: "thread-finished" },
    });
  } finally {
    mock.timers.reset();
  }
});

test("handleThreadFinished stops only the matching schedule", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = scheduleHarness(async () => liveResult());
    harness.schedule.start({ threadId: "thr_work", intervalMs: 1_000, focus: null });

    harness.schedule.handleThreadFinished("thr_other");
    assert.equal(harness.schedule.isActive(), true);
    harness.schedule.handleThreadFinished("thr_work");
    assert.equal(harness.schedule.isActive(), false);
    assert.deepEqual(harness.logs.at(-1)?.payload, { reason: "thread-finished" });
  } finally {
    mock.timers.reset();
  }
});

test("three consecutive failures speak an explanation and stop", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = scheduleHarness(async () => {
      throw new Error("backend unavailable");
    });
    harness.schedule.start({ threadId: "thr_work", intervalMs: 1_000, focus: null });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      mock.timers.tick(1_000);
      await settleTick();
    }

    assert.equal(harness.logs.filter((entry) => entry.kind === "updates.tick.failed").length, 3);
    assert.equal(harness.delivered.length, 1);
    assert.match(harness.delivered[0].instruction, /could not fetch thread activity after three attempts/);
    assert.equal(harness.schedule.isActive(), false);
    assert.deepEqual(harness.logs.at(-1)?.payload, { reason: "failed" });
  } finally {
    mock.timers.reset();
  }
});

test("stop clears the timer", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let fetches = 0;
    const harness = scheduleHarness(async () => {
      fetches += 1;
      return liveResult();
    });
    harness.schedule.start({ threadId: "thr_work", intervalMs: 1_000, focus: null });

    assert.equal(harness.schedule.stop("call-ended"), true);
    mock.timers.tick(5_000);
    await settleTick();

    assert.equal(fetches, 0);
    assert.equal(harness.schedule.isActive(), false);
    assert.deepEqual(harness.logs.at(-1)?.payload, { reason: "call-ended" });
  } finally {
    mock.timers.reset();
  }
});
