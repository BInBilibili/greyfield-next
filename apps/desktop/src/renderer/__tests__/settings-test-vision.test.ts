import { describe, expect, it } from "vitest";
import { ProviderDiagnostic, VISION_DIAGNOSTIC_MESSAGES } from "@greyfield/core-runtime";
import { createDesktopRuntimeBridge, type DesktopHostApi } from "../desktop-runtime-bridge";
import { settingsT } from "../settings-i18n";
import { describeVisionTest } from "../settings-test-vision";
import type { DesktopIpcEventMap } from "../../shared/ipc";

describe("vision test state", () => {
  it("deduplicates, invalidates old results and preserves independent chat/voice state", () => {
    const sent: Array<[string, unknown]> = [];
    let reply: ((payload: DesktopIpcEventMap["provider:test-vision-result"]) => void) | undefined;
    const bridge = createDesktopRuntimeBridge({ send: (c,p) => sent.push([c,p]), on: (c,h) => { if (c === "provider:test-vision-result") reply = h as typeof reply; return () => {}; } });
    const requestId = (index: number) => (sent.filter(([channel]) => channel === "provider:test-vision")[index]![1] as { requestId: string }).requestId;
    const before = bridge.getState();
    expect(bridge.testVisionProvider().visionTest.status).toBe("testing");
    bridge.testVisionProvider();
    expect(sent.filter(([c]) => c === "provider:test-vision")).toHaveLength(1);
    bridge.updateSettings({ providerVisionModel: "new-vision" });
    reply?.({ requestId: requestId(0), ok: true, code: "received" });
    expect(bridge.getState().visionTest.status).toBe("idle");
    bridge.testVisionProvider();
    bridge.updateSettings({ providerModel: "chat-unrelated", voiceVolume: 0.5 });
    reply?.({ requestId: requestId(1), ok: true, code: "received" });
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
    expect(describeVisionTest({ status: "error", code: "busy" }, locale)).toMatch(/retry|重试/);
    expect(describeVisionTest({ status: "error", code: "preview" }, locale)).toMatch(/does not test|不会测试/);
  });
  it.each(["providerLLM", "providerBaseUrl", "providerApiKey", "providerVisionModel", "providerMultimodalModel"] as const)("invalidates pending/result for %s without resetting chat or voice", key => {
    const handlers = new Map<string, (payload: any) => void>();
    const ids: string[] = [];
    const bridge = createDesktopRuntimeBridge({ send: (c,p) => { if (c === "provider:test-vision") ids.push((p as { requestId: string }).requestId); }, on: (c,h) => { handlers.set(c,h); return () => {}; } });
    handlers.get("provider:test-llm-result")?.({ ok: true, message: "chat-only", firstToken: "chat" });
    const before = bridge.getState();
    bridge.testVisionProvider();
    bridge.updateSettings({ [key]: "changed" });
    handlers.get("provider:test-vision-result")?.({ requestId: ids[0]!, ok: true, code: "received" });
    expect(bridge.getState().visionTest).toEqual({ status: "idle" });
    expect(bridge.getState().voiceTest).toEqual(before.voiceTest);
    if (key === "providerVisionModel" || key === "providerMultimodalModel") expect(bridge.getState().providerTest).toEqual(before.providerTest);
    bridge.testVisionProvider();
    handlers.get("provider:test-vision-result")?.({ requestId: ids[1]!, ok: true, code: "received" });
    bridge.updateSettings({ [key]: "next" });
    expect(bridge.getState().visionTest.status).toBe("idle");
  });
  it("accepts invalidation from another window and ignores its stale result", () => {
    const handlers = new Map<string, (payload: any) => void>();
    const ids: string[] = [];
    const bridge = createDesktopRuntimeBridge({ send: (c,p) => { if (c === "provider:test-vision") ids.push((p as { requestId: string }).requestId); }, on: (c,h) => { handlers.set(c,h); return () => {}; } });
    bridge.testVisionProvider();
    handlers.get("provider:test-vision-reset")?.({});
    handlers.get("provider:test-vision-result")?.({ requestId: ids[0]!, ok: true, code: "received" });
    expect(bridge.getState().visionTest).toEqual({ status: "idle" });
    expect(bridge.testVisionProvider().visionTest.status).toBe("testing");
  });

});


describe("vision renderer lifetime", () => {
  it.each([0, 1])("settles reload competition without accepting the old result (prior completions: %s)", async priorCompletions => {
    const diagnostic = new ProviderDiagnostic();
    let reply: ((payload: DesktopIpcEventMap["provider:test-vision-result"]) => void) | undefined;
    const inflight: Promise<void>[] = [];
    const ids: string[] = [];
    let hang = false;
    let release!: () => void;
    const host: DesktopHostApi = {
      on(channel, handler) {
        if (channel === "provider:test-vision-result") reply = handler as typeof reply;
        return () => {};
      },
      send(channel, payload) {
        if (channel !== "provider:test-vision") return;
        const { requestId } = payload as { requestId: string };
        ids.push(requestId);
        inflight.push((async () => {
          const result = await diagnostic.run({ async *stream() {
            if (hang) await new Promise<void>(resolve => { release = resolve; });
            yield "old or current private token";
          } }, VISION_DIAGNOSTIC_MESSAGES);
          // Same WebContents now delivers to the reloaded renderer, not the old bridge.
          if (result) reply?.({ ...result, requestId });
        })());
      }
    };
    try {
      const old = createDesktopRuntimeBridge(host);
      for (let i = 0; i < priorCompletions; i++) {
        old.testVisionProvider(); await Promise.all(inflight);
      }
      hang = true;
      old.testVisionProvider();
      const oldId = ids.at(-1)!;
      const fresh = createDesktopRuntimeBridge(host);
      fresh.testVisionProvider();
      await inflight.at(-1);
      expect(fresh.getState().visionTest).toEqual({ status: "error", code: "busy" });
      expect(ids.at(-1)).not.toBe(oldId);
      release(); await Promise.all(inflight);
      expect(fresh.getState().visionTest).toEqual({ status: "error", code: "busy" });
      hang = false;
      fresh.testVisionProvider(); await Promise.all(inflight);
      expect(fresh.getState().visionTest).toEqual({ status: "success", code: "received" });
    } finally {
      release?.(); diagnostic.invalidate(); await Promise.all(inflight);
    }
  });

  it("does not reuse first-request IDs across renderer bridges or accept stale success", () => {
    const sent: string[] = [];
    let reply: ((payload: DesktopIpcEventMap["provider:test-vision-result"]) => void) | undefined;
    const host: DesktopHostApi = {
      send(channel, payload) { if (channel === "provider:test-vision") sent.push((payload as { requestId: string }).requestId); },
      on(channel, handler) { if (channel === "provider:test-vision-result") reply = handler as typeof reply; return () => {}; }
    };
    createDesktopRuntimeBridge(host).testVisionProvider();
    const fresh = createDesktopRuntimeBridge(host);
    fresh.testVisionProvider(); fresh.testVisionProvider();
    expect(sent).toHaveLength(2);
    expect(sent[0]).not.toBe(sent[1]);
    reply?.({ requestId: sent[0]!, ok: true, code: "received" });
    expect(fresh.getState().visionTest.status).toBe("testing");
    reply?.({ requestId: sent[1]!, ok: true, code: "received" });
    expect(fresh.getState().visionTest.status).toBe("success");
  });
});
