import { describe, expect, it, vi } from "vitest";
import { mergeConfig } from "@greyfield/persistence/config-schema";
import { VISION_DIAGNOSTIC_MESSAGES } from "@greyfield/core-runtime";
import { RuntimeService } from "../runtime-service";

const config = () => mergeConfig({ provider: { llm: "openai-compatible", baseUrl: "http://localhost/v1", apiKey: "private-key", taskModels: { chat: "chat-only", vision: "vision-only", multimodal: "multimodal-only" } } });
const token = 'data: {"choices":[{"delta":{"content":"private-key private-body at stack"}}]}\n\n';

describe("Settings vision diagnostic ownership", () => {
  it.each([
    [{ llm: "fake" }, "preview"],
    [{ baseUrl: "" }, "base-url"],
    [{ baseUrl: "invalid" }, "invalid-url"],
    [{ baseUrl: "file:///secret" }, "invalid-url"],
    [{ baseUrl: "https://key:secret@example.com/v1" }, "invalid-url"],
    [{ apiKey: " " }, "api-key"],
    [{ visionModel: "", taskModels: { vision: "", multimodal: "" } }, "model"]
  ] as const)("rejects incomplete/invalid config without HTTP: %j", async (patch, code) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const service = new RuntimeService(mergeConfig({ ...config(), provider: { ...config().provider, ...patch, taskModels: { ...config().provider.taskModels, ...("taskModels" in patch ? patch.taskModels : {}) } } }), { fetch });
    expect(await service.testVision()).toEqual({ ok: false, code });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([true, false])("routes the sample to vision then multimodal, with no sessions or memory (vision=%s)", async vision => {
    const c = config();
    if (!vision) { c.provider.taskModels.vision = ""; c.provider.visionModel = ""; }
    let signal: AbortSignal | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      signal = init?.signal as AbortSignal;
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(token)); } }));
    });
    const service = new RuntimeService(c, { fetch });
    expect(await service.testVision()).toEqual({ ok: true, code: "received" });
    expect(signal?.aborted).toBe(true);
    const body = JSON.parse(fetch.mock.calls[0]![1]!.body as string);
    expect(body.model).toBe(vision ? "vision-only" : "multimodal-only");
    expect(body.messages).toEqual(VISION_DIAGNOSTIC_MESSAGES);
    expect(await service.getRecentTurns(20)).toEqual([]);
    await service.shutdown();
  });

  it.each([[401, "unauthorized"], [503, "unavailable"]] as const)("safe HTTP %s", async (status, code) => {
    const service = new RuntimeService(config(), { fetch: async () => new Response("private-body", { status, statusText: "private-key at stack" }) });
    expect(await service.testVision()).toEqual({ ok: false, code });
  });
  it.each([["data: {invalid private-key}\n\n", "stream"], ["data: [DONE]\n\n", "empty"]] as const)("safe stream %s", async (body, code) => {
    const service = new RuntimeService(config(), { fetch: async () => new Response(body) });
    expect(await service.testVision()).toEqual({ ok: false, code });
  });
  it.each(["config", "shutdown", "timeout"])("cancels an HTTP transport on %s", async reason => {
    let signal: AbortSignal | undefined;
    const service = new RuntimeService(config(), { llmTimeoutMs: reason === "timeout" ? 15 : 1000, fetch: async (_url, init) => {
      signal = init?.signal as AbortSignal;
      return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("private-key"))));
    } });
    const pending = service.testVision();
    expect(await service.testVision()).toBeUndefined();
    if (reason === "config") service.updateConfig({ ...config(), provider: { ...config().provider, taskModels: { ...config().provider.taskModels, vision: "new-vision" } } });
    if (reason === "shutdown") await service.shutdown();
    expect(await pending).toEqual(reason === "timeout" ? { ok: false, code: "timeout" } : undefined);
    expect(signal?.aborted).toBe(true);
  });
  it("unrelated chat/voice config edits do not cancel a vision test", async () => {
    let release!: (response: Response) => void;
    const service = new RuntimeService(config(), { fetch: async () => new Promise(resolve => { release = resolve; }) });
    const pending = service.testVision();
    const c = config(); c.provider.taskModels.chat = "new-chat"; c.voice.volume = 0.1;
    service.updateConfig(c);
    release(new Response(token));
    expect(await pending).toEqual({ ok: true, code: "received" });
  });
  it("owns cancellation while awaiting settings, so an old click cannot consume a newer run", async () => {
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(token));
    const service = new RuntimeService(config(), { fetch });
    const stale = service.testVision(() => ready);
    expect(fetch).not.toHaveBeenCalled();
    service.invalidateVisionTest();
    const fresh = service.testVision(() => ready);
    service.updateConfig({ ...config(), provider: { ...config().provider, visionModel: "saved-vision", taskModels: { ...config().provider.taskModels, vision: "saved-vision" } } });
    release();
    expect(await stale).toBeUndefined();
    expect(await fresh).toEqual({ ok: true, code: "received" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string).model).toBe("saved-vision");
  });
  it("reports save failure safely and restores diagnostic admission", async () => {
    const service = new RuntimeService(config(), { fetch: async () => new Response(token) });
    expect(await service.testVision(async () => { throw new Error("private-key stack"); })).toEqual({ ok: false, code: "save" });
    expect(await service.testVision()).toEqual({ ok: true, code: "received" });
  });

  it("vision diagnostics can run while chat is active and do not append diagnostic messages", async () => {
    let chatStarted!: () => void;
    const started = new Promise<void>(resolve => { chatStarted = resolve; });
    const service = new RuntimeService(config(), { fetch: async (_url, init) => {
      const body = JSON.parse(init?.body as string);
      if (body.model === "chat-only") {
        chatStarted();
        return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      }
      return new Response(token);
    } });
    const chat = service.handle({ type: "text.input", text: "ordinary chat" }, () => {});
    await started;
    expect(await service.testVision()).toEqual({ ok: true, code: "received" });
    await service.handle({ type: "runtime.interrupt" }, () => {});
    await chat;
    expect(JSON.stringify(await service.getRecentTurns(20))).not.toMatch(/built-in|data:image|Connectivity diagnostic/);
  });

});
