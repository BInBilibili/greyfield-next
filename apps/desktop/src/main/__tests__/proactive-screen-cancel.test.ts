import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultGreyfieldConfig } from "@greyfield/persistence/config-schema";
import type { LLMProvider, RuntimeInputEvent } from "@greyfield/core-runtime";
import { RuntimeService } from "../runtime-service";
import { RuntimeProviderFactory } from "../runtime-providers";

const config = {
  ...defaultGreyfieldConfig,
  memory: { ...defaultGreyfieldConfig.memory, useV2System: false },
  provider: { ...defaultGreyfieldConfig.provider, visionModel: "vision-test" },
  ui: { ...defaultGreyfieldConfig.ui, proactiveMemoryEnabled: true, proactivityLevel: 100 }
};
const context = () => ({ attachments: [{
  id: "temporary-screen", mimeType: "image/png", source: "observation-frame" as const,
  dataUrl: "data:image/png;base64,cHJpdmF0ZS1zY3JlZW4=", createdAt: new Date().toISOString()
}] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Cancellation did not settle promptly")), 1500);
    })]);
  } finally { clearTimeout(timer); }
}
function stalledProvider() {
  const pending = deferred<void>();
  let signal: AbortSignal | undefined;
  const provider: LLMProvider = {
    async *stream(_messages, _tools, options) {
      signal = options?.signal;
      yield "old partial";
      await pending.promise; // Deliberately does not cooperate with abort.
      yield " stale result";
    }
  };
  vi.spyOn(RuntimeProviderFactory.prototype, "createVisionLLMProvider").mockReturnValue(provider);
  return { pending, get signal() { return signal; } };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("proactive screen cancellation integration", () => {
  it.each([
    ["Stop", { type: "runtime.interrupt" }],
    ["new text", { type: "text.input", text: "hello" }],
    ["new audio", { type: "audio.input", data: new Uint8Array([1]) }],
    ["audio capture", { type: "audio.chunk", data: new Uint8Array([1]) }]
  ] as Array<[string, RuntimeInputEvent]>)("%s aborts the proactive request and suppresses late output", async (_name, input) => {
    const fixture = stalledProvider();
    const service = new RuntimeService(config);
    const result = service.checkProactiveScreenAwareness(context());
    await Promise.resolve();
    await service.handle(input, () => {});
    try {
      expect(fixture.signal?.aborted).toBe(true);
      await expect(Promise.race([result, new Promise((r) => setTimeout(() => r("held slot"), 100))]))
        .resolves.toMatchObject({ displayed: false });
    } finally { fixture.pending.resolve(); await result; await service.shutdown(); }
  });

  it.each(["disable proactive", "quiet level", "replace config", "shutdown"])("%s aborts in flight", async (action) => {
    const fixture = stalledProvider();
    const service = new RuntimeService(config);
    const result = service.checkProactiveScreenAwareness(context());
    await Promise.resolve();
    if (action === "shutdown") await service.shutdown();
    else service.updateConfig(action === "disable proactive"
      ? { ...config, ui: { ...config.ui, proactiveMemoryEnabled: false } }
      : action === "quiet level" ? { ...config, ui: { ...config.ui, proactivityLevel: 0 } } : config);
    try { expect(fixture.signal?.aborted).toBe(true); }
    finally { fixture.pending.resolve(); }
    await expect(bounded(result)).resolves.toMatchObject({ displayed: false });
  });
  it("screen off releases a stuck run, re-enable admits a fresh run without stale publication or persisted image", async () => {
    const fixture = stalledProvider();
    const service = new RuntimeService(config);
    const publish = vi.fn();
    const old = service.checkProactiveScreenAwareness(context(), publish);
    service.setScreenAwarenessEnabled(false);
    expect(fixture.signal?.aborted).toBe(true);
    await expect(old).resolves.toMatchObject({ displayed: false });
    await expect(service.checkProactiveScreenAwareness(context(), publish)).resolves.toMatchObject({ reason: "disabled" });
    vi.mocked(RuntimeProviderFactory.prototype.createVisionLLMProvider).mockReturnValue({ async *stream() { yield "fresh remark"; } });
    service.setScreenAwarenessEnabled(true);
    await expect(service.checkProactiveScreenAwareness(context(), publish)).resolves.toMatchObject({ displayed: true });
    fixture.pending.resolve();
    await Promise.resolve();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ text: "fresh remark" }));
    const exported = JSON.stringify(await service.exportMemory());
    expect(exported).not.toContain("data:image");
    expect(exported).not.toContain("cHJpdmF0ZS1zY3JlZW4=");
    expect(exported).not.toContain("fresh remark");
    expect(await service.getRecentTurns(20)).toEqual([]);
    await service.shutdown();
    service.setScreenAwarenessEnabled(true);
    await expect(service.checkProactiveScreenAwareness(context(), publish)).resolves.toMatchObject({ reason: "disabled" });
  });

  it("Stop closes a real local HTTP SSE response before the server finishes it", async () => {
    const started = deferred<void>();
    const closed = deferred<void>();
    const server = createServer(async (request, response) => {
      for await (const _part of request) { /* drain request before watching response close */ }
      response.on("close", () => closed.resolve());
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"choices":[{"delta":{"content":"unfinished"}}]}\n\n');
      started.resolve();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const service = new RuntimeService({ ...config, provider: {
      ...config.provider, llm: "openai-compatible", model: "chat-test", apiKey: "local-test",
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
    } });
    try {
      const publish = vi.fn();
      const result = service.checkProactiveScreenAwareness(context(), publish);
      await bounded(started.promise);
      await service.handle({ type: "runtime.interrupt" }, () => {});
      await expect(bounded(result)).resolves.toMatchObject({ displayed: false });
      await bounded(closed.promise);
      expect(publish).not.toHaveBeenCalled();
    } finally {
      await service.shutdown();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each(["request rejection", "HTTP failure", "malformed stream"])("%s degrades without publishing or persisting", async (failure) => {
    const fetch = vi.fn(async () => {
      if (failure === "request rejection") throw new TypeError("Invalid URL or disconnected provider");
      if (failure === "HTTP failure") return new Response("unavailable", { status: 503 });
      return new Response("data: not-json\n\n", { headers: { "content-type": "text/event-stream" } });
    });
    const service = new RuntimeService({ ...config, provider: { ...config.provider,
      llm: "openai-compatible", baseUrl: "http://local.invalid/v1", apiKey: "local-test", model: "chat-test"
    } }, { fetch });
    const publish = vi.fn();
    await expect(service.checkProactiveScreenAwareness(context(), publish)).resolves.toMatchObject({
      displayed: false, reason: "vision_model_not_ready"
    });
    expect(publish).not.toHaveBeenCalled();
    expect(await service.getRecentTurns(20)).toEqual([]);
    expect(JSON.stringify(await service.exportMemory())).not.toContain("data:image");
    await service.shutdown();
  });

});

describe("proactive screen cooldown and input admission", () => {
  it.each(["ordinary input", "unrelated config save"])("preserves successful-publication cooldown after %s", async (action) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-16T12:00:00Z"));
    const stream = vi.fn(async function* () { yield "successful remark"; });
    vi.spyOn(RuntimeProviderFactory.prototype, "createVisionLLMProvider").mockReturnValue({ stream });
    const service = new RuntimeService(config);
    try {
      await expect(service.checkProactiveScreenAwareness(context())).resolves.toMatchObject({ displayed: true });
      vi.setSystemTime(Date.now() + 1000);
      if (action === "ordinary input") await service.handle({ type: "text.input", text: "hello" }, () => {});
      else service.updateConfig({ ...config, ui: { ...config.ui, locale: "en-US" } });
      await expect(service.checkProactiveScreenAwareness(context())).resolves.toMatchObject({ reason: "screen_awareness_cooldown" });
      expect(stream).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + 299000);
      await expect(service.checkProactiveScreenAwareness(context())).resolves.toMatchObject({ displayed: true });
    } finally { await service.shutdown(); }
  });

  it("keeps explicit off/on fresh even after successful publication", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-16T12:00:00Z"));
    vi.spyOn(RuntimeProviderFactory.prototype, "createVisionLLMProvider").mockReturnValue({ async *stream() { yield "fresh"; } });
    const service = new RuntimeService(config);
    try {
      await expect(service.checkProactiveScreenAwareness(context())).resolves.toMatchObject({ displayed: true });
      service.setScreenAwarenessEnabled(false);
      service.setScreenAwarenessEnabled(true);
      await expect(service.checkProactiveScreenAwareness(context())).resolves.toMatchObject({ displayed: true });
    } finally { await service.shutdown(); }
  });

  it.each(["text.input", "audio.end"] as const)("blocks a tick while %s awaits external preparation", async (type) => {
    const preparation = deferred<void>();
    const stream = vi.fn(async function* () { yield "must not interrupt input preparation"; });
    vi.spyOn(RuntimeProviderFactory.prototype, "createVisionLLMProvider").mockReturnValue({ stream });
    const service = new RuntimeService(config);
    const input: RuntimeInputEvent = type === "text.input" ? { type, text: "hello" } : { type };
    // Reproduce main's synchronous input boundary followed by neko/capture await.
    const release = service.beginUserInput(input);
    const handling = (async () => {
      try { await preparation.promise; await service.handle(input, () => {}); }
      finally { release(); }
    })();
    try {
      await expect(service.checkProactiveScreenAwareness(context())).resolves.toMatchObject({ reason: "active_runtime" });
      expect(stream).not.toHaveBeenCalled();
    } finally { preparation.resolve(); await handling; await service.shutdown(); }
  });
});

