import { toast } from "sonner";
import type { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { chunkSpeechText, prepareSpeechText } from "./speak-text.ts";
import { waitForIceGathering } from "./voice-agent";

interface RpcClient {
  call: ReturnType<typeof useRpc<typeof rpcContract>>["call"];
}

interface SpeakSession {
  key: string;
  pc: RTCPeerConnection;
  dc: RTCDataChannel;
  audio: HTMLAudioElement;
  chunks: string[];
  nextChunk: number;
  waitingForResponse: boolean;
  finalResponseDone: boolean;
  connectTimer: ReturnType<typeof setTimeout>;
}

class Speaker {
  private rpc: RpcClient | null = null;
  private session: SpeakSession | null = null;

  bind(rpc: RpcClient) {
    this.rpc = rpc;
  }

  toggle({ key, text }: { key: string; text: string }) {
    if (this.session?.key === key) {
      this.stop();
      return;
    }
    if (this.session) this.stop();

    const chunks = chunkSpeechText(prepareSpeechText(text));
    if (chunks.length === 0) return;
    if (!this.rpc) {
      toast.error("Speak: not ready — please try again");
      return;
    }

    let audio: HTMLAudioElement | null = null;
    try {
      // Create and attach playback synchronously in the user gesture so iOS
      // permits the remote WebRTC track to play when it arrives.
      audio = new Audio();
      audio.autoplay = true;
      (audio as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
      audio.setAttribute("playsinline", "");
      audio.style.display = "none";
      document.body.appendChild(audio);

      const pc = new RTCPeerConnection();
      pc.addTransceiver("audio", { direction: "recvonly" });
      const dc = pc.createDataChannel("oai-events");
      const session: SpeakSession = {
        key,
        pc,
        dc,
        audio,
        chunks,
        nextChunk: 0,
        waitingForResponse: false,
        finalResponseDone: false,
        connectTimer: setTimeout(() => {
          if (this.session === session) this.fail(session, "couldn't connect — please try again");
        }, 15_000),
      };
      this.session = session;
      this.attach(session);
      void this.connect(session, this.rpc);
    } catch (error) {
      audio?.remove();
      toast.error(`Speak: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  stop() {
    const session = this.session;
    if (!session) return;
    this.session = null;
    clearTimeout(session.connectTimer);
    session.dc.close();
    session.pc.close();
    session.audio.pause();
    session.audio.srcObject = null;
    session.audio.remove();
  }

  private attach(session: SpeakSession) {
    const { pc, dc, audio } = session;
    pc.ontrack = (event) => {
      if (this.session !== session) return;
      audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      void audio.play().catch((error) => {
        if (this.session !== session || (error instanceof Error && error.name === "AbortError")) return;
        this.fail(session, "can't play audio");
      });
    };
    pc.onconnectionstatechange = () => {
      if (
        this.session === session &&
        (pc.connectionState === "failed" || pc.connectionState === "disconnected")
      ) {
        this.fail(session, "voice connection lost");
      }
    };
    pc.oniceconnectionstatechange = () => {
      if (this.session === session && pc.iceConnectionState === "failed") {
        this.fail(session, "voice connection lost");
      }
    };

    dc.onopen = () => {
      if (this.session !== session) return;
      clearTimeout(session.connectTimer);
      this.sendNext(session);
    };
    dc.onerror = () => {
      if (this.session === session) this.fail(session, "voice connection lost");
    };
    dc.onclose = () => {
      if (this.session === session) this.fail(session, "voice connection lost");
    };
    dc.onmessage = (message) => {
      if (this.session !== session) return;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(String(message.data));
      } catch {
        return;
      }
      const type = String(event.type ?? "");
      if (type === "response.done") {
        if (!session.waitingForResponse) return;
        session.waitingForResponse = false;
        if (session.nextChunk < session.chunks.length) this.sendNext(session);
        else session.finalResponseDone = true;
      } else if (type === "output_audio_buffer.stopped") {
        if (session.finalResponseDone) this.stop();
      } else if (type === "error") {
        const detail = (event.error as { message?: unknown } | undefined)?.message;
        this.fail(session, typeof detail === "string" ? detail : "realtime error");
      }
    };
  }

  private sendNext(session: SpeakSession) {
    if (this.session !== session || session.dc.readyState !== "open") return;
    const chunk = session.chunks[session.nextChunk];
    if (chunk === undefined) return;
    session.nextChunk += 1;
    session.waitingForResponse = true;
    session.dc.send(
      JSON.stringify({
        type: "response.create",
        response: {
          conversation: "none",
          metadata: { kind: "speak" },
          output_modalities: ["audio"],
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: chunk }],
            },
          ],
        },
      }),
    );
  }

  private async connect(session: SpeakSession, rpc: RpcClient) {
    try {
      const offer = await session.pc.createOffer();
      await session.pc.setLocalDescription(offer);
      await waitForIceGathering(session.pc);
      const localSdp = session.pc.localDescription?.sdp;
      if (!localSdp) throw new Error("No local SDP offer");
      const { sdp } = await rpc.call("createSpeakCall", { sdp: localSdp });
      if (this.session !== session) return;
      await session.pc.setRemoteDescription({ type: "answer", sdp });
    } catch (error) {
      if (this.session !== session) return;
      this.fail(session, error instanceof Error ? error.message : String(error));
    }
  }

  private fail(session: SpeakSession, message: string) {
    if (this.session !== session) return;
    toast.error(`Speak: ${message}`);
    this.stop();
  }
}

export const speaker = new Speaker();
