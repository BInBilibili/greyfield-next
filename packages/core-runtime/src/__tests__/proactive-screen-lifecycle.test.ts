import { describe, expect, it } from "vitest";
import type { LLMProvider } from "../providers";
import { ProactiveScreenLifecycle } from "../proactive-screen-lifecycle";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function stalled() {
  const next = deferred<IteratorResult<string>>();
  const cleanup = deferred<IteratorResult<string>>();
  let signal: AbortSignal | undefined;
  const provider: LLMProvider = { stream(_messages, _tools, options) {
    signal = options?.signal;
    return { [Symbol.asyncIterator]: () => ({ next: () => next.promise, return: () => cleanup.promise }) };
  } };
  return { next, cleanup, provider, get signal() { return signal; } };
}

describe("ProactiveScreenLifecycle", () => {
  it("releases a non-cooperative next/return without waiting, aborting its signal", async () => {
    const owner = new ProactiveScreenLifecycle();
    const old = stalled();
    const result = owner.run(old.provider, []);
    owner.cancel();
    expect(old.signal?.aborted).toBe(true);
    await expect(result).resolves.toBeUndefined();
    expect(owner.inFlight).toBe(false);
    old.next.reject(new Error("late failure"));
    old.cleanup.reject(new Error("late cleanup failure"));
    await Promise.resolve();
  });

  it("old finally cannot clear a replacement, and late chunks cannot publish", async () => {
    const owner = new ProactiveScreenLifecycle();
    const old = stalled();
    const replacement = stalled();
    const first = owner.run(old.provider, []);
    owner.cancel();
    const second = owner.run(replacement.provider, []);
    await first;
    expect(owner.inFlight).toBe(true);
    old.next.resolve({ done: false, value: "stale" });
    expect(owner.inFlight).toBe(true);
    owner.cancel();
    await expect(second).resolves.toBeUndefined();
  });

  it("invalidates completed results before publication and stays disposed", async () => {
    const owner = new ProactiveScreenLifecycle();
    const provider: LLMProvider = { async *stream() { yield "fresh"; } };
    const result = await owner.run(provider, []);
    expect(result?.text).toBe("fresh");
    expect(owner.canPublish(result!)).toBe(true);
    owner.cancel();
    expect(owner.canPublish(result!)).toBe(false);
    const fresh = await owner.run(provider, []);
    expect(owner.canPublish(fresh!)).toBe(true);
    owner.dispose();
    expect(owner.canPublish(fresh!)).toBe(false);
    await expect(owner.run(provider, [])).resolves.toBeUndefined();
  });
  it("disposal cancels in flight and prevents later starts", async () => {
    const owner = new ProactiveScreenLifecycle();
    const fixture = stalled();
    const result = owner.run(fixture.provider, []);
    owner.dispose();
    expect(fixture.signal?.aborted).toBe(true);
    await expect(result).resolves.toBeUndefined();
    await expect(owner.run(fixture.provider, [])).resolves.toBeUndefined();
  });

  it("caps successful output and aborts the transport without awaiting cleanup", async () => {
    const owner = new ProactiveScreenLifecycle();
    let signal: AbortSignal | undefined;
    const result = await owner.run({ async *stream(_messages, _tools, options) {
      signal = options?.signal;
      yield "x".repeat(241);
      await new Promise(() => {});
    } }, []);
    expect(result?.text).toHaveLength(241);
    expect(signal?.aborted).toBe(true);
    expect(owner.inFlight).toBe(false);
    expect(owner.canPublish(result!)).toBe(true);
  });

  it("provider failure releases the slot for a later run", async () => {
    const owner = new ProactiveScreenLifecycle();
    await expect(owner.run({ async *stream() { throw new Error("provider failure"); } }, []))
      .rejects.toThrow("provider failure");
    expect(owner.inFlight).toBe(false);
    await expect(owner.run({ async *stream() { yield "retry"; } }, []))
      .resolves.toMatchObject({ text: "retry" });
  });

});

describe("proactive screen input reservation", () => {
  it("cancels pending Vision and keeps nested/overlapping holds independent and idempotent", async () => {
    const lifecycle = new ProactiveScreenLifecycle();
    const old = stalled();
    const result = lifecycle.run(old.provider, []);
    const releaseFirst = lifecycle.suspendForInput();
    const releaseSecond = lifecycle.suspendForInput();
    expect(old.signal?.aborted).toBe(true);
    await expect(result).resolves.toBeUndefined();
    releaseFirst();
    releaseFirst();
    lifecycle.cancel(); // Config/off must not release input priority.
    expect(lifecycle.inputPending).toBe(true);
    const fresh: LLMProvider = { async *stream() { yield "fresh"; } };
    await expect(lifecycle.run(fresh, [])).resolves.toBeUndefined();
    releaseSecond();
    const freshResult = await lifecycle.run(fresh, []);
    expect(freshResult?.text).toBe("fresh");
    expect(lifecycle.canPublish(freshResult!)).toBe(true);
    const releaseThird = lifecycle.suspendForInput();
    expect(lifecycle.canPublish(freshResult!)).toBe(false);
    releaseThird();
    old.next.resolve({ done: true, value: undefined });
    old.cleanup.resolve({ done: true, value: undefined });
  });
});
