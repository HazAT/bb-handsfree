import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { VoiceAgent, formatThreadNotices } from "./voice-agent.ts";
import { writeAudioDevicePreferences } from "./audio-devices.ts";

/** A VoiceAgent bound to a spy rpc that records every relayed call. */
function agentWithRpcSpy() {
  const calls: { method: string; args: unknown }[] = [];
  const agent = new VoiceAgent();
  agent.bind({
    rpc: {
      call: (async (method: string, args: unknown) => {
        calls.push({ method, args });
        return method === "runTool" ? { output: "Sent." } : { ok: true };
      }) as never,
    },
    context: { threadId: null, projectId: null, onNewThreadScreen: false },
    openNewThread() {},
  });
  // bind() emits a one-time client.hello diagnostic; drop it so tests start clean.
  calls.length = 0;
  return { agent, calls };
}

test("stages relay tools and runs the staged call only after confirmation", async () => {
  const { agent, calls } = agentWithRpcSpy();
  const sent: Record<string, unknown>[] = [];
  const dc = {
    readyState: "open",
    send(data: string) {
      sent.push(JSON.parse(data));
    },
  } as unknown as RTCDataChannel;
  const internals = agent as unknown as {
    session: { dc: RTCDataChannel } | null;
    handleToolCall(dc: RTCDataChannel, event: Record<string, unknown>): Promise<void>;
    confirmationGate: { noteUserTurn(): void };
  };
  internals.session = { dc };
  const args = { thread_id: "thr_work", message: "Run the error-path tests" };

  await internals.handleToolCall(dc, {
    name: "send_to_thread",
    call_id: "call-stage",
    arguments: JSON.stringify(args),
  });
  assert.equal(calls.filter((call) => call.method === "runTool").length, 0);
  assert.match(JSON.stringify(sent), /nothing was sent/i);

  internals.confirmationGate.noteUserTurn();
  await internals.handleToolCall(dc, {
    name: "confirm_pending",
    call_id: "call-confirm",
    arguments: "{}",
  });

  const relayed = calls.filter((call) => call.method === "runTool");
  assert.equal(relayed.length, 1);
  assert.equal((relayed[0].args as { name: string }).name, "send_to_thread");
  assert.deepEqual((relayed[0].args as { args: unknown }).args, args);
});

test("explicit relay to the viewed thread runs immediately with fresh context", async () => {
  const { agent, calls } = agentWithRpcSpy();
  const dc = { readyState: "open", send() {} } as unknown as RTCDataChannel;
  const internals = agent as unknown as {
    session: { dc: RTCDataChannel } | null;
    handleToolCall(dc: RTCDataChannel, event: Record<string, unknown>): Promise<void>;
  };
  internals.session = { dc };
  agent.observeView({ threadId: "thr_view", projectId: "proj_view" });
  await internals.handleToolCall(dc, {
    name: "send_to_thread",
    call_id: "explicit",
    arguments: JSON.stringify({ explicit: true, message: "just say hi back" }),
  });
  const relayed = calls.filter((call) => call.method === "runTool");
  assert.equal(relayed.length, 1);
  assert.deepEqual(relayed[0].args, {
    name: "send_to_thread",
    args: { explicit: true, message: "just say hi back" },
    threadId: "thr_view",
    projectId: "proj_view",
    sessionId: undefined,
  });
});

test("explicit relay to another thread still stages", async () => {
  const { agent, calls } = agentWithRpcSpy();
  const dc = { readyState: "open", send() {} } as unknown as RTCDataChannel;
  const internals = agent as unknown as {
    session: { dc: RTCDataChannel } | null;
    handleToolCall(dc: RTCDataChannel, event: Record<string, unknown>): Promise<void>;
  };
  internals.session = { dc };
  agent.observeView({ threadId: "thr_view", projectId: "proj_view" });
  await internals.handleToolCall(dc, {
    name: "send_to_thread",
    call_id: "other",
    arguments: JSON.stringify({ explicit: true, thread_id: "thr_other", message: "do it" }),
  });
  assert.equal(calls.filter((call) => call.method === "runTool").length, 0);
});

