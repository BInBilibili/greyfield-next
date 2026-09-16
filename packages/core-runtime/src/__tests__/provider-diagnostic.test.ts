import { describe, expect, it } from "vitest";
import { ProviderDiagnostic, VISION_DIAGNOSTIC_MESSAGES } from "../provider-diagnostic";
import type { LLMProvider } from "../providers";

describe("bounded provider diagnostic", () => {
  it("aborts transport after the first valid token without returning provider text", async () => {
    let aborted = false;
    const provider: LLMProvider = { async *stream(_messages, _tools, options) {
      options?.signal?.addEventListener("abort", () => { aborted = true; });
      yield " "; yield "private upstream content";
      await new Promise(() => {});
    } };
    expect(await new ProviderDiagnostic().run(provider, VISION_DIAGNOSTIC_MESSAGES)).toEqual({ ok: true, code: "received" });
    expect(aborted).toBe(true);
  });
  it("deduplicates, cancels and permits a new generation", async () => {
    const diagnostic = new ProviderDiagnostic();
    const hanging: LLMProvider = { async *stream(_m, _t, options) {
      await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve()));
    } };
    const old = diagnostic.run(hanging, VISION_DIAGNOSTIC_MESSAGES);
    expect(await diagnostic.run(hanging, VISION_DIAGNOSTIC_MESSAGES)).toEqual({ ok: false, code: "busy" });
    diagnostic.invalidate();
    expect(await old).toBeUndefined();
    expect(await diagnostic.run({ async *stream() { yield "ok"; } }, VISION_DIAGNOSTIC_MESSAGES)).toEqual({ ok: true, code: "received" });
  });
  it.each([
    ["request failed: 401 key body stack", "unauthorized"],
    ["request failed: 503 private", "unavailable"],
    ["malformed SSE data private", "stream"],
    ["request timed out private", "timeout"],
    ["sk-private stack", "network"]
  ])("only returns a safe code for %s", async (message, code) => {
    const provider: LLMProvider = { async *stream() { throw new Error(message); } };
    expect(await new ProviderDiagnostic().run(provider, VISION_DIAGNOSTIC_MESSAGES)).toEqual({ ok: false, code });
  });
  it("bounds stalled providers and reports empty streams", async () => {
    expect(await new ProviderDiagnostic().run({ async *stream() {} }, VISION_DIAGNOSTIC_MESSAGES)).toEqual({ ok: false, code: "empty" });
    expect(await new ProviderDiagnostic().run({ async *stream() { await new Promise(() => {}); } }, VISION_DIAGNOSTIC_MESSAGES, 10)).toEqual({ ok: false, code: "timeout" });
  });
  it("does not retain the slot for non-cooperative iterator cleanup or late rejection", async () => {
    const diagnostic = new ProviderDiagnostic();
    let rejectOld!: (reason: Error) => void;
    const stale = diagnostic.run({ stream: () => ({ [Symbol.asyncIterator]: () => ({
      next: () => new Promise((_resolve, reject) => { rejectOld = reject; }),
      return: () => new Promise(() => {})
    }) }) }, VISION_DIAGNOSTIC_MESSAGES);
    diagnostic.invalidate();
    expect(await stale).toBeUndefined();
    let release!: (result: IteratorResult<string>) => void;
    const fresh = diagnostic.run({ stream: () => ({ [Symbol.asyncIterator]: () => ({
      next: () => new Promise(resolve => { release = resolve; }),
      return: () => new Promise(() => {})
    }) }) }, VISION_DIAGNOSTIC_MESSAGES);
    rejectOld(new Error("late private-body"));
    await Promise.resolve();
    expect(await diagnostic.run({ async *stream() { yield "wrong"; } }, VISION_DIAGNOSTIC_MESSAGES)).toEqual({ ok: false, code: "busy" });
    release({ value: "ok", done: false });
    expect(await fresh).toEqual({ ok: true, code: "received" });
  });

});


describe("diagnostic request lifetime", () => {
  it("returns a terminal safe busy result without starting a competing provider", async () => {
    const diagnostic = new ProviderDiagnostic();
    const pending = diagnostic.run({ async *stream() { await new Promise(() => {}); } }, VISION_DIAGNOSTIC_MESSAGES);
    try {
      const result = await diagnostic.run({ async *stream() { throw new Error("must not start"); } }, VISION_DIAGNOSTIC_MESSAGES);
      expect(result).toEqual({ ok: false, code: "busy" });
    } finally { diagnostic.invalidate(); await pending; }
  });

  it("cancels preparing and streaming work when the requester lifetime ends", async () => {
    const diagnostic = new ProviderDiagnostic();
    const requester = new AbortController();
    let release!: () => void;
    let calls = 0;
    const provider: LLMProvider = { async *stream() { calls++; yield "ok"; } };
    const pending = diagnostic.run(async () => { await new Promise<void>(resolve => { release = resolve; }); return provider; }, VISION_DIAGNOSTIC_MESSAGES, 30, requester.signal);
    requester.abort();
    expect(await pending).toBeUndefined();
    release(); await Promise.resolve();
    expect(calls).toBe(0);
    const freshRequester = new AbortController();
    let transportSignal: AbortSignal | undefined;
    const active = diagnostic.run({ async *stream(_m, _t, options) { transportSignal = options?.signal; await new Promise(() => {}); } }, VISION_DIAGNOSTIC_MESSAGES, 30, freshRequester.signal);
    freshRequester.abort();
    expect(await active).toBeUndefined();
    expect(transportSignal?.aborted).toBe(true);
    expect(await diagnostic.run(provider, VISION_DIAGNOSTIC_MESSAGES)).toEqual({ ok: true, code: "received" });
  });
});


describe("requester cancellation isolation", () => {
  it("ignores an already retired requester and a completed requester's later abort", async () => {
    const diagnostic = new ProviderDiagnostic();
    const retired = new AbortController();
    retired.abort();
    const provider: LLMProvider = { async *stream() { yield "ok"; } };
    expect(await diagnostic.run(provider, VISION_DIAGNOSTIC_MESSAGES, 1000, retired.signal)).toBeUndefined();
    const completed = new AbortController();
    expect(await diagnostic.run(provider, VISION_DIAGNOSTIC_MESSAGES, 1000, completed.signal)).toEqual({ ok: true, code: "received" });
    const current = new AbortController();
    let signal: AbortSignal | undefined;
    const pending = diagnostic.run({ async *stream(_m, _t, options) { signal = options?.signal; await new Promise(() => {}); } }, VISION_DIAGNOSTIC_MESSAGES, 1000, current.signal);
    completed.abort();
    expect(signal?.aborted).toBe(false);
    expect(await diagnostic.run(provider, VISION_DIAGNOSTIC_MESSAGES)).toEqual({ ok: false, code: "busy" });
    current.abort(); expect(await pending).toBeUndefined();
  });
});
