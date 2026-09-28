import type { RealtimeVoiceBridgeCreateRequest } from "openclaw/plugin-sdk/realtime-voice";
import { describe, expect, it, vi } from "vitest";
import type { RawData } from "ws";
import {
  connectCarrierStream,
  createBridge,
  createCarrierLifecycleHarness,
} from "./realtime-handler.lifecycle.test-helpers.js";

const LOUD_FRAME = Buffer.alloc(160, 0x00);
const TEST_TIMEOUT_MS = 15_000;

type CarrierFrame = {
  event?: string;
  mark?: { name?: string };
};

function isSilence(buffer: Buffer): boolean {
  return buffer.every((byte) => byte === 0xff);
}

function observeCarrierFrames(
  ws: Awaited<ReturnType<typeof connectCarrierStream>>["ws"],
): CarrierFrame[] {
  const frames: CarrierFrame[] = [];
  ws.on("message", (data: RawData) => {
    try {
      const bytes = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data);
      frames.push(JSON.parse(bytes.toString("utf8")) as CarrierFrame);
    } catch {
      // ignore non-JSON carrier frames
    }
  });
  return frames;
}

function sendCallerAudio(
  ws: Awaited<ReturnType<typeof connectCarrierStream>>["ws"],
  audio = LOUD_FRAME,
): void {
  ws.send(
    JSON.stringify({
      event: "media",
      media: { payload: audio.toString("base64") },
    }),
  );
}

async function expectCallerAudio(
  ws: Awaited<ReturnType<typeof connectCarrierStream>>["ws"],
  providerAudio: Buffer[],
  expected: "audio" | "silence",
): Promise<void> {
  providerAudio.length = 0;
  sendCallerAudio(ws);
  await vi.waitFor(() => expect(providerAudio.length).toBeGreaterThan(0));
  expect(providerAudio.every(isSilence)).toBe(expected === "silence");
}

function findGreetingCompletionMark(frames: CarrierFrame[]): string | undefined {
  return frames.find(
    (frame) =>
      frame.event === "mark" && frame.mark?.name?.startsWith("openclaw-greeting-complete-"),
  )?.mark?.name;
}