test("observeView adopts route changes but ignores same-thread updates", async () => {
  const { agent, calls } = agentWithRpcSpy();
  const dc = { readyState: "open", send() {} } as unknown as RTCDataChannel;
  const internals = agent as unknown as {
    session: { dc: RTCDataChannel } | null;
    handleToolCall(dc: RTCDataChannel, event: Record<string, unknown>): Promise<void>;
  };
  internals.session = { dc };
  agent.observeView({ threadId: "thr_view", projectId: "proj_one" });
  agent.observeView({ threadId: "thr_view", projectId: "proj_two" });
  await internals.handleToolCall(dc, {
    name: "send_to_thread",
    call_id: "same",
    arguments: JSON.stringify({ explicit: true, message: "one" }),
  });
  assert.equal((calls.find((call) => call.method === "runTool")?.args as { projectId: string }).projectId, "proj_one");
  agent.observeView({ threadId: "thr_two", projectId: "proj_two" });
  await internals.handleToolCall(dc, {
    name: "send_to_thread",
    call_id: "changed",
    arguments: JSON.stringify({ explicit: true, message: "two" }),
  });
  assert.equal((calls.filter((call) => call.method === "runTool")[1].args as { threadId: string }).threadId, "thr_two");
});

test("a tool call from an ended session can't stage into the next session's gate", async () => {
  const { agent, calls } = agentWithRpcSpy();
  const fakeDc = () =>
    ({ readyState: "open", send() {} }) as unknown as RTCDataChannel;
  const oldDc = fakeDc();
  const newDc = fakeDc();
  const internals = agent as unknown as {
    session: { dc: RTCDataChannel } | null;
    handleToolCall(dc: RTCDataChannel, event: Record<string, unknown>): Promise<void>;
    confirmationGate: { noteUserTurn(): void; hasPending(): boolean };
  };
  // The call was stopped and restarted: only newDc is current now.
  internals.session = { dc: newDc };
  const heard = { thread_id: "thr_new", message: "the request the user heard" };
  await internals.handleToolCall(newDc, {
    name: "send_to_thread",
    call_id: "call-new",
    arguments: JSON.stringify(heard),
  });
  // A relay call queued behind a slow tool in the old session surfaces late.
  await internals.handleToolCall(oldDc, {
    name: "send_to_thread",
    call_id: "call-old",
    arguments: JSON.stringify({ thread_id: "thr_old", message: "OLD UNHEARD" }),
  });
  internals.confirmationGate.noteUserTurn();
  await internals.handleToolCall(newDc, { name: "confirm_pending", call_id: "call-confirm", arguments: "{}" });

  const relayed = calls.filter((call) => call.method === "runTool");
  assert.equal(relayed.length, 1);
  assert.deepEqual((relayed[0].args as { args: unknown }).args, heard);
  assert.equal(internals.confirmationGate.hasPending(), false);
});

test("mirrors a call owned by another realm from voice-presence", () => {
  const agent = new VoiceAgent();
  assert.equal(agent.getState(), "idle");

  agent.ingestPresence({ nonce: "call-A", phase: "live", startedAt: 1000 });
  assert.equal(agent.getState(), "live");
  assert.equal(agent.getSessionId(), "call-A");
  assert.equal(agent.getLiveStartedAt(), 1000);

  agent.ingestPresence({ nonce: "call-A", phase: "muted", startedAt: 1000 });
  assert.equal(agent.getState(), "muted");

  // The owner announcing idle clears the mirror on every other surface.
  agent.ingestPresence({ nonce: "call-A", phase: "idle", startedAt: null });
  assert.equal(agent.getState(), "idle");
  assert.equal(agent.getSessionId(), null);
});

test("ignores malformed or nonce-less presence", () => {
  const agent = new VoiceAgent();
  agent.ingestPresence(null);
  agent.ingestPresence({ phase: "live" });
  agent.ingestPresence({ nonce: "x", phase: "bogus" });
  assert.equal(agent.getState(), "idle");
});