describe("proactive screen input cleanup", () => {
  it("allows retry after cancelled in-flight input without waiting for the old generator", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-16T12:00:00Z"));
    const fixture = stalledProvider();
    const service = new RuntimeService(config);
    const old = service.checkProactiveScreenAwareness(context());
    try {
      await service.handle({ type: "text.input", text: "hello" }, () => {});
      await expect(old).resolves.toMatchObject({ displayed: false });
      vi.mocked(RuntimeProviderFactory.prototype.createVisionLLMProvider).mockReturnValue({ async *stream() { yield "retry"; } });
      await expect(service.checkProactiveScreenAwareness(context())).resolves.toMatchObject({ displayed: true });
    } finally { fixture.pending.resolve(); await service.shutdown(); }
  });

  it("reserves direct input during runtime creation and releases after creation failure", async () => {
    const creation = deferred<void>();
    const service = new RuntimeService(config);
    // Controlled await at the real service creation boundary, before activeRuntime is assigned.
    const create = vi.spyOn(service as unknown as { createRuntime(): Promise<unknown> }, "createRuntime")
      .mockImplementation(async () => { await creation.promise; throw new Error("creation failed"); });
    const handling = service.handle({ type: "text.input", text: "hello" }, () => {});
    const rejected = expect(handling).rejects.toThrow("creation failed");
    try {
      expect(create).toHaveBeenCalledTimes(1);
      await expect(service.checkProactiveScreenAwareness(context())).resolves.toMatchObject({ reason: "active_runtime" });
      creation.resolve();
      await rejected;
      vi.spyOn(RuntimeProviderFactory.prototype, "createVisionLLMProvider").mockReturnValue({ async *stream() { yield "released"; } });
      await expect(service.checkProactiveScreenAwareness(context())).resolves.toMatchObject({ displayed: true });
    } finally { creation.resolve(); await rejected; await service.shutdown(); }
  });
});
