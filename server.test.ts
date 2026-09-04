import test from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";

type Thread = ReturnType<typeof makeThreadResponse>;

const PROJECT = "proj_1";
const CONTEXT = { threadId: null, projectId: PROJECT, onNewThreadScreen: false };
const ASSISTANT = "Aide's assistant";

/**
 * The backend loaded into the SDK's fake plugin host, with just enough of
 * bb.sdk stubbed for delegation. Threads live in a map so a test can archive
 * or delete the assistant between calls and watch it get replaced.
 */
async function load() {
  const threads = new Map<string, Thread>();
  let spawned = 0;
  const host = createFakePluginHost({
    pluginId: "handsfree",
    settings: { openaiApiKey: "sk-test" },
    sdk: {
      plugins: {
        getSettings: async () => ({ values: {} }),
        list: async () => ({ plugins: [] }),
      },
      threads: {
        spawn: async (args) => {
          spawned += 1;
          const thread = makeThreadResponse({
            id: `thr_${spawned}`,
            projectId: args.projectId,
            title: typeof args.title === "string" ? args.title : null,
            status: "active",
          });
          threads.set(thread.id, thread);
          return thread;
        },
        get: async ({ threadId }) => {
          const thread = threads.get(threadId);
          if (!thread) throw new Error(`thread ${threadId} not found`);
          return thread;
        },
        send: async () => ({ ok: true }),
      },
    },
  });
  await plugin(host.bb);
  const delegate = async (args: Record<string, unknown>, context: typeof CONTEXT = CONTEXT) =>
    (await host.harness.callRpc("runTool", { name: "delegate", args, ...context })) as { output: string };
  const toolNames = async () =>
    ((await host.harness.callRpc("getTools", null)) as { tools: { name: string }[] }).tools.map((tool) => tool.name);
  return { host, threads, delegate, toolNames, spawns: () => host.harness.sdk.callsTo("threads.spawn") };
}

test("delegate is offered by default and withdrawn — and refused — when the setting is off", async () => {
  const { host, delegate, toolNames, spawns } = await load();
  assert.ok((await toolNames()).includes("delegate"));

  await host.harness.callRpc("setConfig", { delegate: false });
  assert.ok(!(await toolNames()).includes("delegate"));
  // A session started before the switch still carries the schema: the backend
  // re-checks at execution, like run_plugin_command does.
  const { output } = await delegate({ task: "clone the repo" });
  assert.match(output, /turned off/);
  assert.equal(spawns().length, 0);
});

test("the first delegation spawns Aide's assistant in the current project; the next reuses it", async () => {
  const { host, delegate, spawns } = await load();

  const first = JSON.parse((await delegate({ task: "clone the repo" })).output);
  assert.equal(first.delegated, true);
  assert.equal(first.title, ASSISTANT);
  assert.equal(spawns().length, 1);
  const args = spawns()[0][0] as { projectId: string; title: string; prompt: string; environment: unknown };
  assert.equal(args.projectId, PROJECT);
  assert.equal(args.title, ASSISTANT);
  assert.deepEqual(args.environment, { type: "project-default" });
  assert.match(args.prompt, /read aloud/);
  assert.ok(args.prompt.endsWith("\n\nTask: clone the repo"));
  assert.equal(await host.bb.storage.kv.get(`assistant.${PROJECT}`), first.threadId);

  const second = JSON.parse((await delegate({ task: "now run the tests" })).output);
  assert.equal(second.threadId, first.threadId);
  assert.equal(spawns().length, 1);
  const sends = host.harness.sdk.callsTo("threads.send");
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0][0], {
    threadId: first.threadId,
    mode: "auto",
    input: [{ type: "text", text: "now run the tests", mentions: [] }],
  });
  // Delegating never navigates: that would yank the user's screen (and end a
  // live mobile call).
  assert.equal(host.harness.sdk.callsTo("threads.open").length, 0);
});

test("an archived or deleted assistant is replaced rather than reused", async () => {
  const { host, threads, delegate, spawns } = await load();
  const first = JSON.parse((await delegate({ task: "a" })).output);

  threads.get(first.threadId)!.archivedAt = Date.now();
  const second = JSON.parse((await delegate({ task: "b" })).output);
  assert.notEqual(second.threadId, first.threadId);
  assert.equal(spawns().length, 2);
  assert.equal(await host.bb.storage.kv.get(`assistant.${PROJECT}`), second.threadId);

  threads.delete(second.threadId); // gone entirely: threads.get throws
  const third = JSON.parse((await delegate({ task: "c" })).output);
  assert.notEqual(third.threadId, second.threadId);
  assert.equal(spawns().length, 3);
  assert.equal(host.harness.sdk.callsTo("threads.send").length, 0);
});

test("delegate needs a project, and an explicit project_id wins over the current one", async () => {
  const { delegate, spawns } = await load();
  const { output } = await delegate({ task: "x" }, { ...CONTEXT, projectId: null });
  assert.match(output, /no current project/);
  assert.equal(spawns().length, 0);

  await delegate({ task: "x", project_id: "proj_2" });
  assert.equal((spawns()[0][0] as { projectId: string }).projectId, "proj_2");
});

test("the voice session is briefed on delegation, and the tool is sent, only while enabled", async () => {
  const { host } = await load();
  const sessions: { instructions: string; tools: { name: string }[] }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    sessions.push(JSON.parse(String((init?.body as FormData).get("session"))));
    return new Response("v=0 answer", { status: 200 });
  }) as typeof fetch;
  try {
    const call = { sdp: "v=0 offer", threadId: null, projectId: PROJECT };
    await host.harness.callRpc("createCall", { ...call, nonce: "n1" });
    assert.ok(sessions[0].tools.some((tool) => tool.name === "delegate"));
    assert.match(sessions[0].instructions, /delegate tool hands it a task/);
    assert.match(sessions[0].instructions, new RegExp(ASSISTANT));

    await host.harness.callRpc("setConfig", { delegate: false });
    await host.harness.callRpc("createCall", { ...call, nonce: "n2" });
    assert.ok(!sessions[1].tools.some((tool) => tool.name === "delegate"));
    assert.doesNotMatch(sessions[1].instructions, /delegate tool/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the default prompt makes Aide an orchestrator that relays in-thread speech to the thread's agent", async () => {
  const { host } = await load();
  const { defaultContent } = (await host.harness.callRpc("getPrompt", null)) as { defaultContent: string };
  assert.match(defaultContent, /orchestrator, not a worker/);
  assert.match(defaultContent, /Default to relaying[\s\S]*send_to_thread/);
  assert.match(defaultContent, /do not ask clarifying questions/);
  assert.match(defaultContent, /With no thread in view, route work to your own agent/);
});

test("the assistant finishing is announced like any other thread, by its title", async () => {
  const { host } = await load();
  await host.harness.emitThreadEvent("thread.idle", {
    thread: makeThreadResponse({ id: "thr_1", title: ASSISTANT, visibility: "visible" }),
    lastAssistantText: "Cloned the repository and created the project.",
  });
  // publishThreadEvent reads config first; let that settle.
  await new Promise((resolve) => setImmediate(resolve));
  const signal = host.harness.realtimeSignals.find((entry) => entry.channel === "aide-thread-event");
  assert.ok(signal, "no aide-thread-event published");
  const payload = signal.payload as { kind: string; threadId: string; title: string; detail: string | null };
  assert.equal(payload.kind, "idle");
  assert.equal(payload.threadId, "thr_1");
  assert.equal(payload.title, ASSISTANT);
  assert.match(String(payload.detail), /Cloned the repository/);
});
