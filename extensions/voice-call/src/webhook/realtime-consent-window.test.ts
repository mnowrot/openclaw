import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RealtimeConsentWindow } from "./realtime-consent-window.js";

function makeWindow(
  overrides: Partial<ConstructorParameters<typeof RealtimeConsentWindow>[0]> = {},
) {
  const onExpired = vi.fn();
  const onLateResponse = vi.fn();
  let botSpeaking = false;
  let callActive = true;
  const window = new RealtimeConsentWindow({
    enabled: true,
    windowMs: 100,
    pollMs: 10,
    isBotSpeaking: () => botSpeaking,
    isCallActive: () => callActive,
    onExpired,
    onLateResponse,
    ...overrides,
  });
  return {
    window,
    onExpired,
    onLateResponse,
    setBotSpeaking: (value: boolean) => {
      botSpeaking = value;
    },
    setCallActive: (value: boolean) => {
      callActive = value;
    },
  };
}

describe("RealtimeConsentWindow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires once when the caller stays silent after the consent question", () => {
    const { window, onExpired } = makeWindow();
    window.noteAssistantTurn();
    vi.advanceTimersByTime(500);
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it("does not arm when the explicit consent flow is disabled", () => {
    const { window, onExpired } = makeWindow({ enabled: false });
    window.noteAssistantTurn();
    vi.advanceTimersByTime(500);
    expect(onExpired).not.toHaveBeenCalled();
  });

  it("only arms for the first assistant turn before any caller response", () => {
    const { window, onExpired } = makeWindow();
    window.noteAssistantTurn();
    vi.advanceTimersByTime(500);
    window.noteAssistantTurn();
    vi.advanceTimersByTime(500);
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it("never fires after the caller has spoken", () => {
    const { window, onExpired } = makeWindow();
    window.noteAssistantTurn();
    window.noteCallerResponded();
    vi.advanceTimersByTime(500);
    window.noteAssistantTurn();
    vi.advanceTimersByTime(500);
    expect(onExpired).not.toHaveBeenCalled();
  });

  it("holds the countdown while the agent is still speaking", () => {
    const { window, onExpired, setBotSpeaking } = makeWindow();
    setBotSpeaking(true);
    window.noteAssistantTurn();
    vi.advanceTimersByTime(500);
    expect(onExpired).not.toHaveBeenCalled();
    setBotSpeaking(false);
    vi.advanceTimersByTime(500);
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it("does not fire when the bridge no longer owns the call", () => {
    const { window, onExpired, setCallActive } = makeWindow();
    window.noteAssistantTurn();
    setCallActive(false);
    vi.advanceTimersByTime(500);
    expect(onExpired).not.toHaveBeenCalled();
  });

  it("records a response that arrives after the window fired", () => {
    const { window, onExpired, onLateResponse } = makeWindow();
    window.noteAssistantTurn();
    vi.advanceTimersByTime(500);
    expect(onExpired).toHaveBeenCalledTimes(1);
    window.noteCallerResponded();
    expect(onLateResponse).toHaveBeenCalledTimes(1);
  });

  it("stops counting down after dispose", () => {
    const { window, onExpired } = makeWindow();
    window.noteAssistantTurn();
    window.dispose();
    vi.advanceTimersByTime(500);
    expect(onExpired).not.toHaveBeenCalled();
  });
});