describe("RealtimeCallHandler greeting protection", () => {
  it(
    "mutes caller audio to the provider while the opening greeting is protected",
    async () => {
      let callbacks: RealtimeVoiceBridgeCreateRequest | undefined;
      const providerAudio: Buffer[] = [];
      const { call, handler } = createCarrierLifecycleHarness(
        (request) => {
          callbacks = request;
          return createBridge(() => undefined, {
            sendAudio: (audio: Buffer) => {
              providerAudio.push(Buffer.from(audio));
            },
          });
        },
        { initialMessage: "Hello, is this a good time?" },
      );
      const { server, ws } = await connectCarrierStream(handler);
      try {
        ws.send(
          JSON.stringify({
            event: "start",
            start: { streamSid: "MZ-greet-mute", callSid: call.providerCallId },
          }),
        );
        await vi.waitFor(() => expect(callbacks).toBeDefined());
        callbacks?.onReady?.();
        await expectCallerAudio(ws, providerAudio, "silence");
      } finally {
        ws.terminate();
        await handler.close().catch(() => undefined);
        await server.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "releases caller audio when the greeting never produces audio",
    async () => {
      let callbacks: RealtimeVoiceBridgeCreateRequest | undefined;
      const providerAudio: Buffer[] = [];
      const { call, handler } = createCarrierLifecycleHarness(
        (request) => {
          callbacks = request;
          return createBridge(() => undefined, {
            sendAudio: (audio: Buffer) => {
              providerAudio.push(Buffer.from(audio));
            },
          });
        },
        { initialMessage: "Hello, is this a good time?" },
      );
      const { server, ws } = await connectCarrierStream(handler);
      try {
        ws.send(
          JSON.stringify({
            event: "start",
            start: { streamSid: "MZ-greet-stall", callSid: call.providerCallId },
          }),
        );
        await vi.waitFor(() => expect(callbacks).toBeDefined());
        callbacks?.onReady?.();
        await expectCallerAudio(ws, providerAudio, "silence");

        // A completed greeting turn with no audio is terminal, so caller audio resumes immediately.
        callbacks?.onResponseDone?.({ status: "completed", responseId: "greeting" });
        await expectCallerAudio(ws, providerAudio, "audio");
      } finally {
        ws.terminate();
        await handler.close().catch(() => undefined);
        await server.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps protection until the carrier confirms the greeting played, then resumes caller audio",
    async () => {
      let callbacks: RealtimeVoiceBridgeCreateRequest | undefined;
      const providerAudio: Buffer[] = [];
      const { call, handler } = createCarrierLifecycleHarness(
        (request) => {
          callbacks = request;
          return createBridge(() => undefined, {
            sendAudio: (audio: Buffer) => {
              providerAudio.push(Buffer.from(audio));
            },
          });
        },
        { initialMessage: "Hello, is this a good time?" },
      );
      const { server, ws } = await connectCarrierStream(handler);
      const outboundFrames = observeCarrierFrames(ws);
      try {
        ws.send(
          JSON.stringify({
            event: "start",
            start: { streamSid: "MZ-greet-confirm", callSid: call.providerCallId },
          }),
        );
        await vi.waitFor(() => expect(callbacks).toBeDefined());
        vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
        callbacks?.onReady?.();
        // The provider produces the greeting, then reports the turn complete.
        callbacks?.onAudio?.(Buffer.alloc(160 * 8, 0xff), { itemId: "greeting-1" });
        callbacks?.onResponseDone?.({ status: "completed", responseId: "greeting" });
        vi.advanceTimersByTime(1_000);

        // The completion mark is queued only once the pacer is drained and the line is quiet.
        await vi.waitFor(() => expect(findGreetingCompletionMark(outboundFrames)).toBeDefined());
        expect(
          outboundFrames.some(
            (frame) => frame.event === "mark" && frame.mark?.name?.startsWith("openclaw-playout-"),
          ),
        ).toBe(true);

        // Until the carrier acknowledges the mark, caller audio is still muted.
        await expectCallerAudio(ws, providerAudio, "silence");

        // The carrier reports the mark reached playout; protection disarms.
        const greetingCompletionMark = findGreetingCompletionMark(outboundFrames);
        expect(greetingCompletionMark).toBeDefined();
        ws.send(JSON.stringify({ event: "mark", mark: { name: greetingCompletionMark } }));
        await expectCallerAudio(ws, providerAudio, "audio");
      } finally {
        vi.useRealTimers();
        ws.terminate();
        await handler.close().catch(() => undefined);
        await server.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "releases greeting protection when provider continuity resets",
    async () => {
      let callbacks: RealtimeVoiceBridgeCreateRequest | undefined;
      const providerAudio: Buffer[] = [];
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const { call, handler } = createCarrierLifecycleHarness(
        (request) => {
          callbacks = request;
          return createBridge(() => undefined, {
            sendAudio: (audio: Buffer) => {
              providerAudio.push(Buffer.from(audio));
            },
          });
        },
        { initialMessage: "Hello, is this a good time?" },
      );
      const { server, ws } = await connectCarrierStream(handler);
      const outboundFrames = observeCarrierFrames(ws);
      try {
        ws.send(
          JSON.stringify({
            event: "start",
            start: { streamSid: "MZ-greet-continuity-reset", callSid: call.providerCallId },
          }),
        );
        await vi.waitFor(() => expect(callbacks).toBeDefined());
        vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
        callbacks?.onReady?.();
        callbacks?.onAudio?.(Buffer.alloc(160 * 8, 0xff), { itemId: "greeting-1" });
        callbacks?.onResponseDone?.({ status: "completed", responseId: "greeting" });
        vi.advanceTimersByTime(1_000);
        await vi.waitFor(() => expect(findGreetingCompletionMark(outboundFrames)).toBeDefined());
        await expectCallerAudio(ws, providerAudio, "silence");

        const clearCountBeforeReset = outboundFrames.filter(
          (frame) => frame.event === "clear",
        ).length;
        callbacks?.onEvent?.({ direction: "client", type: "session.continuity.reset" });

        expect(log).toHaveBeenCalledWith(expect.stringContaining("reason=continuity-reset"));
        await vi.waitFor(() =>
          expect(outboundFrames.filter((frame) => frame.event === "clear")).toHaveLength(
            clearCountBeforeReset + 1,
          ),
        );
        await expectCallerAudio(ws, providerAudio, "audio");

        callbacks?.onAudio?.(Buffer.alloc(160 * 8, 0xff), { itemId: "after-reset" });
        const clearCount = outboundFrames.filter((frame) => frame.event === "clear").length;
        callbacks?.onClearAudio("barge-in");
        await vi.waitFor(() =>
          expect(outboundFrames.filter((frame) => frame.event === "clear")).toHaveLength(
            clearCount + 1,
          ),
        );
      } finally {
        vi.useRealTimers();
        log.mockRestore();
        ws.terminate();
        await handler.close().catch(() => undefined);
        await server.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps late greeting audio protected after releasing caller audio during the pre-audio wait",
    async () => {
      let callbacks: RealtimeVoiceBridgeCreateRequest | undefined;
      const providerAudio: Buffer[] = [];
      const { call, handler } = createCarrierLifecycleHarness(
        (request) => {
          callbacks = request;
          return createBridge(() => undefined, {
            sendAudio: (audio: Buffer) => {
              providerAudio.push(Buffer.from(audio));
            },
          });
        },
        { initialMessage: "Hello, is this a good time?" },
      );
      const { server, ws } = await connectCarrierStream(handler);
      const outboundFrames = observeCarrierFrames(ws);
      try {
        ws.send(
          JSON.stringify({
            event: "start",
            start: { streamSid: "MZ-greet-late", callSid: call.providerCallId },
          }),
        );
        await vi.waitFor(() => expect(callbacks).toBeDefined());
        vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
        callbacks?.onReady?.();
        await expectCallerAudio(ws, providerAudio, "silence");

        vi.advanceTimersByTime(3_100);
        await expectCallerAudio(ws, providerAudio, "audio");

        callbacks?.onAudio?.(Buffer.alloc(160 * 16, 0xff), { itemId: "greeting-late" });
        const clearCount = outboundFrames.filter((frame) => frame.event === "clear").length;
        callbacks?.onClearAudio("barge-in");
        providerAudio.length = 0;
        for (let index = 0; index < 4; index += 1) {
          sendCallerAudio(ws);
        }
        await vi.waitFor(() => expect(providerAudio).toHaveLength(4));
        expect(providerAudio.every(isSilence)).toBe(true);
        expect(outboundFrames.filter((frame) => frame.event === "clear")).toHaveLength(clearCount);
      } finally {
        vi.useRealTimers();
        ws.terminate();
        await handler.close().catch(() => undefined);
        await server.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps the greeting protected while its completion mark is unacknowledged",
    async () => {
      let callbacks: RealtimeVoiceBridgeCreateRequest | undefined;
      const providerAudio: Buffer[] = [];
      const { call, handler } = createCarrierLifecycleHarness(
        (request) => {
          callbacks = request;
          return createBridge(() => undefined, {
            sendAudio: (audio: Buffer) => {
              providerAudio.push(Buffer.from(audio));
            },
          });
        },
        { initialMessage: "Hello, is this a good time?" },
      );
      const { server, ws } = await connectCarrierStream(handler);
      const outboundFrames = observeCarrierFrames(ws);
      try {
        ws.send(
          JSON.stringify({
            event: "start",
            start: { streamSid: "MZ-greet-unacknowledged", callSid: call.providerCallId },
          }),
        );
        await vi.waitFor(() => expect(callbacks).toBeDefined());
        vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
        callbacks?.onReady?.();
        callbacks?.onAudio?.(Buffer.alloc(160 * 8, 0xff), { itemId: "greeting-1" });
        callbacks?.onResponseDone?.({ status: "completed", responseId: "greeting" });
        vi.advanceTimersByTime(1_000);
        await vi.waitFor(() => expect(findGreetingCompletionMark(outboundFrames)).toBeDefined());

        // Advancing beyond the former short grace must not substitute for carrier acknowledgement.
        vi.advanceTimersByTime(5_100);
        const clearCount = outboundFrames.filter((frame) => frame.event === "clear").length;
        callbacks?.onClearAudio("barge-in");
        await expectCallerAudio(ws, providerAudio, "silence");
        expect(outboundFrames.filter((frame) => frame.event === "clear")).toHaveLength(clearCount);
      } finally {
        vi.useRealTimers();
        ws.terminate();
        await handler.close().catch(() => undefined);
        await server.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
