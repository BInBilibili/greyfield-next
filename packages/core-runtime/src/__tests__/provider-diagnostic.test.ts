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
    expect(await diagnostic.run(hanging, VISION_DIAGNOSTIC_MESSAGES)).toBeUndefined();
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
    expect(await diagnostic.run({ async *stream() { yield "wrong"; } }, VISION_DIAGNOSTIC_MESSAGES)).toBeUndefined();
    release({ value: "ok", done: false });
    expect(await fresh).toEqual({ ok: true, code: "received" });
  });

});