test("a mirrored call expires once its heartbeats lapse (no ghost live)", () => {
  mock.timers.enable({ apis: ["Date", "setInterval"] });
  try {
    const agent = new VoiceAgent();
    agent.ingestPresence({ nonce: "call-A", phase: "live", startedAt: 0 });
    assert.equal(agent.getState(), "live");

    mock.timers.tick(10_000); // still within the fresh window
    assert.equal(agent.getState(), "live");

    mock.timers.tick(20_000); // now past PRESENCE_STALE_MS (25s)
    assert.equal(agent.getState(), "idle");
  } finally {
    mock.timers.reset();
  }
});

test("stop/mute from a surface that doesn't own the call is relayed to the owner", () => {
  const { agent, calls } = agentWithRpcSpy();
  agent.ingestPresence({ nonce: "call-A", phase: "live", startedAt: 1000 });

  // Commands also carry client/realm identity (observability); assert the parts
  // that matter for routing.
  const lastArgs = () => calls.at(-1)?.args as { nonce: string; action?: string };

  agent.toggleMuteFromSurface(); // live → mute (relayed to the owner)
  assert.equal(calls.at(-1)?.method, "sendVoiceCommand");
  assert.equal(lastArgs().nonce, "call-A");
  assert.equal(lastArgs().action, "mute");

  agent.ingestPresence({ nonce: "call-A", phase: "muted", startedAt: 1000 });
  agent.toggleMuteFromSurface(); // muted → unmute
  assert.equal(lastArgs().action, "unmute");

  // Stop of a mirrored call is server-authoritative (forceStop) so it works even
  // against a frozen owner, and clears the mirror immediately.
  agent.stopFromSurface();
  assert.equal(calls.at(-1)?.method, "forceStop");
  assert.equal(lastArgs().nonce, "call-A");
  assert.equal(agent.getState(), "idle");

  agent.ingestPresence({ nonce: "call-A", phase: "idle", startedAt: null });
});

test("presence catch-up: a surface requests, a non-owner never answers", () => {
  const { agent, calls } = agentWithRpcSpy();
  agent.requestPresence();
  assert.deepEqual(calls.at(-1), { method: "requestPresence", args: null });

  // We own no call, so a peer's query must NOT make us publish presence.
  calls.length = 0;
  agent.answerPresenceQuery();
  assert.equal(calls.length, 0);
});

test("a relayed command is ignored by a realm that doesn't own that call", () => {
  const { agent, calls } = agentWithRpcSpy();
  // Idle here: we own nothing, so an incoming command must be a no-op.
  agent.applyVoiceCommand({ nonce: "call-A", action: "stop" });
  assert.equal(agent.getState(), "idle");
  assert.equal(calls.length, 0);
});

test("reloads audio preferences saved by another browser window", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: storage },
  });

  try {
    const agent = new VoiceAgent();
    writeAudioDevicePreferences(storage, {
      inputDeviceId: "mic-from-window-a",
      inputLabel: "Window A Mic",
    });

    agent.refreshAudioPreferences();

    assert.deepEqual(agent.getAudioPreferences(), {
      inputDeviceId: "mic-from-window-a",
      inputLabel: "Window A Mic",
    });
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else delete (globalThis as { window?: unknown }).window;
  }
});

test("formats named thread notification content", () => {
  const { logText, content } = formatThreadNotices([{ kind: "idle", threadId: "thr_settings", title: "Install BB Handsfree version", detail: "Updated the notification prompt and reloaded Handsfree." }]);
  assert.match(logText, /Updated the notification prompt/);
  assert.match(content, /Thread "Install BB Handsfree version" finished: Updated the notification prompt/);
});

test("formats multi-thread and unavailable notifications", () => {
  const { content } = formatThreadNotices([
    { kind: "idle", threadId: "thr_review", title: "Review recent GitHub pull requests", detail: "Both pull requests landed on main." },
    { kind: "failed", threadId: "thr_vsix", title: "Enable one-click plugin distribution", detail: "Build script exited with status 1." },
  ]);
  assert.match(content, /Thread "Review recent GitHub pull requests" finished:/);
  assert.match(content, /Thread "Enable one-click plugin distribution" failed:/);
  const unavailable = formatThreadNotices([{ kind: "idle", threadId: "thr_missing", title: "Background task", detail: null }]);
  assert.match(unavailable.content, /no result text; ask me to read it if you want details/);
});

