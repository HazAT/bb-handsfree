#!/usr/bin/env node
// Headless GPT-Live text harness using the running Handsfree plugin.
//
//   OPENAI_API_KEY=... node scripts/text-session.mjs "what's running right now?"
//   OPENAI_API_KEY=... node scripts/text-session.mjs --no-tools "say hello"
//   OPENAI_API_KEY=... node scripts/text-session.mjs --debug --bb-url http://127.0.0.1:38886 "list threads"
//
// The key is read from OPENAI_API_KEY and is never printed.

const args = process.argv.slice(2);
const flags = { bbUrl: "http://127.0.0.1:38886", tools: true, debug: false };
const words = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--bb-url") flags.bbUrl = args[++i];
  else if (args[i] === "--no-tools") flags.tools = false;
  else if (args[i] === "--debug") flags.debug = true;
  else words.push(args[i]);
}
const message = words.join(" ").trim();
if (!message) {
  console.error('Usage: node scripts/text-session.mjs [--bb-url URL] [--debug] [--no-tools] "your message"');
  process.exit(1);
}
const key = process.env.OPENAI_API_KEY;
if (!key) {
  console.error("[error] OPENAI_API_KEY is required");
  process.exit(1);
}

async function rpc(method, input) {
  const response = await fetch(`${flags.bbUrl}/api/v1/plugins/handsfree/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  const body = await response.json();
  if (!body.ok) throw new Error(`${method}: ${body.error ?? "RPC failed"}`);
  return body.result;
}

let session;
let localTools = new Set();
try {
  const config = await rpc("getSessionConfig", { threadId: null, projectId: null, onNewThreadScreen: false });
  session = config.session;
  const toolList = await rpc("getTools", null);
  localTools = new Set(toolList.tools.filter((tool) => tool.local).map((tool) => tool.name));
} catch (error) {
  console.error(`[error] plugin RPC failed: ${error.message}`);
  process.exit(1);
}

session.audio = { format: { type: "audio/pcm", rate: 24000 }, output: session.audio.output };
if (flags.tools) {
  console.error(`[config] backend ${session.delegation.responses.model}, ${session.delegation.responses.tools.length} tools, voice ${session.audio.output.voice}`);
} else {
  session.instructions = "You are a concise assistant in a text-only GPT-Live smoke test. Reply briefly to the user.";
  session.delegation.responses.tools = [];
}

const ws = new WebSocket("wss://api.openai.com/v1/live/sessions", { headers: { Authorization: `Bearer ${key}` } });
const send = (event) => ws.send(JSON.stringify(event));
const startedAt = Date.now();
const elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
let finished = false;
let closeSent = false;
let silence;
let closeTimer;
let outTranscript = "";
let finalBackendText = false;
let voiceSeconds;
let backendInput;
let backendOutput;
let timeout;

function fail(message) {
  if (finished) return;
  finished = true;
  clearInterval(silence);
  clearTimeout(closeTimer);
  clearTimeout(timeout);
  console.error(`[error] ${message}`);
  ws.close();
  process.exitCode = 1;
}

function closeSession() {
  if (!closeSent && ws.readyState === WebSocket.OPEN) {
    closeSent = true;
    clearInterval(silence);
    send({ type: "session.close" });
  }
}

ws.addEventListener("open", () => send({ type: "session.start", event_id: "start", session }));
ws.addEventListener("error", () => fail("WebSocket error"));
ws.addEventListener("close", (event) => {
  clearInterval(silence);
  clearTimeout(closeTimer);
  clearTimeout(timeout);
  if (!finished) {
    console.error(`[error] WebSocket closed code=${event.code} ${event.reason || ""}`);
    process.exitCode = 1;
  }
});

ws.addEventListener("message", async (event) => {
  let data;
  try {
    data = JSON.parse(event.data);
  } catch {
    fail("invalid WebSocket event");
    return;
  }
  if (flags.debug) console.error(`[${elapsed()}] ${data.type}`);
  if (data.type === "error") {
    fail(data.error?.message ?? JSON.stringify(data.error ?? data));
    return;
  }
  if (data.type === "session.started") {
    const chunk = Buffer.alloc(4800).toString("base64");
    silence = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) send({ type: "session.input_audio.append", audio: chunk });
    }, 100);
    send({ type: "response.item.create", event_id: "message", item: { type: "message", role: "user", content: [{ type: "input_text", text: message }] } });
    send({ type: "response.create", event_id: "response" });
    console.error(`[user] ${message}`);
    return;
  }
  if (data.type === "session.output_transcript.delta") {
    outTranscript += data.delta;
    return;
  }
  if (data.type === "session.usage.updated") {
    voiceSeconds = data.usage?.seconds;
    return;
  }
  if (data.type === "session.closed") {
    finished = true;
    clearInterval(silence);
    voiceSeconds = data.usage?.seconds ?? voiceSeconds;
    console.error(`[${elapsed()}] session.closed usage=${JSON.stringify(data.usage ?? {})}`);
    ws.close();
    return;
  }
  if (data.type !== "response.event") return;

  const inner = data.event;
  if (inner.type === "response.output_item.done" && inner.item?.type === "function_call") {
    const { name, call_id: callId, arguments: argumentText } = inner.item;
    console.error(`[tool call] ${name}(${argumentText || "{}"})`);
    let output;
    try {
      if (localTools.has(name)) output = "(frontend-only tool; not available in the text harness)";
      else output = (await rpc("runTool", { name, args: JSON.parse(argumentText || "{}"), threadId: null, projectId: null })).output;
    } catch (error) {
      output = `Tool error: ${error.message}`;
    }
    console.error(`[tool result] ${output.length > 300 ? `${output.slice(0, 300)}…` : output}`);
    send({ type: "response.item.create", event_id: `output_${callId}`, item: { type: "function_call_output", call_id: callId, output } });
    send({ type: "response.create", event_id: `continue_${callId}` });
    return;
  }
  if (inner.type === "response.output_item.done" && inner.item?.type === "message") {
    const text = inner.item.content?.map((content) => content.text ?? "").join("") ?? "";
    console.error(`[backend] ${text}`);
    finalBackendText = true;
    closeTimer = setTimeout(closeSession, 8_000);
    return;
  }
  if (inner.type === "response.completed") {
    const usage = inner.response?.usage;
    if (usage) {
      backendInput = usage.input_tokens;
      backendOutput = usage.output_tokens;
    }
  }
});

timeout = setTimeout(() => fail("timeout after 60s"), 60_000);
process.on("exit", () => {
  if (outTranscript) console.error(`[aide] ${outTranscript}`);
  if (voiceSeconds !== undefined || backendInput !== undefined) {
    console.error(`[usage] seconds=${voiceSeconds ?? "?"} backend in/out=${backendInput ?? "?"}/${backendOutput ?? "?"}`);
  }
  if (!finalBackendText && !finished) process.exitCode = 1;
});
