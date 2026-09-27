import type { RealtimeVoiceBridgeCreateRequest } from "openclaw/plugin-sdk/realtime-voice";
import { describe, expect, it, vi } from "vitest";
import {
  connectCarrierStream,
  createBridge,
  createCarrierLifecycleHarness,
} from "./realtime-handler.lifecycle.test-helpers.js";

// mu-law codes chosen so the decoded levels sit either side of the phantom guard floor
// (PHANTOM_GUARD_MIN_RMS = 0.035) and of each other by more than ECHO_OVERLAP_MARGIN (2.5x).
const ECHO_MULAW = 0x50; // rms ~= 0.0267 — assistant bleed returning through the line
const CALLER_MULAW = 0x30; // rms ~= 0.1190 — a caller talking over the assistant
const ASSISTANT_MULAW = 0x00; // peak output frame (never treated as input)
// Echo loud enough to trip the local speech gate (0.035) on its own, and a caller more than
// ECHO_OVERLAP_MARGIN above it, so the barge-in assertions exercise the learned floor.
const LOUD_ECHO_MULAW = 0x48; // rms ~= 0.0419
const LOUD_CALLER_MULAW = 0x20; // rms ~= 0.2421
const QUIET_ECHO_MULAW = 0x58; // rms ~= 0.0189 — weak bleed, softer than a soft caller

function mulawFrame(code: number, bytes = 160): Buffer {
  return Buffer.alloc(bytes, code);
}

async function sendMedia(ws: { send: (data: string) => void }, bytes: Buffer): Promise<void> {
  ws.send(JSON.stringify({ event: "media", media: { payload: bytes.toString("base64") } }));
}

async function waitForFrames(
  processEvent: ReturnType<typeof vi.fn>,
  expected: number,
): Promise<void> {
  await vi.waitFor(() => {
    const speechCalls = processEvent.mock.calls.filter(([event]) => event.type === "call.speech");
    expect(speechCalls.length).toBeGreaterThanOrEqual(expected);
  });
}

