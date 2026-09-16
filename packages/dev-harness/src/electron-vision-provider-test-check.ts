import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { _electron as electron, type ElectronApplication, type Page, type Locator } from "playwright";
import { defaultGreyfieldConfig } from "@greyfield/persistence/config-schema";
import type { DesktopIpcEventMap } from "../../../apps/desktop/src/shared/ipc";
import { VISION_DIAGNOSTIC_MESSAGES } from "@greyfield/core-runtime";
import { getElectronExecutablePath } from "./electron-install";
import { resolveLive2DFixturePath } from "./live2d-fixture";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const desktopRoot = join(root, "apps", "desktop");
const artifacts = join(root, ".cache", "vision-provider-test", "latest");
await mkdir(artifacts, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), "greyfield-vision-test-"));
const configPath = join(temp, "config.json");
const key = "local-vision-key";
const privateMarker = "private-body-key-stack-marker";
type Mode = "success" | "401" | "503" | "malformed" | "empty" | "timeout" | "abort";
let mode: Mode = "success";
const requests: Array<{ mode: Mode; model: string; closed: boolean; closedAfterMs?: number }> = [];
const server = createServer(async (req, res) => {
  const parts: Buffer[] = [];
  for await (const part of req) parts.push(Buffer.from(part));
  const body = JSON.parse(Buffer.concat(parts).toString());
  assert.equal(req.url, "/v1/chat/completions");
  assert.equal(req.headers.authorization, `Bearer ${key}`);
  assert.deepEqual(body.messages, VISION_DIAGNOSTIC_MESSAGES);
  assert.equal(body.stream, true);
  const startedAt = performance.now();
  const request: (typeof requests)[number] = { mode, model: body.model as string, closed: false };
  requests.push(request);
  res.on("close", () => { request.closed = true; request.closedAfterMs = Math.round(performance.now() - startedAt); });
  if (mode === "401" || mode === "503") {
    res.writeHead(Number(mode), privateMarker, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: privateMarker })); return;
  }
  if (mode === "timeout" || mode === "abort") return;
  res.writeHead(200, { "content-type": "text/event-stream" });
  if (mode === "malformed") { res.end(`data: {invalid ${privateMarker}}\n\n`); return; }
  if (mode === "empty") { res.end("data: [DONE]\n\n"); return; }
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: privateMarker } }] })}\n\n`);
  // Intentionally keep SSE open: the diagnostic must terminate transport itself.
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address(); assert(address && typeof address !== "string");
const baseUrl = `http://127.0.0.1:${address.port}/v1`;
const initial = structuredClone(defaultGreyfieldConfig);
initial.live2d.modelPath = pathToFileURL(resolveLive2DFixturePath()).href;
initial.ui.locale = "en-US";
initial.provider.taskModels.planner = "preserve-planner";
initial.provider.taskModels.utility = "preserve-utility";
initial.provider.taskModels.memory = "preserve-memory";
await writeFile(configPath, JSON.stringify(initial));
let app: ElectronApplication | undefined;
const output: string[] = [];
const checks: string[] = [];
try {
  app = await electron.launch({ executablePath: await getElectronExecutablePath(desktopRoot), cwd: desktopRoot,
    args: [join(desktopRoot, "dist-main", "index.mjs")], env: { ...process.env,
      GREYFIELD_CONFIG_PATH: configPath, GREYFIELD_USER_DATA_PATH: temp, GREYFIELD_PROJECT_ROOT: root, GREYFIELD_LLM_TIMEOUT_MS: "1500" } });
  app.process().stdout?.on("data", chunk => output.push(String(chunk)));
  app.process().stderr?.on("data", chunk => output.push(String(chunk)));
  const controls = await roleWindow(app, "controls");
  const settings = await roleWindow(app, "settings");
  const pet = await roleWindow(app, "pet");
  const chat = await roleWindow(app, "chat");
  await app.evaluate(({ desktopCapturer }) => {
    const state = globalThis as typeof globalThis & { visionTestCaptureCalls: number };
    state.visionTestCaptureCalls = 0;
    const original = desktopCapturer.getSources.bind(desktopCapturer);
    desktopCapturer.getSources = options => { state.visionTestCaptureCalls++; return original(options); };
  });
  const lifecycleBaseline = await app.evaluate(({ BrowserWindow, ipcMain }) => {
    const sender = BrowserWindow.getAllWindows().find(w => new URL(w.webContents.getURL()).searchParams.get("window") === "settings")!.webContents;
    const state = globalThis as typeof globalThis & { visionRequestIds: string[] };
    state.visionRequestIds = [];
    ipcMain.on("provider:test-vision", (event, payload: { requestId: string }) => {
      if (event.sender === sender) state.visionRequestIds.push(payload.requestId);
    });
    return { id: sender.id, listeners: ["did-start-navigation", "render-process-gone", "destroyed"].map(name => sender.listenerCount(name)) };
  });
  const messagesBefore = await chat.locator(".message-list .message-item").count();
  await controls.getByRole("button", { name: /Open settings|打开设置/i }).click();
  const entry = settings.locator('[data-harness="task-model-shortcut"]');
  await entry.waitFor();
  for (const locator of [entry, settings.getByLabel("Base URL"), settings.getByLabel("API Key"), settings.getByLabel("Chat reply", { exact: true }), settings.getByRole("button", { name: "Test LLM", exact: true })]) await fullyVisible(locator);
  await settings.screenshot({ path: join(artifacts, "settings-fresh-en.png") });
  checks.push("fresh entry and all basic chat fields visible without scrolling");
  await entry.click();
  const button = settings.locator('[data-harness="test-vision"]');
  const result = settings.locator('[data-harness="vision-result"]');
  await button.waitFor();
  await settings.waitForTimeout(400); // ordinary UI smooth disclosure scroll
  await fullyVisible(button);
  await settings.screenshot({ path: join(artifacts, "vision-entry-en.png") });
  await button.click();
  await waitText(result, /Preview mode does not test/);
  assert.equal(requests.length, 0);
  checks.push("fake is not remote success");
  const provider = settings.locator('[data-settings-section="provider"] select').first();
  await provider.selectOption("openai-compatible");
  const vision = settings.locator('[data-task-model-slot="vision"] input');
  const multimodal = settings.locator('[data-task-model-slot="multimodal"] input');
  await settings.getByLabel("Base URL").fill("");
  await settings.getByLabel("API Key").fill("");
  await vision.fill(""); await multimodal.fill("");
  await button.click(); await waitText(result, /Add a Base URL/);
  await settings.getByLabel("Base URL").fill("not-a-url");
  await button.click(); await waitText(result, /HTTP\(S\)/);
  await settings.getByLabel("Base URL").fill(baseUrl);
  await button.click(); await waitText(result, /Add an API key/);
  await settings.getByLabel("API Key").fill(key);
  await button.click(); await waitText(result, /Set Vision or Multimodal/);
  assert.equal(requests.length, 0);
  checks.push("missing and invalid configs blocked without HTTP");
  await vision.fill("vision-only");
  await button.click(); await waitText(result, /not image understanding/);
  assert.equal(requests.at(-1)?.model, "vision-only");
  await until(() => requests.at(-1)?.closed === true);
  await settings.screenshot({ path: join(artifacts, "vision-success-en.png") });
  await multimodal.fill("multimodal-only"); await vision.fill("");
  await button.click(); await waitText(result, /not image understanding/);
  assert.equal(requests.at(-1)?.model, "multimodal-only");
  checks.push("saved config read immediately, vision then multimodal, first-token transport closes");
  for (const [failure, text] of [["401", /401/], ["503", /5xx/], ["malformed", /invalid stream/], ["empty", /No reply token/], ["timeout", /timed out/]] as const) {
    mode = failure; await button.click(); await waitText(result, text);
    assert(await button.isEnabled());
    const visibleText = await settings.locator("body").innerText();
    assert(!visibleText.includes(key) && !visibleText.includes(privateMarker));
    await until(() => requests.at(-1)?.closed === true);
    checks.push(`safe ${failure}; retry enabled`);
  }
  mode = "abort";
  await button.click(); await until(() => requests.at(-1)?.mode === "abort");
  assert(await button.isDisabled());
  const cancelledRequest = requests.at(-1)!;
  await vision.fill("new-vision");
  await until(() => cancelledRequest.closed);
  assert(await button.isEnabled());
  assert.equal(await result.getAttribute("data-status"), "idle");
  mode = "success";
  await button.click(); await waitText(result, /not image understanding/);
  assert.equal(requests.at(-1)?.model, "new-vision");
  checks.push("pending edit cancels transport, invalidates result, restores button and retries new config");
  // Actual document reloads in the same WebContents: once after many requests,
  // then again while the new document's first request is pending.
  for (let reload = 0; reload < 2; reload++) {
    mode = "abort";
    const beforeReload: number = requests.length;
    await button.click();
    await until(() => requests.length === beforeReload + 1);
    const retiredRequest = requests.at(-1)!;
    assert(await button.isDisabled());
    if (reload === 0) {
      // A second real IPC requester must get a terminal busy reply, not silence.
      const busy = await chat.evaluate(() => new Promise<DesktopIpcEventMap["provider:test-vision-result"]>((resolve, reject) => {
        const requestId = crypto.randomUUID();
        const timer = setTimeout(() => { stop(); reject(new Error("Missing competing-request reply")); }, 1000);
        const stop = window.greyfield!.on("provider:test-vision-result", reply => {
          if (reply.requestId !== requestId) return;
          clearTimeout(timer); stop(); resolve(reply);
        });
        window.greyfield!.send("provider:test-vision", { requestId });
      }));
      assert.equal(busy.ok, false); assert.equal(busy.code, "busy");
      assert.equal(requests.length, beforeReload + 1);
      checks.push("competing real IPC requester receives safe terminal busy without HTTP");
      await settings.evaluate(() => { location.hash = "same-document-diagnostic-check"; });
      assert(await button.isDisabled());
      assert.equal(retiredRequest.closed, false, "Same-document navigation must not retire a request");
      checks.push("same-document navigation preserves the pending request");
    }
    await settings.reload();
    await entry.waitFor();
    await fullyVisible(entry);
    await entry.click();
    await button.waitFor();
    await until(() => retiredRequest.closed);
    assert(retiredRequest.closedAfterMs! < 1000, "Reload must cancel transport before the 1500ms timeout");
    assert(await button.isEnabled());
    assert.equal(await result.getAttribute("data-status"), "idle");
    await settings.waitForTimeout(150);
    assert.equal(await result.getAttribute("data-status"), "idle", "Retired result became a stale success");
    const currentId: number = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => new URL(w.webContents.getURL()).searchParams.get("window") === "settings")!.webContents.id);
    assert.equal(currentId, lifecycleBaseline.id, "Must reload the same WebContents");
  }
  await settings.screenshot({ path: join(artifacts, "vision-reload-ready-en.png") });
  mode = "success";
  await button.click(); await waitText(result, /not image understanding/);
  await until(() => requests.at(-1)?.closed === true);
  assert(await button.isEnabled());
  assert.equal(requests.at(-1)?.model, "new-vision");
  await settings.screenshot({ path: join(artifacts, "vision-reload-retry-en.png") });
  const lifecycleAfterReload = await app.evaluate(({ BrowserWindow }) => {
    const sender = BrowserWindow.getAllWindows().find(w => new URL(w.webContents.getURL()).searchParams.get("window") === "settings")!.webContents;
    return { ids: (globalThis as typeof globalThis & { visionRequestIds: string[] }).visionRequestIds,
      listeners: ["did-start-navigation", "render-process-gone", "destroyed"].map(name => sender.listenerCount(name)) };
  });
  assert.equal(new Set(lifecycleAfterReload.ids).size, lifecycleAfterReload.ids.length);
  assert.deepEqual(lifecycleAfterReload.listeners, lifecycleBaseline.listeners);
  checks.push("two pending reloads keep WebContents, close old transport, never reuse IDs or accept stale success, retry succeeds and listeners return to baseline");
  // Use the ordinary advanced language control, not IPC navigation.
  await settings.locator('[data-harness="settings-advanced-toggle"]').click();
  await settings.locator(".settings-language-select select").selectOption("zh-CN");
  await settings.locator('[data-harness="task-model-shortcut"]').click();
  await settings.waitForTimeout(400);
  await waitText(result, /不证明图像理解/);
  await settings.screenshot({ path: join(artifacts, "vision-success-zh.png") });
  await settings.locator('[data-harness="provider-advanced-models"] summary').click();
  await settings.locator('[data-harness="settings-advanced-toggle"]').click();
  await settings.getByRole("button", { name: "开始聊天", exact: true }).click();
  await settings.waitForTimeout(400);
  await fullyVisible(entry);
  await fullyVisible(settings.getByRole("button", { name: "测试 LLM", exact: true }));
  await settings.screenshot({ path: join(artifacts, "settings-fresh-zh.png") });
  await entry.click();
  await settings.waitForTimeout(400);
  const captures = await app.evaluate(() => (globalThis as typeof globalThis & { visionTestCaptureCalls: number }).visionTestCaptureCalls);
  assert.equal(captures, 0);
  checks.push("no desktopCapturer invocation; localized entry stays visible");
  assert.equal(await chat.locator(".message-list .message-item").count(), messagesBefore);
  assert.equal(await controls.locator('[aria-pressed="true"]').count(), 0);
  const saved = JSON.parse(await readFile(configPath, "utf8"));
  for (const slot of ["chat", "planner", "utility", "memory", "voiceAsr", "voiceTts"] as const) assert.equal(saved.provider.taskModels[slot], initial.provider.taskModels[slot]);
  assert.deepEqual(saved.voice, initial.voice);
  assert.deepEqual(saved.memory, initial.memory);
  assert.equal(saved.ui.proactivityLevel, initial.ui.proactivityLevel);
  assert.equal(saved.ui.screenAwarenessRefreshIntervalSeconds, initial.ui.screenAwarenessRefreshIntervalSeconds);
  for (const file of await readdir(temp, { recursive: true })) {
    if (file.endsWith(".jsonl")) assert.equal((await readFile(join(temp, file), "utf8")).trim(), "", `Unexpected session write: ${file}`);
  }
  checks.push("no chat/session pollution; unrelated models, voice, memory and sensing policy preserved");
  await pet.waitForSelector('[data-stage-mode="live2d"] canvas.live2d-stage-canvas', { timeout: 15000 });
  await pet.waitForTimeout(400);
  const pixels = await pet.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(".live2d-host canvas");
    const gl = canvas?.getContext("webgl2") ?? canvas?.getContext("webgl");
    if (!canvas || !gl) return 0;
    const data = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,data);
    let count = 0; for (let i=3;i<data.length;i+=4) if (data[i]>0) count++; return count;
  });
  assert(pixels > 2000, `Empty model pixels: ${pixels}`);
  await pet.screenshot({ path: join(artifacts, "pet.png"), omitBackground: true });
  await controls.screenshot({ path: join(artifacts, "controls.png") });
  const windows = await app.evaluate(({ BrowserWindow, screen }) => ({
    windows: BrowserWindow.getAllWindows().map(w => ({ role: new URL(w.webContents.getURL()).searchParams.get("window"), visible: w.isVisible(), bounds: w.getBounds() })),
    displays: screen.getAllDisplays().map(d => d.bounds)
  }));
  for (const role of ["pet", "controls", "settings"]) {
    const w = windows.windows.find(w => w.role === role); assert(w?.visible);
    assert(windows.displays.some(d => w.bounds.x < d.x+d.width && w.bounds.x+w.bounds.width > d.x && w.bounds.y < d.y+d.height && w.bounds.y+w.bounds.height > d.y));
  }
  assert.equal(windows.windows.find(w => w.role === "chat")?.visible, false);
  // Retiring another real requester also frees admission without closing Settings.
  mode = "abort";
  const beforeDestroy = requests.length;
  await chat.evaluate(() => window.greyfield!.send("provider:test-vision", { requestId: crypto.randomUUID() }));
  await until(() => requests.length === beforeDestroy + 1);
  const destroyedRequest = requests.at(-1)!;
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => new URL(w.webContents.getURL()).searchParams.get("window") === "chat")!.destroy());
  await until(() => destroyedRequest.closed);
  assert(destroyedRequest.closedAfterMs! < 1000, "Destruction must cancel transport before the 1500ms timeout");
  mode = "success";
  await button.click(); await waitText(result, /\u4e0d\u8bc1\u660e\u56fe\u50cf\u7406\u89e3/);
  await until(() => requests.length === beforeDestroy + 2 && requests.at(-1)?.closed === true);
  assert(await button.isEnabled());
  checks.push("destroyed requester closes transport and Settings can retry independently");
  mode = "abort"; await button.click(); await until(() => requests.at(-1)?.mode === "abort");
  const shutdownRequest = requests.at(-1)!;
  await app.close(); app = undefined;
  await until(() => shutdownRequest.closed);
  checks.push("shutdown aborts; visible display bounds and non-fallback Live2D pixels verified");
  const summary = { ok: true, checks, requests, lifecycleBaseline, lifecycleAfterReload, nonTransparentPixels: pixels, ...windows, artifacts };
  await writeFile(join(artifacts, "summary.json"), JSON.stringify(summary,null,2));
  console.log(JSON.stringify(summary,null,2));
} catch (error) {
  await writeFile(join(artifacts, "failure.json"), JSON.stringify({ error: String(error), checks, requests, output: output.join("").slice(-5000) },null,2));
  if (app) for (const p of app.windows()) { const role = new URL(p.url()).searchParams.get("window"); if (role) await p.screenshot({ path: join(artifacts, `failure-${role}.png`), timeout: 1500 }).catch(() => {}); }
  throw error;
} finally {
  await app?.close().catch(() => {});
  server.closeAllConnections(); server.close();
  await rm(temp, { recursive: true, force: true });
}
async function roleWindow(app: ElectronApplication, role: string): Promise<Page> {
  let found: Page | undefined;
  await until(() => { found = app.windows().find(p => new URL(p.url()).searchParams.get("window") === role); return Boolean(found); });
  await found!.waitForLoadState("domcontentloaded"); return found!;
}
async function until(predicate: () => boolean): Promise<void> {
  const end = Date.now()+10000;
  while (!predicate()) { if (Date.now()>end) throw new Error("Timed out waiting for harness condition"); await new Promise(r => setTimeout(r,25)); }
}
async function waitText(locator: Locator, pattern: RegExp): Promise<void> {
  const end = Date.now()+10000;
  while (!pattern.test(await locator.innerText())) { if (Date.now()>end) throw new Error(`Expected ${pattern}, got ${await locator.innerText()}`); await new Promise(r => setTimeout(r,25)); }
}
async function fullyVisible(locator: Locator): Promise<void> {
  assert(await locator.evaluate(el => {
    const r=el.getBoundingClientRect(); const surface=el.closest(".control-surface")?.getBoundingClientRect();
    return r.width>0 && r.height>0 && r.top>=Math.max(0,surface?.top??0) && r.bottom<=Math.min(innerHeight,surface?.bottom??innerHeight);
  }), `Not visible without scrolling: ${await locator.textContent()}`);
}
