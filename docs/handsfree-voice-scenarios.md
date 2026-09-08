# Handsfree voice — behaviors & scenarios

Each behavior, paired with what happens under the hood. For vocabulary and the
underlying model, see [architecture](./handsfree-voice-architecture.md).

Format: **what you do → what happens → ideal outcome**, then **under the hood**.
Behaviors marked *(mobile)* apply to a mobile client (`clientDescriptor.mobile`)
in a live call; on desktop the call survives navigation and these don't trigger.

## 1. Use one call across surfaces (one device)

Start a call on the Handsfree page, then move to a thread. The composer pill and
sidebar show the same live call with a ticking duration, and can mute/stop it.

- **Ideal:** every surface reflects and controls the one call.
- **Under the hood:** the page realm owns the call; other realms mirror its
  presence broadcast and relay controls by nonce. On one device the microphone is
  shared hardware, so you keep talking regardless of which surface is on screen.

## 2. Control a call from another surface or device

Press stop or mute on a surface that didn't start the call — including the desktop
for a phone-owned call.

- **Ideal:** it takes effect and never gets stuck.
- **Under the hood:** stopping a mirrored call goes through server-authoritative
  `forceStop(nonce)` — it marks the session stopped and broadcasts idle + stop, so
  it works even if the owner realm is frozen. Mute/unmute relay as commands the
  owner applies.

## 3. Agent opens an existing thread — `focus_thread` *(mobile)*

You ask Aide to open a thread. It doesn't navigate; it says "tap Live threads,
then select …".

- **Ideal:** the call stays alive; you're told where to tap.
- **Under the hood:** `focus_thread` is in the mobile nav block-list (it
  backgrounds the owner realm). During a live mobile call it's refused with
  guidance instead of run, so the call keeps running.

## 4. Agent starts a new thread — `start_thread` *(mobile)*

You ask Aide to start a thread and let it run. It starts it, the call keeps going,
nothing navigates. Aide says "started — tap it in your list to view."

- **Ideal:** the work starts without dropping the call or moving any screen.
- **Under the hood:** `start_thread` normally spawns then calls `threads.open`
  (navigation, all windows). On a mobile client in a live call the client passes
  `focus:false`; the server spawns **without** `open()`. The thread runs; no realm
  is backgrounded.

## 5. Agent spotlights/maximizes a pane — `set_pane` *(mobile)*

Runs normally.

- **Ideal:** no effect on the call.
- **Under the hood:** pane actions don't replace the full-screen surface on
  mobile, so they don't background the owner. Not gated.

## 6. You background the app mid-call *(mobile)*

You switch apps or go home during a call. The call ends with "call ended — the app
moved to the background", and every surface goes idle.

- **Ideal:** an honest end, not a silent one-way zombie.
- **Under the hood:** the mic track fires `mute` while `hidden`; the owner ends the
  call right then — `forceStop` first (server-enforced, survives the imminent
  freeze) then local teardown. The session logs `session.stopped`; no zombie.

## 7. A call gets stuck anyway

Rare now, but if a call is stranded in a frozen owner, stop from any surface clears
it.

- **Ideal:** no force-quit, no manual cleanup.
- **Under the hood:** `forceStop` is server-side and doesn't need the owner to act.
  Any surface's stop clears presence everywhere and marks the session stopped.

## 8. Navigation targets all windows (known limitation)

`threads.open` delivers to every connected window, so a thread brought on screen
appears on all of them — focusing from the phone also moves the desktop.

- **Handled:** `start_thread` avoids this on a mobile call by suppressing focus
  (scenario 4), so it doesn't move other windows.
- **Open:** a general fix — targeting navigation at one specific client — is a
  bb-native gap.

## 9. Get regular progress updates

Say “give me updates every minute” while viewing a working thread. Aide reports
what changed at that cadence and stops when the thread finishes; say “stop the
updates” to end them sooner.

- **Ideal:** concise, grounded updates arrive without interrupting you or polling
  from the voice model.
- **Under the hood:** the frontend runs one timeout at a time, asks the internal
  `thread_activity` tool for events since its last cursor, and holds a prepared
  update while you or Aide is speaking. Thread completion events and call teardown
  cancel the in-memory schedule automatically.

## How a mis-classified navigating tool self-reports

The nav block-list (currently just `focus_thread`) is small on purpose. If any
other tool ever backgrounds a call, it isn't a silent failure: the call ends
cleanly and the logs record `mic.suspend.teardown {cause: <tool>}` naming it, so
it can be added to the list from evidence rather than guesswork.
