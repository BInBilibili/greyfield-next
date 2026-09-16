import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defaultGreyfieldConfig, type GreyfieldConfigPatch } from "@greyfield/persistence/config-schema";
import { loadGreyfieldConfig, saveGreyfieldConfig } from "../../../../../packages/persistence/src/config";
import { SettingsController } from "../settings-controller";

// Keep disk failures deterministic on Windows as well as privileged CI users:
// a file temporarily replaces the parent directory, so the real write must fail.
describe("SettingsController disk commit boundary", () => {
  it("reloads only committed settings after a failed write, unrelated save and explicit retry", async () => {
    const temp = await mkdtemp(join(tmpdir(), "greyfield-settings-save-"));
    const directory = join(temp, "settings");
    const parked = join(temp, "settings-parked");
    const path = join(directory, "config.json");
    const patch: GreyfieldConfigPatch = { provider: { taskModels: { chat: "disk-chat", vision: "disk-vision" } } };
    try {
      await mkdir(directory);
      await saveGreyfieldConfig(path, defaultGreyfieldConfig);
      const initialBytes = await readFile(path, "utf8");
      const emit = vi.fn();
      const controller = new SettingsController(
        await loadGreyfieldConfig(path),
        (config) => saveGreyfieldConfig(path, config),
        emit
      );
      const initial = controller.getCurrent();

      await rename(directory, parked);
      await writeFile(directory, "write blocker", "utf8");
      await expect(controller.update(patch)).rejects.toMatchObject({ code: expect.any(String) });
      await expect(controller.awaitPendingUpdates()).rejects.toMatchObject({ code: expect.any(String) });
      await rm(directory);
      await rename(parked, directory);

      expect(await readFile(path, "utf8")).toBe(initialBytes);
      expect(await loadGreyfieldConfig(path)).toEqual(initial);
      expect(controller.getCurrent()).toEqual(initial);
      expect(emit).not.toHaveBeenCalled();
      const unrelated = await controller.update({ ui: { proactivityLevel: 61 } });
      expect(unrelated.provider).toEqual(initial.provider);
      expect(await loadGreyfieldConfig(path)).toEqual(unrelated);
      await expect(controller.awaitPendingUpdates()).resolves.toBeUndefined();

      const retried = await controller.update(patch);
      await expect(controller.awaitPendingUpdates()).resolves.toBeUndefined();
      expect(retried.provider).toMatchObject({
        model: "disk-chat",
        visionModel: "disk-vision",
        taskModels: { chat: "disk-chat", vision: "disk-vision" }
      });
      expect(retried.ui.proactivityLevel).toBe(61);
      const reloaded = new SettingsController(
        await loadGreyfieldConfig(path),
        (config) => saveGreyfieldConfig(path, config),
        vi.fn()
      );
      expect(reloaded.getCurrent()).toEqual(retried);
      expect(emit.mock.calls.map(([config]) => config)).toEqual([unrelated, retried]);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("does not roll back an actual disk commit when notification throws, and can recover", async () => {
    const temp = await mkdtemp(join(tmpdir(), "greyfield-settings-notify-"));
    const path = join(temp, "config.json");
    try {
      await saveGreyfieldConfig(path, defaultGreyfieldConfig);
      const emit = vi.fn().mockImplementationOnce(() => {
        throw new Error("notification failed");
      });
      const controller = new SettingsController(
        await loadGreyfieldConfig(path),
        (config) => saveGreyfieldConfig(path, config),
        emit
      );
      await expect(controller.update({ provider: { taskModels: { vision: "saved-vision" } } })).rejects.toThrow("notification failed");
      const saved = await loadGreyfieldConfig(path);
      expect(saved.provider.visionModel).toBe("saved-vision");
      expect(controller.getCurrent()).toEqual(saved);
      await expect(controller.awaitPendingUpdates()).rejects.toThrow("notification failed");
      const next = await controller.update({ ui: { proactivityLevel: 42 } });
      expect(next.provider).toEqual(saved.provider);
      expect(await loadGreyfieldConfig(path)).toEqual(next);
      await expect(controller.awaitPendingUpdates()).resolves.toBeUndefined();
      expect(emit).toHaveBeenLastCalledWith(next);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});