async function liveAgentHarness() {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalPeerConnection = Object.getOwnPropertyDescriptor(globalThis, "RTCPeerConnection");
  const originalAudio = Object.getOwnPropertyDescriptor(globalThis, "Audio");
  const calls: { method: string; args: unknown }[] = [];
  const track = { enabled: true, stop() {} };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  type FakeChannel = RTCDataChannel & { onmessage: ((message: { data: string }) => void) | null };
  // One fake channel per session, so a test can drive a stopped session's
  // channel and a live one side by side.
  const channels: FakeChannel[] = [];
  const makeChannel = () =>
    ({
      readyState: "open",
      onmessage: null as ((message: { data: string }) => void) | null,
      onclose: null as (() => void) | null,
      send(data: string) { calls.push({ method: "send", args: JSON.parse(data) }); },
      close() { this.readyState = "closed"; this.onclose?.(); },
    }) as unknown as FakeChannel;
  class FakePeerConnection {
    iceGatheringState = "complete";
    connectionState = "new";
    localDescription: RTCSessionDescriptionInit | null = null;
    ontrack: ((event: RTCTrackEvent) => void) | null = null;
    onconnectionstatechange: (() => void) | null = null;
    oniceconnectionstatechange: (() => void) | null = null;
    addTrack() {}
    addEventListener() {}
    removeEventListener() {}
    close() {}
    getSenders() { return []; }
    createDataChannel() {
      const channel = makeChannel();
      channels.push(channel);
      return channel;
    }
    async createOffer() { return { type: "offer" as const, sdp: "offer" }; }
    async setLocalDescription(description: RTCSessionDescriptionInit) { this.localDescription = description; }
    async setRemoteDescription() {}
  }
  class FakeAudio {
    autoplay = false;
    srcObject: MediaStream | null = null;
    async play() {}
    remove() {}
  }
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { mediaDevices: {
      getUserMedia: async () => stream,
      enumerateDevices: async () => [{ deviceId: "mic-1", kind: "audioinput", label: "Built-in Mic" }],
    } },
  });
  Object.defineProperty(globalThis, "RTCPeerConnection", { configurable: true, value: FakePeerConnection });
  Object.defineProperty(globalThis, "Audio", { configurable: true, value: FakeAudio });
  const agent = new VoiceAgent();
  agent.bind({
    rpc: { call: (async (method: string, args: unknown) => {
      calls.push({ method, args });
      return method === "createCall" ? { sdp: "answer", sessionId: "live-test" } : { output: "Sent." };
    }) as never },
    context: { threadId: null, projectId: null, onNewThreadScreen: false },
    openNewThread() {},
  });
  const start = async () => {
    agent.toggle();
    await new Promise((resolve) => setImmediate(resolve));
    const channel = channels[channels.length - 1];
    channel.onmessage?.({ data: JSON.stringify({ type: "session.started", session: { id: "live-test" } }) });
    return channel;
  };
  const dc = await start();
  return {
    agent,
    dc,
    calls,
    start,
    cleanup() {
      agent.stop();
      if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
      else delete (globalThis as { navigator?: unknown }).navigator;
      if (originalPeerConnection) Object.defineProperty(globalThis, "RTCPeerConnection", originalPeerConnection);
      else delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
      if (originalAudio) Object.defineProperty(globalThis, "Audio", originalAudio);
      else delete (globalThis as { Audio?: unknown }).Audio;
    },
  };
}