describe("RealtimeCallHandler echo/phantom input guard", () => {
  it("keeps a genuine caller turn that rises clearly above the learned echo floor", async () => {
    let callbacks: RealtimeVoiceBridgeCreateRequest | undefined;
    const { call, handler, processEvent } = createCarrierLifecycleHarness((request) => {
      callbacks = request;
      return createBridge(() => {});
    });
    const { server, ws } = await connectCarrierStream(handler);
    try {
      ws.send(
        JSON.stringify({
          event: "start",
          start: { streamSid: "MZ-echo-overlap", callSid: call.providerCallId },
        }),
      );
      await vi.waitFor(() => expect(callbacks).toBeDefined());

      // Assistant audio is still playing out; the quiet frames just below are its own bleed.
      callbacks?.onAudio(mulawFrame(ASSISTANT_MULAW));
      for (let index = 0; index < 6; index += 1) {
        await sendMedia(ws, mulawFrame(ECHO_MULAW));
        callbacks?.onAudio(mulawFrame(ASSISTANT_MULAW));
      }
      // The caller now speaks over the assistant, well above the learned echo floor.
      for (let index = 0; index < 3; index += 1) {
        await sendMedia(ws, mulawFrame(CALLER_MULAW));
        callbacks?.onAudio(mulawFrame(ASSISTANT_MULAW));
      }
      // Let the carrier frames reach the handler's input accounting before the provider finalises.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 80);
      });
      callbacks?.onTranscript?.("user", "Yes, book it for Friday.", true);

      await waitForFrames(processEvent as ReturnType<typeof vi.fn>, 1);
      const speech = (processEvent as ReturnType<typeof vi.fn>).mock.calls.find(
        ([event]) => event.type === "call.speech",
      )?.[0] as { transcript?: string } | undefined;
      expect(speech?.transcript).toBe("Yes, book it for Friday.");
    } finally {
      ws.terminate();
      await handler.close();
      await server.close();
    }
  });

  it("suppresses a phantom caller turn conjured only from assistant bleed", async () => {
    let callbacks: RealtimeVoiceBridgeCreateRequest | undefined;
    const { call, handler, processEvent } = createCarrierLifecycleHarness((request) => {
      callbacks = request;
      return createBridge(() => {});
    });
    const { server, ws } = await connectCarrierStream(handler);
    try {
      ws.send(
        JSON.stringify({
          event: "start",
          start: { streamSid: "MZ-echo-phantom", callSid: call.providerCallId },
        }),
      );
      await vi.waitFor(() => expect(callbacks).toBeDefined());

      // Only assistant bleed reached the line: every input frame sits at the echo floor.
      callbacks?.onAudio(mulawFrame(ASSISTANT_MULAW));
      for (let index = 0; index < 6; index += 1) {
        await sendMedia(ws, mulawFrame(ECHO_MULAW));
        callbacks?.onAudio(mulawFrame(ASSISTANT_MULAW));
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 80);
      });
      callbacks?.onTranscript?.("user", "Please cancel the whole order.", true);

      // Give the handler a beat to decide, then assert nothing was persisted as caller speech.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      const speechCalls = (processEvent as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([event]) => event.type === "call.speech",
      );
      expect(speechCalls).toHaveLength(0);
    } finally {
      ws.terminate();
      await handler.close();
      await server.close();
    }
  });

  async function startEchoCall(streamSid: string) {
    let callbacks: RealtimeVoiceBridgeCreateRequest | undefined;
    const handleBargeIn = vi.fn();
    const sendAudio = vi.fn();
    const { call, handler, processEvent } = createCarrierLifecycleHarness((request) => {
      callbacks = request;
      return createBridge(() => {}, { handleBargeIn, sendAudio });
    });
    const { server, ws } = await connectCarrierStream(handler);
    ws.send(JSON.stringify({ event: "start", start: { streamSid, callSid: call.providerCallId } }));
    await vi.waitFor(() => expect(callbacks).toBeDefined());
    // Each inbound frame is sent while assistant audio is still being played out.
    const sendFramesUnderAssistant = async (code: number, count: number) => {
      const expected = sendAudio.mock.calls.length + count;
      for (let index = 0; index < count; index += 1) {
        callbacks?.onAudio(mulawFrame(ASSISTANT_MULAW));
        await sendMedia(ws, mulawFrame(code));
      }
      await vi.waitFor(() => expect(sendAudio).toHaveBeenCalledTimes(expected));
    };
    // Frames sent before any assistant audio reached the line.
    const sendQuietLineFrames = async (code: number, count: number) => {
      const expected = sendAudio.mock.calls.length + count;
      for (let index = 0; index < count; index += 1) {
        await sendMedia(ws, mulawFrame(code));
      }
      await vi.waitFor(() => expect(sendAudio).toHaveBeenCalledTimes(expected));
    };
    const speechTranscripts = () =>
      (processEvent as ReturnType<typeof vi.fn>).mock.calls
        .filter(([event]) => event.type === "call.speech")
        .map(([event]) => (event as { transcript?: string }).transcript);
    const close = async () => {
      ws.terminate();
      await handler.close();
      await server.close();
    };
    return {
      callbacks: () => callbacks,
      close,
      handleBargeIn,
      processEvent: processEvent as ReturnType<typeof vi.fn>,
      sendFramesUnderAssistant,
      sendQuietLineFrames,
      speechTranscripts,
    };
  }

  it("does not let echo above the speech gate barge in over the assistant's own turn", async () => {
    const harness = await startEchoCall("MZ-echo-loud");
    try {
      await harness.sendFramesUnderAssistant(LOUD_ECHO_MULAW, 12);
      expect(harness.handleBargeIn).not.toHaveBeenCalled();

      harness.callbacks()?.onTranscript?.("user", "Please cancel the whole order.", true);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(harness.speechTranscripts()).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it("barges in and keeps the turn when the caller talks over the learned echo floor", async () => {
    const harness = await startEchoCall("MZ-echo-caller-barge-in");
    try {
      await harness.sendFramesUnderAssistant(LOUD_ECHO_MULAW, 6);
      expect(harness.handleBargeIn).not.toHaveBeenCalled();
      await harness.sendFramesUnderAssistant(LOUD_CALLER_MULAW, 3);
      expect(harness.handleBargeIn).toHaveBeenCalled();

      harness.callbacks()?.onTranscript?.("user", "Stop, wrong address.", true);
      await vi.waitFor(() => expect(harness.speechTranscripts()).toEqual(["Stop, wrong address."]));
    } finally {
      await harness.close();
    }
  });

  it("keeps a soft caller turn whose final transcript lands after the assistant starts replying", async () => {
    const harness = await startEchoCall("MZ-echo-soft-caller");
    try {
      // The caller speaks below the speech gate while the line is quiet...
      await harness.sendQuietLineFrames(ECHO_MULAW, 4);
      // ...then the provider starts answering before it delivers the caller's final transcript.
      await harness.sendFramesUnderAssistant(QUIET_ECHO_MULAW, 4);
      harness.callbacks()?.onTranscript?.("user", "Friday works.", true);
      await vi.waitFor(() => expect(harness.speechTranscripts()).toEqual(["Friday works."]));
    } finally {
      await harness.close();
    }
  });

  it("keeps a provider-committed caller turn when no inbound media reached the local gate", async () => {
    const harness = await startEchoCall("MZ-echo-no-local-evidence");
    try {
      // Assistant audio is on the line, but the provider's own VAD/ASR committed the caller turn
      // without any inbound frame passing through the local RMS path: no echo was observed.
      harness.callbacks()?.onAudio(mulawFrame(ASSISTANT_MULAW));
      harness.callbacks()?.onTranscript?.("user", "Yes, that works.", true);
      await vi.waitFor(() => expect(harness.speechTranscripts()).toEqual(["Yes, that works."]));
    } finally {
      await harness.close();
    }
  });
});
