# Handsfree voice — architecture & terminology

Aide is a voice operator for bb: you talk, it drives bb (focuses threads, starts
work, reads output, edits the composer). The call is WebRTC to the OpenAI
GPT-Live API — microphone capture and audio playback happen in the bb app (a
webview); the plugin backend creates the Live session with Responses delegation,
holds the API key, does the SDP exchange, and runs tools via the bb SDK.

This is the shared vocabulary and how it actually works. For behaviors, see
[scenarios](./handsfree-voice-scenarios.md).

## GPT-Live session

The session has two prompts: a short live prompt that defines Aide's voice and
when to delegate, and a detailed backend prompt that defines the operator,
plugin tools, delegation, progress updates, and confirmation rules. The backend
model selects tools; nested `response.event` messages carry function calls to
`app.tsx`/`voice-agent.ts`, which executes them through RPC and replies with
`response.item.create` followed by `response.create`.

Audio and transcript events are full-duplex. Transcript deltas are fragments,
not turns; the client detects a user turn after a 1.5 second gap on the session
timeline. Thread notices and progress updates use `session.commentary.append`.
`session.usage.updated` reports a cumulative voice-seconds snapshot, while
`session.close` followed by `session.closed` supplies final usage. Cost is voice
seconds × $0.05/minute plus the backend model's input, cached-input, and output
tokens. Speak is the exception: it still uses gpt-realtime-2.1-mini.


## Terminology

- **Realm** — an isolated JavaScript world (own globals and memory), like a
  browser tab. Two realms share nothing directly.
- **Surface** — a place the plugin renders: the composer button, the sidebar
  bar, the Handsfree page. bb renders each surface in its **own realm**.
- **Client** — one connected bb app instance: the desktop app, or a phone
  viewing over bb-connect. One client hosts several surfaces/realms.
- **WebRTC call** — the live audio connection between one client's microphone and
  OpenAI. Held by the realm that created it.
- **Owner** — the realm that physically holds the call: its `RTCPeerConnection`,
  mic capture, and audio element.
- **Mirror** — a realm that only reflects a call it doesn't own and relays
  controls to the owner.
- **Presence** — coarse call state (connecting / live / muted / idle + duration)
  broadcast so every surface can mirror it.
- **Command** — a control intent (stop / mute / unmute) relayed to the owner,
  addressed by nonce.
- **Nonce** — a per-call id; also the session id the transcript is logged under.
  Addresses presence and commands to one specific call.
- **clientId / realmId** — ids we mint for observability. `clientId` persists in
  localStorage (stable per device/browser); `realmId` is fresh per realm load
  (identifies one surface instance).

## One call, one realm

A WebRTC call is three physical things — a network connection, the microphone, an
audio element — held by JS objects in a single realm. They can't move to another
realm. So the surface you press "start" on owns the call; other surfaces can only
watch it and relay control. This one fact drives everything below.

Surfaces are separate realms even on one device (observed: distinct realmIds per
client), so a plain module singleton is **not** shared across them — each surface
gets its own instance.

## Cross-surface state

The only channel across realms is bb's event bus. The plugin **backend** can
publish to every connected client; a surface can only **subscribe**. There is no
client-to-client publish, so a surface "broadcasts" by calling an RPC that
publishes.

- The owner publishes **presence** on each coarse transition and on a ~10s
  heartbeat.
- Every other realm mirrors it. A mirror older than ~25s (two missed heartbeats)
  is treated as gone — so a vanished owner never leaves a ghost "live".
- Controls from a non-owner relay as **commands** addressed by nonce; only the
  realm holding that nonce acts.
- Result: composer pill, sidebar, and page all reflect and control the one live
  call, whichever surface started it.

Coarse only: who's-speaking isn't broadcast (too chatty); it shows on the owner
surface.

## Client, device, and event scope

The event bus reaches "every connected client" of one plugin backend —
one bb app instance and everything attached to it (the local view plus remote
bb-connect views). It is **not** cross-machine: a separate, independent bb app has
its own backend, bus, and database. In our setup the phone is a bb-connect client
of the desktop-hosted app, which is why the desktop can see and control a call the
phone owns.

Voice input is always the **owner client's microphone**. Another client can mirror
and control the call but cannot become its microphone; to talk from a different
device you start a new call there (exclusivity ends the old one).

## The mobile constraint

When the owner realm is backgrounded on iOS (e.g. the app navigates away), the OS:

- **suspends the microphone** — the uplink dies (the mic track fires `mute` while
  the page is `hidden`),
- **freezes inbound messages** — the realm stops receiving relayed commands,
- **still fires timers occasionally** — so it keeps emitting presence heartbeats.

Left unhandled, this is a one-way zombie: you hear Aide, Aide can't hear you,
every surface shows "live", and no stop reaches the frozen owner.

A webview cannot hold the microphone in the background — only a native app with
background-audio entitlements can, and we run inside bb's webviews. So a
backgrounded call cannot survive on mobile. The plugin therefore does not try to
keep it alive; it **prevents** the backgrounding where it can and **ends cleanly**
(and recoverably) where it can't.

Desktop (Electron) does not suspend the mic on in-app navigation — audio may pause
while the panel is hidden, but the mic isn't suspended and the call resumes — so
the mobile-only paths below don't trigger there.

## Navigation

`bb.sdk.threads.open` is the navigation primitive (bring a thread on screen). Two
things follow from it:

- `start_thread` **also** navigates — its handler does `spawn()` then
  `threads.open()`.
- `threads.open` **delivers to every connected window**, not just the caller — so
  navigating from the phone also moves the desktop.

The plugin handles these per tool (see scenarios). Per-client navigation
targeting is a bb-native gap (see Known limitations).

## Observability

The SDK exposes no client/device id, so we mint our own and stamp it on events and
presence: `clientId` (device), `realmId` (surface), plus a one-time device
descriptor (platform, browser, runtime, raw user-agent) on `client.hello`. Every
event is then attributable to a device and surface — which is how the mobile bugs
were diagnosed. Suspensions log `mic.suspend.teardown {cause}` naming the tool
that triggered them, so a mis-classified navigating tool self-reports.

## Known limitations

- **No shared/background realm** for plugins — the call is trapped in a
  backgroundable surface. A shared context would remove the need for nav-gating.
- **No per-client navigation targeting** — `threads.open` hits all windows.
  Needed for the "phone is the mic, desktop is the driven screen" handoff model.
