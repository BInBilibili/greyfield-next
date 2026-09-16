<template>
  <div
    id="settings-section-provider"
    :ref="sectionRef"
    class="settings-section"
    :aria-label="ariaLabel"
    data-settings-section="provider"
    tabindex="-1"
  >
    <header class="settings-section__header">
      <h2>{{ t("section.provider") }}</h2>
      <button type="button" class="task-model-shortcut" data-harness="task-model-shortcut" @click="openTaskModels">{{ t("vision.entry") }}</button>
    </header>
    <div class="settings-fields settings-fields--provider-first" data-harness="provider-first-fields">
      <label>
        <span>{{ t("field.provider") }}</span>
        <select
          :value="state.settings.providerLLM"
          autocomplete="off"
          @change="emit('update-setting', 'providerLLM', valueFrom($event))"
        >
          <option value="fake">{{ t("provider.fakePreview") }}</option>
          <option value="openai-compatible">{{ t("provider.openaiCompatible") }}</option>
        </select>
      </label>
      <label>
        <span>{{ t("field.baseUrl") }}</span>
        <input
          :value="state.settings.providerBaseUrl"
          autocomplete="off"
          spellcheck="false"
          @input="emit('update-setting', 'providerBaseUrl', valueFrom($event))"
        />
      </label>
      <label>
        <span>{{ t("field.apiKey") }}</span>
        <input
          :value="state.settings.providerApiKey"
          autocomplete="off"
          spellcheck="false"
          :placeholder="state.settings.providerHasApiKey ? t('provider.savedApiKey') : ''"
          type="password"
          @input="emit('update-setting', 'providerApiKey', valueFrom($event))"
        />
      </label>
      <label>
        <span>{{ t("taskModel.chat.label") }}</span>
        <input
          :aria-label="t('taskModel.chat.label')"
          :value="state.settings.providerModel"
          autocomplete="off"
          spellcheck="false"
          @input="emit('update-setting', 'providerModel', valueFrom($event))"
        />
      </label>
    </div>
    <div class="provider-status" :class="`provider-status--${providerStatus.tone}`" role="status">
      <strong>{{ providerStatus.label }}</strong>
      <span>{{ providerStatus.detail }}</span>
    </div>
    <div class="settings-actions settings-actions--single">
      <button
        type="button"
        class="test-llm-button"
        :class="`test-llm-button--${testLlmAction.tone}`"
        :disabled="testLlmAction.disabled"
        @click="startTestLlm"
      >
        {{ testLlmAction.label }}
      </button>
    </div>
    <p
      v-if="testLlmAction.disableReason"
      class="provider-test-result provider-test-result--error"
      role="status"
    >
      {{ testLlmAction.disableReason }}
    </p>
    <p
      v-else-if="providerTestStatus"
      class="provider-test-result"
      :class="`provider-test-result--${providerTestStatus.tone}`"
      role="status"
    >
      <strong>{{ providerTestStatus.label }}</strong>
      <span>{{ providerTestStatus.detail }}</span>
    </p>
    <details ref="taskModelsDetails" class="provider-advanced" data-harness="provider-advanced-models">
      <summary>{{ t("advanced.taskModels") }}</summary>
      <section class="vision-diagnostic" data-harness="vision-diagnostic">
        <p>{{ t("vision.detail") }}</p>
        <label v-for="slot in visionTaskModelSlots" :key="slot.key" class="task-model-slot" :data-task-model-slot="slot.slot">
          <span>{{ slot.label }}</span>
          <input :aria-label="slot.label" :value="slot.value" autocomplete="off" spellcheck="false"
            @input="emit('update-setting', slot.key, valueFrom($event))" />
          <small>{{ slot.detail }}</small>
        </label>
        <button type="button" data-harness="test-vision" :disabled="state.visionTest.status === 'testing'" @click="emit('test-vision')">
          {{ t(state.visionTest.status === "testing" ? "vision.testing" : "vision.test") }}
        </button>
        <p role="status" data-harness="vision-result" :data-status="state.visionTest.status">{{ visionResult }}</p>
      </section>
      <div class="task-model-slots" :aria-label="t('field.taskModelSlots')">
        <header class="task-model-slots__header">
          <strong>{{ t("field.taskModelSlots") }}</strong>
          <span>{{ t("field.taskModelSlots.detail") }}</span>
        </header>
        <label
          v-for="slot in otherTaskModelSlots"
          :key="slot.key"
          class="task-model-slot"
          :data-task-model-slot="slot.slot"
        >
          <span>{{ slot.label }}</span>
          <input
            :aria-label="slot.label"
            :value="slot.value"
            autocomplete="off"
            spellcheck="false"
            @input="emit('update-setting', slot.key, valueFrom($event))"
          />
          <small>{{ slot.detail }}</small>
        </label>
      </div>
    </details>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { DesktopRendererState, DesktopSettingsState } from "./desktop-runtime-bridge";
