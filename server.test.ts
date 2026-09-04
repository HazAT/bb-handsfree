import test from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";

type Thread = ReturnType<typeof makeThreadResponse>;

const PROJECT = "proj_1";
const PERSONAL = "proj_personal";
const CONTEXT = { threadId: null, projectId: PROJECT, onNewThreadScreen: false };
const ASSISTANT = "Aide's assistant";
const ASSISTANT_KEY = "assistant.global";

/**
 * The backend loaded into the SDK's fake plugin host, with just enough of
 * bb.sdk stubbed for delegation. Threads live in a map so a test can archive
 * or delete the assistant between calls and watch it get replaced. `seedKv`
 * runs before the plugin factory, to stage pre-upgrade state for migrations.
 */
async function load(options: { seedKv?: Record<string, unknown> } = {}) {
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
      projects: {
        list: async () => [
          { id: PROJECT, name: "Widgets" },
          { id: PERSONAL, name: "Personal" },
        ],
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
  for (const [key, value] of Object.entries(options.seedKv ?? {})) await host.bb.storage.kv.set(key, value);
  await plugin(host.bb);
  const delegate = async (args: Record<string, unknown>, context: typeof CONTEXT = CONTEXT) =>
    (await host.harness.callRpc("runTool", { name: "delegate", args, ...context })) as { output: string };
  const toolNames = async () =>
    ((await host.harness.callRpc("getTools", null)) as { tools: { name: string }[] }).tools.map((tool) => tool.name);
  const spawns = () => host.harness.sdk.callsTo("threads.spawn") as [{ projectId: string; title: string; prompt: string; environment: unknown }][];
  const sends = () => host.harness.sdk.callsTo("threads.send") as [{ threadId: string; mode: string; input: { text: string }[] }][];
  return { host, threads, delegate, toolNames, spawns, sends };
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

test("the first delegation spawns Aide's assistant in the Personal project; the next reuses it", async () => {
  const { host, delegate, spawns, sends } = await load();

  const first = JSON.parse((await delegate({ task: "clone the repo" })).output);
  assert.equal(first.delegated, true);
  assert.equal(first.title, ASSISTANT);
  assert.equal(first.project, "Personal");
  assert.equal(spawns().length, 1);
  const [args] = spawns()[0];
  // Global helper area: never the project in view.
  assert.equal(args.projectId, PERSONAL);
  assert.deepEqual(args.environment, { type: "host", workspace: { type: "personal" } });
  assert.equal(args.title, ASSISTANT);
  assert.match(args.prompt, /read aloud/);
  assert.match(args.prompt, /You live in the user's Personal project/);
  // The project the user was looking at travels with the task as context.
  assert.ok(args.prompt.endsWith('\n\nTask: clone the repo\nContext: the user is in project "Widgets" (proj_1).'));
  assert.equal(await host.bb.storage.kv.get(ASSISTANT_KEY), first.threadId);

  const second = JSON.parse((await delegate({ task: "now run the tests" }, { ...CONTEXT, threadId: "thr_view" })).output);
  assert.equal(second.threadId, first.threadId);
  assert.equal(spawns().length, 1);
  assert.equal(sends().length, 1);
  const [send] = sends()[0];
  assert.equal(send.threadId, first.threadId);
  assert.equal(send.mode, "auto");
  assert.equal(send.input[0].text, 'Task: now run the tests\nContext: the user is in project "Widgets" (proj_1), viewing thread thr_view.');
  // Delegating never navigates: that would yank the user's screen (and end a
  // live mobile call).
  assert.equal(host.harness.sdk.callsTo("threads.open").length, 0);
});

test("an archived or deleted assistant is replaced rather than reused", async () => {
  const { host, threads, delegate, spawns, sends } = await load();
  const first = JSON.parse((await delegate({ task: "a" })).output);

  threads.get(first.threadId)!.archivedAt = Date.now();
  const second = JSON.parse((await delegate({ task: "b" })).output);
  assert.notEqual(second.threadId, first.threadId);
  assert.equal(spawns().length, 2);
  assert.equal(await host.bb.storage.kv.get(ASSISTANT_KEY), second.threadId);

  threads.delete(second.threadId); // gone entirely: threads.get throws
  const third = JSON.parse((await delegate({ task: "c" })).output);
  assert.notEqual(third.threadId, second.threadId);
  assert.equal(spawns().length, 3);
  assert.equal(sends().length, 0);
});

test("delegate works with no project in view, and an explicit project_id is context only", async () => {
  const { delegate, spawns, sends } = await load();
  const first = JSON.parse((await delegate({ task: "x" }, { ...CONTEXT, projectId: null })).output);
  assert.equal(first.delegated, true);
  assert.equal(spawns().length, 1);
  assert.equal(spawns()[0][0].projectId, PERSONAL);
  assert.match(spawns()[0][0].prompt, /Context: the user has no project in view\.$/);

  await delegate({ task: "y", project_id: "proj_other" });
  assert.equal(spawns().length, 1); // reused, still the one global assistant
  assert.match(sends()[0][0].input[0].text, /Context: the user is in project proj_other\.$/);
});

test("upgrade: old per-project assistant pointers are dropped, the global one is kept", async () => {
  const { host } = await load({
    seedKv: { "assistant.proj_1": "thr_old", "assistant.proj_2": "thr_older", [ASSISTANT_KEY]: "thr_global" },
  });
  assert.deepEqual((await host.bb.storage.kv.list("assistant.")).sort(), [ASSISTANT_KEY, "assistant.migrated"]);
  assert.equal(await host.bb.storage.kv.get(ASSISTANT_KEY), "thr_global");
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
    assert.match(sessions[0].instructions, /in the user's Personal project/);

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
    thread: makeThreadResponse({ id: "thr_1", projectId: PERSONAL, title: ASSISTANT, visibility: "visible" }),
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
