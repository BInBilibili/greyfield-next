import type { ChatMessage, LLMProvider } from "./providers";

export interface ProactiveScreenResult {
  text: string;
  generation: number;
}

/** Owns only the ephemeral proactive Vision run, never session/image storage. */
export class ProactiveScreenLifecycle {
  private generation = 0;
  private active: AbortController | undefined;
  private disposed = false;

  get inFlight(): boolean { return this.active !== undefined; }

  cancel(): void {
    this.generation += 1;
    const previous = this.active;
    this.active = undefined;
    previous?.abort();
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }

  canPublish(result: ProactiveScreenResult): boolean {
    return !this.disposed && result.generation === this.generation;
  }

  async run(provider: LLMProvider, messages: ChatMessage[]): Promise<ProactiveScreenResult | undefined> {
    if (this.disposed || this.active) return undefined;
    const controller = new AbortController();
    const generation = ++this.generation;
    this.active = controller;
    let iterator: AsyncIterator<string> | undefined;
    let onAbort!: () => void;
    const aborted = new Promise<undefined>((resolve) => {
      onAbort = () => resolve(undefined);
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      iterator = provider.stream(messages, undefined, { signal: controller.signal })[Symbol.asyncIterator]();
      let text = "";
      while (!controller.signal.aborted) {
        // Neither next() nor return() is required to cooperate with cancellation.
        const next = await Promise.race([iterator.next(), aborted]);
        if (!next || controller.signal.aborted || generation !== this.generation) return undefined;
        if (next.done) break;
        text += next.value;
        if (text.length > 240) break;
      }
      if (controller.signal.aborted || generation !== this.generation) return undefined;
      return { text: text.replace(/\s+/g, " ").trim(), generation };
    } finally {
      controller.signal.removeEventListener("abort", onAbort);
      controller.abort(); // Also close a capped or failed transport.
      if (this.active === controller) this.active = undefined;
      // Observe late cleanup rejection without retaining the active slot.
      try { void Promise.resolve(iterator?.return?.()).catch(() => {}); } catch { /* best-effort cleanup */ }
    }
  }
}
