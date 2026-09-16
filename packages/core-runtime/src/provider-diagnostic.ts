import type { ChatMessage, LLMProvider } from "./providers";

export type ProviderDiagnosticCode = "received" | "preview" | "base-url" | "api-key" | "model" | "invalid-url" | "unauthorized" | "forbidden" | "not-found" | "unavailable" | "timeout" | "stream" | "empty" | "network" | "save";
export interface ProviderDiagnosticResult { ok: boolean; code: ProviderDiagnosticCode }

// A deterministic blue square, not a screenshot or user attachment. Never enters a runtime turn.
export const VISION_DIAGNOSTIC_MESSAGES: ChatMessage[] = [
  { role: "system", content: "Connectivity diagnostic only. Reply briefly to the supplied sample image." },
  { role: "user", content: [
    { type: "text", text: "Describe this built-in sample briefly." },
    { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGOQy7tDEmIY1TCqYfhqAAClSmgQNRzqsQAAAABJRU5ErkJggg==" } }
  ] }
];

/** Owns diagnostic deduplication, cancellation and stale-result suppression, independently of chat/audio. */
export class ProviderDiagnostic {
  private active?: AbortController;
  private preparing?: AbortController;

  /** A persisted config commit cancels a running request, not a click waiting for that same save. */
  invalidateRunning(): void {
    if (this.active && this.preparing !== this.active) this.invalidate();
  }

  invalidate(): void {
    const previous = this.active;
    this.active = undefined;
    this.preparing = undefined;
    previous?.abort();
  }

  async run(provider: LLMProvider | (() => Promise<LLMProvider | ProviderDiagnosticResult>), messages: ChatMessage[], timeoutMs = 30_000): Promise<ProviderDiagnosticResult | undefined> {
    if (this.active) return undefined;
    const controller = new AbortController();
    this.active = controller;
    if (typeof provider === "function") this.preparing = controller;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); },
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30_000);
    let received = false;
    const cancelled = new Promise<ProviderDiagnosticResult>(resolve => {
      controller.signal.addEventListener("abort", () => resolve({ ok: false, code: "timeout" }), { once: true });
    });
    const probe = async (): Promise<ProviderDiagnosticResult> => {
      try {
        const resolved = typeof provider === "function" ? await provider() : provider;
        if (this.preparing === controller) this.preparing = undefined;
        if (controller.signal.aborted || this.active !== controller) return { ok: false, code: "empty" };
        if (!("stream" in resolved)) return resolved;
        for await (const token of resolved.stream(messages, undefined, { signal: controller.signal })) {
          if (token.trim()) {
            // Abort before iterator.return(): transports must not keep generating after a valid token.
            received = true;
            controller.abort();
            return { ok: true, code: "received" };
          }
        }
        return { ok: false, code: "empty" };
      } catch (error) {
        return { ok: false, code: classifyDiagnosticError(error) };
      }
    };
    // The abort race also bounds a misbehaving provider that ignores its signal.
    try {
      const result = await Promise.race([probe(), cancelled.then(result => received ? { ok: true, code: "received" } as const : result)]);
      return this.active === controller ? (timedOut ? { ok: false, code: "timeout" } : result) : undefined;
    } finally {
      clearTimeout(timeout);
      if (this.active === controller) this.active = undefined;
      if (this.preparing === controller) this.preparing = undefined;
      controller.abort();
    }
  }
}

function classifyDiagnosticError(error: unknown): ProviderDiagnosticCode {
  const message = error instanceof Error ? error.message : "";
  if (/request failed:\s*401\b/u.test(message)) return "unauthorized";
  if (/request failed:\s*403\b/u.test(message)) return "forbidden";
  if (/request failed:\s*404\b/u.test(message)) return "not-found";
  if (/request failed:\s*5\d\d\b/u.test(message)) return "unavailable";
  if (message.includes("timed out")) return "timeout";
  if (message.includes("malformed SSE")) return "stream";
  return "network";
}
