import { settingsT, type SettingsLocale } from "./settings-i18n";
import type { DesktopRendererState } from "./desktop-runtime-bridge";

export function describeVisionTest(test: DesktopRendererState["visionTest"], locale: SettingsLocale): string {
  if (test.status === "testing") return settingsT(locale, "vision.testing");
  if (test.status === "idle" || !test.code) return "";
  return settingsT(locale, `vision.${test.code}`);
}
