import { describe, expect, it } from "vitest";
import { createDesktopRuntimeBridge } from "../desktop-runtime-bridge";
import { settingsT } from "../settings-i18n";
import { describeVisionTest } from "../settings-test-vision";
import type { DesktopIpcEventMap } from "../../shared/ipc";

describe("vision test state", () => {
  it("deduplicates, invalidates old results and preserves independent chat/voice state", () => {
    const sent: Array<[string, unknown]> = [];
    let reply: ((payload: DesktopIpcEventMap["provider:test-vision-result"]) => void) | undefined;
    const bridge = createDesktopRuntimeBridge({ send: (c,p) => sent.push([c,p]), on: (c,h) => { if (c === "provider:test-vision-result") reply = h as typeof reply; return () => {}; } });
    const before = bridge.getState();
    expect(bridge.testVisionProvider().visionTest.status).toBe("testing");
    bridge.testVisionProvider();
    expect(sent.filter(([c]) => c === "provider:test-vision")).toHaveLength(1);
    bridge.updateSettings({ providerVisionModel: "new-vision" });
    reply?.({ requestId: "1", ok: true, code: "received" });
    expect(bridge.getState().visionTest.status).toBe("idle");
    bridge.testVisionProvider();
    bridge.updateSettings({ providerModel: "chat-unrelated", voiceVolume: 0.5 });
    reply?.({ requestId: "2", ok: true, code: "received" });
    expect(bridge.getState().visionTest.status).toBe("success");
    expect(bridge.getState().voiceTest).toEqual(before.voiceTest);
    expect(bridge.getState().providerTest).toEqual(before.providerTest);
    expect(bridge.getState().messages).toEqual(before.messages);
    expect(bridge.getState().screenAwareness).toEqual(before.screenAwareness);
  });
  it.each(["en-US", "zh-CN"] as const)("makes no understanding claims in %s", locale => {
    const text = describeVisionTest({ status: "success", code: "received" }, locale);
    expect(settingsT(locale, "taskModel.memory.detail")).toMatch(/paused|暂停/);
    expect(settingsT(locale, "taskModel.voiceTts.detail")).not.toMatch(/reserved|暂不扩展/);
    expect(settingsT(locale, "provider.visionModel.detail")).toMatch(/Multimodal|多模态/);
    expect(text).toMatch(/not image understanding|不证明图像理解/);
    expect(describeVisionTest({ status: "error", code: "preview" }, locale)).toMatch(/does not test|不会测试/);
  });
  it.each(["providerLLM", "providerBaseUrl", "providerApiKey", "providerVisionModel", "providerMultimodalModel"] as const)("invalidates pending/result for %s without resetting chat or voice", key => {
    const handlers = new Map<string, (payload: any) => void>();
    const bridge = createDesktopRuntimeBridge({ send: () => {}, on: (c,h) => { handlers.set(c,h); return () => {}; } });
    handlers.get("provider:test-llm-result")?.({ ok: true, message: "chat-only", firstToken: "chat" });
    const before = bridge.getState();
    bridge.testVisionProvider();
    bridge.updateSettings({ [key]: "changed" });
    handlers.get("provider:test-vision-result")?.({ requestId: "1", ok: true, code: "received" });
    expect(bridge.getState().visionTest).toEqual({ status: "idle" });
    expect(bridge.getState().voiceTest).toEqual(before.voiceTest);
    if (key === "providerVisionModel" || key === "providerMultimodalModel") expect(bridge.getState().providerTest).toEqual(before.providerTest);
    bridge.testVisionProvider();
    handlers.get("provider:test-vision-result")?.({ requestId: "2", ok: true, code: "received" });
    bridge.updateSettings({ [key]: "next" });
    expect(bridge.getState().visionTest.status).toBe("idle");
  });
  it("accepts invalidation from another window and ignores its stale result", () => {
    const handlers = new Map<string, (payload: any) => void>();
    const bridge = createDesktopRuntimeBridge({ send: () => {}, on: (c,h) => { handlers.set(c,h); return () => {}; } });
    bridge.testVisionProvider();
    handlers.get("provider:test-vision-reset")?.({});
    handlers.get("provider:test-vision-result")?.({ requestId: "1", ok: true, code: "received" });
    expect(bridge.getState().visionTest).toEqual({ status: "idle" });
    expect(bridge.testVisionProvider().visionTest.status).toBe("testing");
  });

});