test("transcript timing counts confirmation turns", async () => {
  const { agent, dc, calls, cleanup } = await liveAgentHarness();
  const internals = agent as unknown as {
    handleToolCall(dc: RTCDataChannel, event: Record<string, unknown>): Promise<void>;
  };
  const delta = (start_ms: number, end_ms: number) =>
    dc.onmessage?.({
      data: JSON.stringify({ type: "session.input_transcript.delta", delta: "yes", start_ms, end_ms }),
    });
  const relayed = () => calls.filter((call) => call.method === "runTool");
  const replyTo = (callId: string) =>
    calls
      .filter((call) => call.method === "send")
      .map((call) => call.args as { item?: { call_id?: string; output?: string } })
      .find((sent) => sent.item?.call_id === callId);
  try {
    await internals.handleToolCall(dc, {
      name: "send_to_thread",
      call_id: "stage-1",
      arguments: JSON.stringify({ thread_id: "thr", message: "do it" }),
    });
    // Two fragments 200 ms apart are one spoken turn: the staged call is released.
    delta(0, 400);
    delta(600, 800);
    await internals.handleToolCall(dc, { name: "confirm_pending", call_id: "confirm-1", arguments: "{}" });
    assert.equal(relayed().length, 1);
    assert.equal((relayed()[0].args as { name: string }).name, "send_to_thread");

    await internals.handleToolCall(dc, {
      name: "send_to_thread",
      call_id: "stage-2",
      arguments: JSON.stringify({ thread_id: "thr", message: "do it again" }),
    });
    // Fragments 1.7 s and 2.4 s apart are two turns: the staged call expires.
    delta(2500, 2600);
    delta(5000, 5100);
    await internals.handleToolCall(dc, { name: "confirm_pending", call_id: "confirm-2", arguments: "{}" });
    assert.equal(relayed().length, 1);
    assert.match(replyTo("confirm-2")?.item?.output ?? "", /expired/i);
  } finally {
    cleanup();
  }
});

test("records Live usage snapshots and closes on session.closed", async () => {
  const { agent, dc, calls, cleanup } = await liveAgentHarness();
  try {
    const sessionId = agent.getSessionId();
    dc.onmessage?.({ data: JSON.stringify({ type: "session.usage.updated", usage: { seconds: 42 } }) });
    dc.onmessage?.({ data: JSON.stringify({ type: "session.closed", reason: "close_requested", usage: { seconds: 61 } }) });
    await new Promise((resolve) => setImmediate(resolve));
    const usage = calls.filter((call) => call.method === "recordUsage").map((call) => call.args);
    assert.deepEqual(usage, [
      { sessionId, seconds: 42 },
      { sessionId, seconds: 61 },
    ]);
    assert.equal(agent.getState(), "idle");
  } finally {
    cleanup();
  }
});

test("events from a stopped session's channel never reach the next session", async () => {
  const { agent, dc: oldDc, calls, start, cleanup } = await liveAgentHarness();
  const internals = agent as unknown as {
    handleToolCall(dc: RTCDataChannel, event: Record<string, unknown>): Promise<void>;
  };
  try {
    agent.stop(); // drains: session.close sent, channel still open
    const newDc = await start();
    assert.equal(agent.getState(), "live");
    await internals.handleToolCall(newDc, {
      name: "send_to_thread",
      call_id: "stage",
      arguments: JSON.stringify({ thread_id: "thr", message: "do it" }),
    });
    // The old channel keeps talking: a user turn and even a fresh session.started.
    oldDc.onmessage?.({
      data: JSON.stringify({ type: "session.input_transcript.delta", delta: "yes", start_ms: 0, end_ms: 400 }),
    });
    oldDc.onmessage?.({ data: JSON.stringify({ type: "session.started", session: { id: "stale" } }) });
    await internals.handleToolCall(newDc, { name: "confirm_pending", call_id: "confirm", arguments: "{}" });
    const reply = calls
      .filter((call) => call.method === "send")
      .map((call) => call.args as { item?: { call_id?: string; output?: string } })
      .find((sent) => sent.item?.call_id === "confirm");
    assert.match(reply?.item?.output ?? "", /has not answered/);
    assert.equal(calls.filter((call) => call.method === "runTool").length, 0);
    assert.equal(agent.getState(), "live");
  } finally {
    cleanup();
  }
});

