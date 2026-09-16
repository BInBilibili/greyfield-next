import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultGreyfieldConfig as base } from "@greyfield/persistence/config-schema";
import { resolveLive2DFixturePath } from "./live2d-fixture";
import { getElectronExecutablePath } from "./electron-install";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const desktop = join(root, "apps", "desktop");
const artifacts = join(root, ".cache", "greyfield-screen-cancel", new Date().toISOString().replace(/[:.]/g, "-"));
const userData = await mkdtemp(join(tmpdir(), "greyfield-screen-cancel-"));
await mkdir(artifacts, { recursive: true });
const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA0lW1TAAAAHklEQVR42mP8z8AARLJgwoIFDBgYGBj+M8B8AAAp+gIGKq+qVwAAAABJRU5ErkJggg==";
const requests: Array<{ proactive: boolean; closedBeforeEnd: boolean; ended: boolean; response: ServerResponse }> = [];
let completeNextProactive = false;
const bubbles: string[] = [];
const summary: Record<string, unknown> = { ok: false, artifacts, userData };
const server = createServer(async (request, response) => {
  let body = "";
  for await (const part of request) body += String(part);
  const payload = JSON.parse(body);
  const proactive = String(payload.messages[0]?.content).includes("the user has not spoken first");
  const record = { proactive, closedBeforeEnd: false, ended: false, response };
  requests.push(record);
  response.on("close", () => { record.closedBeforeEnd = !record.ended; });
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (text: string) => response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  if (proactive && !completeNextProactive) {
    send("STALE_PROACTIVE_MUST_NOT_APPEAR");
    return; // Only the client may close this unfinished response.
  }
  if (proactive) { completeNextProactive = false; send("FRESH_SCREEN_REMARK"); }
  else send(payload.model === "local-vision" ? "A temporary local screen fixture." : "LOCAL_CHAT_PRESERVED");
  record.ended = true;
  response.end("data: [DONE]\n\n");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const configPath = join(userData, "greyfield.config.json");
await writeFile(configPath, JSON.stringify({ ...base,
  memory: { ...base.memory, useV2System: false },
  provider: { ...base.provider, llm: "openai-compatible", apiKey: "local-fixture", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, visionModel: "local-vision", taskModels: { ...base.provider.taskModels, chat: "local-chat" } },
  voice: { ...base.voice, speechEnabled: false },
  live2d: { ...base.live2d, modelPath: pathToFileURL(resolveLive2DFixturePath()).href },
  ui: { ...base.ui, settingsLocale: "en-US", proactiveMemoryEnabled: true, proactivityLevel: 100 }
}));
let app: ElectronApplication | undefined;
let controls: Page | undefined;
let pet: Page | undefined;
try {
  app = await electron.launch({ executablePath: await getElectronExecutablePath(desktop), cwd: desktop,
    args: [join(desktop, "dist-main", "index.mjs")], env: { ...process.env,
      GREYFIELD_CONFIG_PATH: configPath, GREYFIELD_PROJECT_ROOT: root, GREYFIELD_USER_DATA_PATH: userData,
      GREYFIELD_FAKE_SCREENSHOT_DATA_URL: image, GREYFIELD_SCREEN_AWARENESS_TICK_MS: "1000", GREYFIELD_FAKE_SCREENSHOT_CHANGE_EACH_CAPTURE: "1",
      GREYFIELD_LLM_TIMEOUT_MS: "90000"
    } });
  controls = await role(app, "controls", ".desktop-control-panel");
  pet = await role(app, "pet", ".pet-shell");
  const chat = await role(app, "chat", ".chat-shell");
  await pet.exposeFunction("recordProactiveBubble", (text: string) => { bubbles.push(text); });
  await pet.evaluate(() => window.greyfield?.on("proactive:message", (message) => {
    void (window as unknown as { recordProactiveBubble(text: string): Promise<void> }).recordProactiveBubble(message.text);
  }));
  await pet.waitForFunction(() => {
    if (!document.querySelector('[data-stage-mode="live2d"]')) return false;
    const canvas = document.querySelector<HTMLCanvasElement>("canvas.live2d-stage-canvas");
    const gl = canvas?.getContext("webgl2") ?? canvas?.getContext("webgl");
    if (!canvas || !gl) return false;
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return pixels.some((value, index) => index % 4 === 3 && value > 0);
  }, null, { timeout: 30_000 });
  summary.nonFallbackModelPixels = true;
  summary.windows = await app.evaluate(({ BrowserWindow, screen }) => ({
    displays: screen.getAllDisplays().map((display) => display.workArea),
    windows: BrowserWindow.getAllWindows().map((window) => ({ url: window.webContents.getURL(), bounds: window.getBounds(), visible: window.isVisible() }))
  }));
  await controls.screenshot({ path: join(artifacts, "controls-default.png") });
  await pet.screenshot({ path: join(artifacts, "pet-model.png") });
  const on = () => controls!.getByRole("button", { name: /^(Turn Screen awareness on|开启屏幕感知)$/ });
  const off = () => controls!.getByRole("button", { name: /^(Turn Screen awareness off|关闭屏幕感知)$/ });
  const stop = controls.locator(".desktop-control-button--stop");
  // No scrollIntoView, IPC injection, or developer shortcuts for controls actions.
  await on().click();
  await wait(() => requests.filter((r) => r.proactive).length === 1, "first proactive request");
  await controls.screenshot({ path: join(artifacts, "controls-vision-inflight.png") });
  await off().click();
  await wait(() => requests[0].closedBeforeEnd, "Controls off must close HTTP SSE");
  await assertNoStaleBubble();
  summary.controlsOffAbortedHttp = true;
  await controls.screenshot({ path: join(artifacts, "controls-off.png") });

  completeNextProactive = true;
  await on().click();
  await wait(() => bubbles.includes("FRESH_SCREEN_REMARK"), "fresh re-enable publication");
  await pet.locator(".speech-bubble", { hasText: "FRESH_SCREEN_REMARK" }).waitFor({ timeout: 10_000 });
  await pet.screenshot({ path: join(artifacts, "pet-fresh-reenable.png") });
  summary.freshReenable = true;
  await off().click();

  await on().click();
  await wait(() => requests.filter((r) => r.proactive).length === 3, "proactive request before new text");
  const textRequest = requests.filter((r) => r.proactive)[2];
  await controls.locator(".desktop-control-input").fill("Please describe this screen.");
  await controls.locator(".desktop-control-input").press("Enter");
  await wait(() => textRequest.closedBeforeEnd, "new ordinary Controls text must abort proactive HTTP");
  await chat.locator(".message-item.assistant", { hasText: "LOCAL_CHAT_PRESERVED" }).waitFor({ timeout: 15_000 });
  summary.userVisionAndChatPreserved = true;
  await assertNoStaleBubble();
  await off().click();

  await on().click();
  await wait(() => requests.filter((r) => r.proactive).length === 4, "proactive request before Stop");
  const stopRequest = requests.filter((r) => r.proactive)[3];
  if (!(await stop.isEnabled())) throw new Error("Ordinary Controls Stop is disabled during proactive Vision");
  await stop.click();
  await wait(() => stopRequest.closedBeforeEnd, "Controls Stop must close HTTP SSE");
  await assertNoStaleBubble();
  await controls.screenshot({ path: join(artifacts, "controls-stopped.png") });
  await pet.screenshot({ path: join(artifacts, "pet-after-stop.png") });
  summary.controlsStopAbortedHttp = true;
  await off().click();
  await controls.locator(".desktop-control-input").fill("Normal chat with screen off.");
  await controls.locator(".desktop-control-input").press("Enter");
  await wait(async () => (await chat.locator(".message-item.assistant", { hasText: "LOCAL_CHAT_PRESERVED" }).count()) === 2, "ordinary chat after Stop");
  summary.normalChatAfterStop = true;
  // Inspect all persisted app-owned text stores, not just a mock SessionStore.
  const persisted = await readStores(userData);
  if (!persisted.includes("Normal chat with screen off.")) throw new Error("Session persistence not observed");
  for (const marker of ["data:image", "greyfield-fake-screen-frame", image.split(",")[1], "STALE_PROACTIVE_MUST_NOT_APPEAR", "FRESH_SCREEN_REMARK"]) {
    if (persisted.includes(marker)) throw new Error(`Private/proactive content persisted: ${marker.slice(0, 40)}`);
  }
  summary.rawImageNotPersisted = true;
  summary.ok = true;
} catch (error) {
  summary.error = String(error);
  await controls?.screenshot({ path: join(artifacts, "failure-controls.png") }).catch(() => {});
  await pet?.screenshot({ path: join(artifacts, "failure-pet.png") }).catch(() => {});
  process.exitCode = 1;
} finally {
  summary.requests = requests.map(({ response: _response, ...record }) => record);
  summary.bubbles = bubbles;
  await writeFile(join(artifacts, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  await app?.close().catch(() => {});
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function role(app: ElectronApplication, name: string, selector: string): Promise<Page> {
  let found: Page | undefined;
  await wait(() => { found = app.windows().find((page) => page.url().includes(`window=${name}`)); return !!found; }, `${name} window`);
  await found!.waitForSelector(selector);
  return found!;
}
async function wait(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${label}`);
}
async function assertNoStaleBubble(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (bubbles.some((text) => text.includes("STALE_PROACTIVE"))) throw new Error("Stale proactive bubble published");
}
async function readStores(directory: string): Promise<string> {
  let text = "";
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ["sessions", "memory", "characters"].includes(entry.name)) text += await readStores(join(directory, entry.name));
    else if (entry.isFile() && /\.(jsonl|json|md)$/u.test(entry.name)) text += await readFile(join(directory, entry.name), "utf8");
  }
  return text;
}