import { valueFrom } from "./settings-dom-events";
import { settingsT, type SettingsI18nKey, type SettingsLocale } from "./settings-i18n";
import { describeProviderStatus } from "./settings-provider-status";
import { describeVisionTest } from "./settings-test-vision";
import { describeProviderTestStatus, describeTestLlmAction } from "./settings-test-llm";

const props = defineProps<{
  state: DesktopRendererState;
  stageStatus: "idle" | "listening" | "thinking" | "speaking" | "interrupted" | "error";
  locale: SettingsLocale;
  ariaLabel: string;
  sectionRef: (element: Element | null) => void;
}>();

const emit = defineEmits<{
  "update-setting": [key: keyof DesktopSettingsState, value: string];
  "test-llm": [];
  "test-vision": [];
}>();

const t = (key: SettingsI18nKey, values?: Record<string, string | number>): string =>
  settingsT(props.locale, key, values);
const pendingProviderTestBaseline = ref<string | null>(null);
const providerStatus = computed(() => describeProviderStatus(props.state, props.locale));
const advancedTaskModelSlots = computed<
  Array<{
    slot: string;
    key: keyof DesktopSettingsState;
    label: string;
    detail: string;
    value: string;
  }>
>(() => [
  {
    slot: "planner",
    key: "providerPlannerModel",
    label: t("taskModel.planner.label"),
    detail: t("taskModel.planner.detail"),
    value: props.state.settings.providerPlannerModel
  },
  {
    slot: "utility",
    key: "providerUtilityModel",
    label: t("taskModel.utility.label"),
    detail: t("taskModel.utility.detail"),
    value: props.state.settings.providerUtilityModel
  },
  {
    slot: "memory",
    key: "providerMemoryModel",
    label: t("taskModel.memory.label"),
    detail: t("taskModel.memory.detail"),
    value: props.state.settings.providerMemoryModel
  },
  {
    slot: "vision",
    key: "providerVisionModel",
    label: t("taskModel.vision.label"),
    detail: t("taskModel.vision.detail"),
    value: props.state.settings.providerVisionModel
  },
  {
    slot: "multimodal",
    key: "providerMultimodalModel",
    label: t("taskModel.multimodal.label"),
    detail: t("taskModel.multimodal.detail"),
    value: props.state.settings.providerMultimodalModel
  },
  {
    slot: "voiceAsr",
    key: "providerASRModel",
    label: t("taskModel.voiceAsr.label"),
    detail: t("taskModel.voiceAsr.detail"),
    value: props.state.settings.providerASRModel
  },
  {
    slot: "voiceTts",
    key: "providerTTSModel",
    label: t("taskModel.voiceTts.label"),
    detail: t("taskModel.voiceTts.detail"),
    value: props.state.settings.providerTTSModel
  }
]);
const visionTaskModelSlots = computed(() => advancedTaskModelSlots.value.filter(slot => ["vision", "multimodal"].includes(slot.slot)));
const otherTaskModelSlots = computed(() => advancedTaskModelSlots.value.filter(slot => !["vision", "multimodal"].includes(slot.slot)));
const visionResult = computed(() => describeVisionTest(props.state.visionTest, props.locale));
const taskModelsDetails = ref<HTMLDetailsElement | null>(null);
function openTaskModels(): void {
  if (!taskModelsDetails.value) return;
  taskModelsDetails.value.open = true;
  taskModelsDetails.value.scrollIntoView({ block: "start", behavior: "smooth" });
}
const testLlmAction = computed(() =>
  describeTestLlmAction(
    props.stageStatus,
    displayedProviderTest.value.status,
    providerStatus.value.tone === "blocked" ? providerStatus.value.detail : "",
    props.locale
  )
);
const providerTestSignature = computed(() =>
  `${props.state.providerTest.status}:${props.state.providerTest.message}:${props.state.providerTest.firstToken ?? ""}`
);
const displayedProviderTest = computed<DesktopRendererState["providerTest"]>(() =>
  pendingProviderTestBaseline.value && providerTestSignature.value === pendingProviderTestBaseline.value
    ? { status: "testing", message: "Testing LLM provider..." }
    : props.state.providerTest
);
const providerTestStatus = computed(() => describeProviderTestStatus(displayedProviderTest.value, props.locale));

watch(providerTestSignature, (signature) => {
  if (pendingProviderTestBaseline.value && signature !== pendingProviderTestBaseline.value) {
    pendingProviderTestBaseline.value = null;
  }
});

function startTestLlm(): void {
  pendingProviderTestBaseline.value = providerTestSignature.value;
  emit("test-llm");
}
</script>