test("session.closed on a draining channel records usage and finalizes at once", async () => {
  const { agent, dc, calls, cleanup } = await liveAgentHarness();
  try {
    const sessionId = agent.getSessionId();
    agent.stop();
    const last = calls.filter((call) => call.method === "send").at(-1)?.args as { type?: string };
    assert.equal(last?.type, "session.close");
    assert.equal(dc.readyState, "open"); // waiting for the acknowledgment
    dc.onmessage?.({
      data: JSON.stringify({ type: "session.closed", reason: "close_requested", usage: { seconds: 61 } }),
    });
    assert.equal(dc.readyState, "closed"); // torn down synchronously, not after the timer
    await new Promise((resolve) => setImmediate(resolve));
    const usage = calls.filter((call) => call.method === "recordUsage").map((call) => call.args);
    assert.deepEqual(usage, [{ sessionId, seconds: 61 }]);
    assert.equal(agent.getState(), "idle");
  } finally {
    cleanup();
  }
});

test("stopping during the SDP exchange closes the mic and cancels startup", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalPeerConnection = Object.getOwnPropertyDescriptor(globalThis, "RTCPeerConnection");
  const originalAudio = Object.getOwnPropertyDescriptor(globalThis, "Audio");
  const track = {
    enabled: true,
    stopped: false,
    stop() {
      this.stopped = true;
    },
  };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  let resolveCall!: () => void;
  let announceCallStarted!: () => void;
  const callStarted = new Promise<void>((resolve) => {
    announceCallStarted = resolve;
  });
  const callPending = new Promise<void>((resolve) => {
    resolveCall = resolve;
  });
  let peer: FakePeerConnection | null = null;

  class FakePeerConnection {
    iceGatheringState = "complete";
    connectionState = "new";
    localDescription: RTCSessionDescriptionInit | null = null;
    closed = false;
    setRemoteCalls = 0;
    ontrack: ((event: RTCTrackEvent) => void) | null = null;
    onconnectionstatechange: (() => void) | null = null;
    oniceconnectionstatechange: (() => void) | null = null;

    constructor() {
      peer = this;
    }

    addTrack() {}
    addEventListener() {}
    removeEventListener() {}
    close() {
      this.closed = true;
    }
    createDataChannel() {
      return { readyState: "connecting", close() {}, send() {}, onopen: null, onclose: null, onmessage: null };
    }
    async createOffer() {
      return { type: "offer" as const, sdp: "offer" };
    }
    async setLocalDescription(description: RTCSessionDescriptionInit) {
      this.localDescription = description;
    }
    async setRemoteDescription() {
      this.setRemoteCalls += 1;
    }
  }

  class FakeAudio {
    autoplay = false;
    srcObject: MediaStream | null = null;
    async play() {}
    remove() {}
  }

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async () => stream,
        enumerateDevices: async () => [
          { deviceId: "mic-1", kind: "audioinput", label: "Built-in Mic" },
        ],
      },
    },
  });
  Object.defineProperty(globalThis, "RTCPeerConnection", {
    configurable: true,
    value: FakePeerConnection,
  });
  Object.defineProperty(globalThis, "Audio", {
    configurable: true,
    value: FakeAudio,
  });

  const agent = new VoiceAgent();
  agent.bind({
    rpc: {
      // Pause startup at the SDP exchange so the test can stop mid-flight.
      call: (async (method: string) => {
        if (method === "createCall") {
          announceCallStarted();
          await callPending;
          return { sdp: "answer" };
        }
        return { ok: true };
      }) as never,
    },
    context: { threadId: null, projectId: null },
    composer: { setText() {}, updateText() {} },
    openNewThread() {},
  });
  agent.setAudioPreferences({ inputDeviceId: "", inputLabel: "" });

  try {
    agent.toggle();
    await callStarted;
    agent.stop();

    assert.equal(track.stopped, true);
    assert.equal(peer?.closed, true);

    resolveCall();
    await new Promise((resolve) => setImmediate(resolve));
    // Stopped mid-exchange: the answer must never be applied.
    assert.equal(peer?.setRemoteCalls, 0);
    assert.equal(agent.getState(), "idle");
  } finally {
    resolveCall();
    agent.stop();
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete (globalThis as { navigator?: unknown }).navigator;
    if (originalPeerConnection) Object.defineProperty(globalThis, "RTCPeerConnection", originalPeerConnection);
    else delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
    if (originalAudio) Object.defineProperty(globalThis, "Audio", originalAudio);
    else delete (globalThis as { Audio?: unknown }).Audio;
  }
});
