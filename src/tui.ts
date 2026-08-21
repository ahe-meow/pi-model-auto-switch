import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type {
	FailoverConfig,
	ModelParameterName,
	ModelRef,
	AutomationMode,
	ErrorHandlingMode,
	ReasoningEffort,
	Transition,
} from "./types.ts";
import { resolveReasoningEffort } from "./config.ts";
import {
	ERROR_HANDLING_MODES,
	modelKey,
	MODEL_PARAMETER_NAMES,
	REASONING_EFFORTS,
} from "./types.ts";

export interface FailoverTuiView {
	config: FailoverConfig;
	models: readonly ModelRef[];
	available: readonly ModelRef[];
	current?: ModelRef;
	mode: AutomationMode;
	cooldowns: ReadonlyMap<string, number>;
	manualRecovery: ReadonlyMap<string, string>;
	latestTransition?: Transition;
	exhaustionSummary?: string;
}

export interface FailoverTuiActions {
	onClose: () => void;
	onError: (error: unknown) => void;
	onAdd: (model: ModelRef) => Promise<void>;
	onRemove: (index: number) => Promise<void>;
	onMove: (index: number, direction: -1 | 1) => Promise<void>;
	onSelect: (model: ModelRef) => Promise<void>;
	onToggleEnabled: () => Promise<void>;
	onSetCooldownMinutes: (value: string) => Promise<void>;
	onSetErrorHandlingMode: (mode: ErrorHandlingMode) => Promise<void>;
	onSetMaxRetries: (value: string) => Promise<void>;
	onSetTimeout: (value: string) => Promise<void>;
	onSetReasoningEffort: (effort: ReasoningEffort) => Promise<void>;
	onSetModelReasoningEffort: (
		model: ModelRef,
		effort: ReasoningEffort | undefined,
	) => Promise<void>;
	onSetModelParameter: (
		model: ModelRef,
		parameter: ModelParameterName,
		enabled: boolean,
	) => Promise<void>;
	onRestore: () => Promise<void>;
}

function runTuiAction(
	action: () => Promise<void>,
	onError: (error: unknown) => void,
): Promise<void> {
	return Promise.resolve().then(action).catch(onError);
}

function padRight(text: string, width: number): string {
	if (visibleWidth(text) >= width) return truncateToWidth(text, width, "");
	return text + " ".repeat(width - visibleWidth(text));
}

type SettingKey =
	| "cooldownMinutes"
	| "errorHandlingMode"
	| "maxRetries"
	| "noProgressTimeoutSeconds"
	| "modelParameters";

const SETTING_KEYS: readonly SettingKey[] = [
	"cooldownMinutes",
	"errorHandlingMode",
	"maxRetries",
	"noProgressTimeoutSeconds",
	"modelParameters",
];

const SETTING_LABELS: Record<SettingKey, string> = {
	cooldownMinutes: "Cooldown",
	errorHandlingMode: "Error behavior",
	maxRetries: "Max retries",
	noProgressTimeoutSeconds: "No-result timeout",
	modelParameters: "Model parameters",
};

const PARAMETER_LABELS: Record<ModelParameterName, string> = {
	promptCacheKey: "prompt_cache_key",
	promptCacheRetention: "prompt_cache_retention",
	reasoningEffort: "reasoning effort",
	sessionAffinity: "session headers",
};

const ERROR_HANDLING_LABELS: Record<ErrorHandlingMode, string> = {
	smart: "smart",
	switch: "switch immediately",
	retry: "retry then switch",
};

const MAX_VISIBLE_MODELS = 20;
const MODEL_REASONING_CHOICES: readonly (ReasoningEffort | undefined)[] = [
	undefined,
	...REASONING_EFFORTS,
];

export class FailoverEditor implements Component {
	private selectedIndex = 0;
	private scrollOffset = 0;
	private reasoningSelectionIndex: number | undefined;
	private addCandidates: readonly ModelRef[] | undefined;
	private addSelectionIndex: number | undefined;
	private settingsMode = false;
	private settingsSelectionIndex = 0;
	private settingsInput: { key: SettingKey; value: string } | undefined;
	private behaviorSelectionIndex: number | undefined;
	private paramsMode = false;
	private paramsModelIndex = 0;
	private paramsSelectionIndex = 0;
	private modelReasoningSelectionIndex: number | undefined;
	private actionQueue = Promise.resolve();
	private readonly border: DynamicBorder;

	constructor(
		private readonly theme: Theme,
		private readonly getView: () => FailoverTuiView,
		private readonly actions: FailoverTuiActions,
	) {
		this.border = new DynamicBorder((text: string) => theme.fg("accent", text));
	}

	private selectedModel(): ModelRef | undefined {
		return this.getView().models[this.selectedIndex];
	}

	private runAction(action: () => Promise<void>): void {
		const previous = this.actionQueue;
		this.actionQueue = runTuiAction(
			() => previous.then(action),
			this.actions.onError,
		);
	}

	private clampSelection(): void {
		const count = this.getView().models.length;
		this.selectedIndex =
			count === 0 ? 0 : Math.min(this.selectedIndex, count - 1);
		const maxOffset = Math.max(0, count - MAX_VISIBLE_MODELS);
		if (this.selectedIndex < this.scrollOffset) {
			this.scrollOffset = this.selectedIndex;
		} else if (this.selectedIndex >= this.scrollOffset + MAX_VISIBLE_MODELS) {
			this.scrollOffset = this.selectedIndex - MAX_VISIBLE_MODELS + 1;
		}
		this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
	}

	private beginSettingsEdit(view: FailoverTuiView): void {
		const key = SETTING_KEYS[this.settingsSelectionIndex];
		if (!key) return;
		if (key === "modelParameters") {
			if (view.models.length === 0) return;
			this.paramsMode = true;
			this.paramsModelIndex = Math.min(this.selectedIndex, view.models.length - 1);
			this.paramsSelectionIndex = 0;
			this.modelReasoningSelectionIndex = undefined;
			return;
		}
		if (key === "errorHandlingMode") {
			this.behaviorSelectionIndex = Math.max(
				0,
				ERROR_HANDLING_MODES.indexOf(view.config.errorHandlingMode),
			);
			return;
		}
		this.settingsInput = { key, value: String(view.config[key]) };
	}

	private isCancelInput(data: string): boolean {
		return (
			matchesKey(data, Key.escape) ||
			data === "q" ||
			matchesKey(data, Key.ctrl("c"))
		);
	}

	private saveNumericSetting(key: SettingKey, value: string): void {
		switch (key) {
			case "cooldownMinutes":
				this.runAction(() => this.actions.onSetCooldownMinutes(value));
				return;
			case "maxRetries":
				this.runAction(() => this.actions.onSetMaxRetries(value));
				return;
			case "noProgressTimeoutSeconds":
				this.runAction(() => this.actions.onSetTimeout(value));
				return;
			default:
				return;
		}
	}

	private handleNumericSettingInput(data: string): void {
		const edit = this.settingsInput;
		if (!edit) return;
		if (this.isCancelInput(data)) {
			this.settingsInput = undefined;
			return;
		}
		if (matchesKey(data, Key.backspace)) {
			edit.value = edit.value.slice(0, -1);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.settingsInput = undefined;
			this.saveNumericSetting(edit.key, edit.value);
			return;
		}
		if (/^\d+$/.test(data)) edit.value += data;
	}

	private handleBehaviorInput(data: string): void {
		const index = this.behaviorSelectionIndex;
		if (index === undefined) return;
		if (this.isCancelInput(data)) {
			this.behaviorSelectionIndex = undefined;
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.behaviorSelectionIndex = Math.max(0, index - 1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.behaviorSelectionIndex = Math.min(
				ERROR_HANDLING_MODES.length - 1,
				index + 1,
			);
			return;
		}
		if (!matchesKey(data, Key.enter)) return;
		const mode = ERROR_HANDLING_MODES[index];
		this.behaviorSelectionIndex = undefined;
		if (mode) this.runAction(() => this.actions.onSetErrorHandlingMode(mode));
	}

	private handleSettingsMenuInput(data: string, view: FailoverTuiView): void {
		if (this.isCancelInput(data)) {
			this.settingsMode = false;
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.settingsSelectionIndex = Math.max(0, this.settingsSelectionIndex - 1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.settingsSelectionIndex = Math.min(
				SETTING_KEYS.length - 1,
				this.settingsSelectionIndex + 1,
			);
			return;
		}
		if (matchesKey(data, Key.enter)) this.beginSettingsEdit(view);
	}

	private modelReasoningChoiceIndex(
		view: FailoverTuiView,
		model: ModelRef,
	): number {
		const effort = view.config.modelReasoningEfforts[modelKey(model)];
		if (effort === undefined) return 0;
		const index = REASONING_EFFORTS.indexOf(effort);
		return index < 0 ? 0 : index + 1;
	}

	private handleModelReasoningInput(data: string, view: FailoverTuiView): void {
		const index = this.modelReasoningSelectionIndex;
		if (index === undefined) return;
		if (this.isCancelInput(data)) {
			this.modelReasoningSelectionIndex = undefined;
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.modelReasoningSelectionIndex = Math.max(0, index - 1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.modelReasoningSelectionIndex = Math.min(
				MODEL_REASONING_CHOICES.length - 1,
				index + 1,
			);
			return;
		}
		if (!matchesKey(data, Key.enter)) return;
		const model = view.models[this.paramsModelIndex];
		if (!model) return;
		const effort = MODEL_REASONING_CHOICES[index];
		this.modelReasoningSelectionIndex = undefined;
		this.runAction(() => this.actions.onSetModelReasoningEffort(model, effort));
	}

	private handleParamsInput(data: string, view: FailoverTuiView): void {
		if (this.modelReasoningSelectionIndex !== undefined) {
			this.handleModelReasoningInput(data, view);
			return;
		}
		if (this.isCancelInput(data)) {
			this.paramsMode = false;
			return;
		}
		const count = view.models.length;
		if (count === 0) return;
		if (matchesKey(data, Key.up)) {
			this.paramsSelectionIndex = Math.max(0, this.paramsSelectionIndex - 1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.paramsSelectionIndex = Math.min(
				MODEL_PARAMETER_NAMES.length,
				this.paramsSelectionIndex + 1,
			);
			return;
		}
		if (matchesKey(data, Key.left) || data === "[") {
			this.paramsModelIndex = (this.paramsModelIndex - 1 + count) % count;
			return;
		}
		if (matchesKey(data, Key.right) || data === "]") {
			this.paramsModelIndex = (this.paramsModelIndex + 1) % count;
			return;
		}
		if (!matchesKey(data, Key.enter) && data !== " ") return;
		const model = view.models[this.paramsModelIndex];
		if (!model) return;
		if (this.paramsSelectionIndex === 0) {
			this.modelReasoningSelectionIndex = this.modelReasoningChoiceIndex(
				view,
				model,
			);
			return;
		}
		const parameter = MODEL_PARAMETER_NAMES[this.paramsSelectionIndex - 1];
		if (!parameter) return;
		const enabled = this.parameterEnabled(view, model, parameter);
		this.runAction(() =>
			this.actions.onSetModelParameter(model, parameter, !enabled),
		);
	}

	private parameterEnabled(
		view: FailoverTuiView,
		model: ModelRef,
		parameter: ModelParameterName,
	): boolean {
		return view.config.modelParameters[modelKey(model)]?.[parameter] ?? true;
	}

	private handleSettingsInput(data: string, view: FailoverTuiView): void {
		if (this.paramsMode) {
			this.handleParamsInput(data, view);
			return;
		}
		if (this.settingsInput) {
			this.handleNumericSettingInput(data);
			return;
		}
		if (this.behaviorSelectionIndex !== undefined) {
			this.handleBehaviorInput(data);
			return;
		}
		this.handleSettingsMenuInput(data, view);
	}

	private handleAddInput(data: string): void {
		const candidates = this.addCandidates;
		const index = this.addSelectionIndex;
		if (!candidates || index === undefined) return;
		if (this.isCancelInput(data)) {
			this.addCandidates = undefined;
			this.addSelectionIndex = undefined;
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.addSelectionIndex = Math.max(0, index - 1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.addSelectionIndex = Math.min(candidates.length - 1, index + 1);
			return;
		}
		if (!matchesKey(data, Key.enter)) return;
		const model = candidates[index];
		this.addCandidates = undefined;
		this.addSelectionIndex = undefined;
		if (model) this.runAction(() => this.actions.onAdd(model));
	}

	private handleReasoningInput(data: string): void {
		const index = this.reasoningSelectionIndex;
		if (index === undefined) return;
		if (this.isCancelInput(data)) {
			this.reasoningSelectionIndex = undefined;
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.reasoningSelectionIndex = Math.max(0, index - 1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.reasoningSelectionIndex = Math.min(
				REASONING_EFFORTS.length - 1,
				index + 1,
			);
			return;
		}
		if (!matchesKey(data, Key.enter)) return;
		const effort = REASONING_EFFORTS[index];
		this.reasoningSelectionIndex = undefined;
		if (effort) this.runAction(() => this.actions.onSetReasoningEffort(effort));
	}

	private openAddMenu(view: FailoverTuiView): void {
		const configured = new Set(view.models.map(modelKey));
		const candidates = view.available.filter(
			(model) => !configured.has(modelKey(model)),
		);
		if (candidates.length === 0) return;
		this.addCandidates = candidates;
		this.addSelectionIndex = 0;
	}

	private handleMainCommand(data: string, view: FailoverTuiView): void {
		switch (data) {
			case "a":
				this.openAddMenu(view);
				return;
			case "d": {
				const index = this.selectedIndex;
				if (this.selectedModel())
					this.runAction(() => this.actions.onRemove(index));
				return;
			}
			case "e":
				this.runAction(this.actions.onToggleEnabled);
				return;
			case "t":
				this.settingsMode = true;
				this.settingsSelectionIndex = 0;
				return;
			case "i":
				this.reasoningSelectionIndex = Math.max(
					0,
					REASONING_EFFORTS.indexOf(view.config.reasoningEffort),
				);
				return;
			case "r":
				this.runAction(this.actions.onRestore);
				return;
			default:
				return;
		}
	}

	private handleMainInput(data: string, view: FailoverTuiView): void {
		if (this.isCancelInput(data)) {
			this.actions.onClose();
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
			const direction = matchesKey(data, Key.up) ? -1 : 1;
			this.selectedIndex = Math.min(
				Math.max(0, view.models.length - 1),
				Math.max(0, this.selectedIndex + direction),
			);
			this.clampSelection();
			return;
		}
		if (matchesKey(data, Key.leftbracket) || matchesKey(data, Key.rightbracket)) {
			const direction = matchesKey(data, Key.leftbracket) ? -1 : 1;
			const index = this.selectedIndex;
			this.runAction(() => this.actions.onMove(index, direction));
			this.selectedIndex = Math.min(
				Math.max(0, view.models.length - 1),
				Math.max(0, this.selectedIndex + direction),
			);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			const model = this.selectedModel();
			if (model) this.runAction(() => this.actions.onSelect(model));
			return;
		}
		this.handleMainCommand(data, view);
	}

	handleInput(data: string): void {
		const view = this.getView();
		if (this.settingsMode) {
			this.handleSettingsInput(data, view);
			return;
		}
		if (this.addSelectionIndex !== undefined) {
			this.handleAddInput(data);
			return;
		}
		if (this.reasoningSelectionIndex !== undefined) {
			this.handleReasoningInput(data);
			return;
		}
		this.handleMainInput(data, view);
	}

	private settingValue(view: FailoverTuiView, key: SettingKey): string {
		switch (key) {
			case "cooldownMinutes":
				return view.config.cooldownMinutes === 0
					? "off"
					: `${view.config.cooldownMinutes}m`;
			case "errorHandlingMode":
				return ERROR_HANDLING_LABELS[view.config.errorHandlingMode];
			case "maxRetries":
				return String(view.config.maxRetries);
			case "noProgressTimeoutSeconds":
				return view.config.noProgressTimeoutSeconds === 0
					? "off"
					: `${view.config.noProgressTimeoutSeconds}s`;
			case "modelParameters": {
				const model = view.models[this.selectedIndex] ?? view.models[0];
				return model ? `→ ${modelKey(model)}` : "→ none";
			}
			default:
				return "";
		}
	}

	private renderParams(width: number, view: FailoverTuiView): string[] {
		const lines: string[] = [];
		const add = (line: string) =>
			lines.push(truncateToWidth(line, Math.max(1, width), ""));
		const border = this.border.render(width);
		if (border[0]) add(border[0]);
		add(this.theme.fg("accent", "Model Parameters"));
		const model = view.models[this.paramsModelIndex];
		if (!model) {
			add(this.theme.fg("warning", "No model selected"));
			const lastBorder = border.at(-1);
			if (lastBorder) add(lastBorder);
			return lines.map((line) =>
				padRight(truncateToWidth(line, width, ""), width),
			);
		}
		add(
			this.theme.fg(
				"dim",
				`Model: ${modelKey(model)}  (${this.paramsModelIndex + 1}/${view.models.length})`,
			),
		);
		add(this.theme.fg("dim", "← → switch model  Enter select/toggle  Esc back"));
		add("");
		const selectedReasoning = this.paramsSelectionIndex === 0;
		const configuredReasoning =
			view.config.modelReasoningEfforts[modelKey(model)];
		add(
			this.theme.fg(
				selectedReasoning ? "accent" : "text",
				`${selectedReasoning ? ">" : " "} Reasoning level: ${configuredReasoning ?? "inherit"}`,
			),
		);
		for (const [index, parameter] of MODEL_PARAMETER_NAMES.entries()) {
			const selected = index + 1 === this.paramsSelectionIndex;
			const enabled = this.parameterEnabled(view, model, parameter);
			add(
				this.theme.fg(
					selected ? "accent" : "text",
					`${selected ? ">" : " "} ${PARAMETER_LABELS[parameter]}: ${enabled ? "on" : "off"}`,
				),
			);
		}
		if (this.modelReasoningSelectionIndex !== undefined) {
			const choices = MODEL_REASONING_CHOICES.map((effort, index) => {
				const label = effort ?? "inherit";
				return index === this.modelReasoningSelectionIndex ? `[${label}]` : label;
			}).join("  ");
			add(
				this.theme.fg(
					"accent",
					`Reasoning level: ${choices}  ↑↓ move  Enter save  Esc cancel`,
				),
			);
		}
		const lastBorder = border.at(-1);
		if (lastBorder) add(lastBorder);
		return lines.map((line) => padRight(truncateToWidth(line, width, ""), width));
	}

	private renderSettings(width: number, view: FailoverTuiView): string[] {
		const lines: string[] = [];
		const add = (line: string) =>
			lines.push(truncateToWidth(line, Math.max(1, width), ""));
		const border = this.border.render(width);
		if (border[0]) add(border[0]);
		add(this.theme.fg("accent", "Failover Settings"));
		add(this.theme.fg("dim", "↑↓ select  Enter edit  Esc back"));
		add("");
		for (const [index, key] of SETTING_KEYS.entries()) {
			const selected = index === this.settingsSelectionIndex;
			const value = this.settingValue(view, key);
			add(
				this.theme.fg(
					selected ? "accent" : "text",
					`${selected ? ">" : " "} ${SETTING_LABELS[key]}: ${value}`,
				),
			);
		}
		if (this.behaviorSelectionIndex !== undefined) {
			const choices = ERROR_HANDLING_MODES.map((mode, index) =>
				index === this.behaviorSelectionIndex
					? `[${ERROR_HANDLING_LABELS[mode]}]`
					: ERROR_HANDLING_LABELS[mode],
			).join("  ");
			add(this.theme.fg("accent", `Error behavior: ${choices}`));
			add(this.theme.fg("dim", "↑↓ move  Enter save  Esc cancel"));
		} else if (this.settingsInput) {
			const label = SETTING_LABELS[this.settingsInput.key];
			add(
				this.theme.fg(
					"accent",
					`Enter ${label}: ${this.settingsInput.value || "_"}`,
				),
			);
			add(this.theme.fg("dim", "digits  Enter save  Esc cancel"));
		}
		const lastBorder = border.at(-1);
		if (lastBorder) add(lastBorder);
		return lines.map((line) => padRight(truncateToWidth(line, width, ""), width));
	}

	private modelStatus(view: FailoverTuiView, key: string, now: number): string {
		const cooldown = view.cooldowns.get(key);
		if (cooldown && cooldown > now)
			return ` cooldown ${Math.ceil((cooldown - now) / 60000)}m`;
		const recovery = view.manualRecovery.get(key);
		return recovery ? ` manual recovery: ${recovery}` : "";
	}

	private renderModelList(view: FailoverTuiView): string[] {
		if (view.models.length === 0)
			return [this.theme.fg("warning", "No models configured")];
		const lines: string[] = [];
		const start = this.scrollOffset;
		const end = Math.min(start + MAX_VISIBLE_MODELS, view.models.length);
		lines.push(
			this.theme.fg(
				"dim",
				`Models: ${view.models.length}  Showing ${start + 1}-${end}`,
			),
		);
		const now = Date.now();
		for (let index = start; index < end; index++) {
			const model = view.models[index];
			if (!model) continue;
			const key = modelKey(model);
			const selected = index === this.selectedIndex;
			const current = view.current && modelKey(view.current) === key ? " *" : "";
			lines.push(
				this.theme.fg(
					selected ? "accent" : "text",
					`${selected ? ">" : " "} ${index + 1}. ${key}${current}${this.modelStatus(view, key, now)}`,
				),
			);
		}
		if (end < view.models.length)
			lines.push(
				this.theme.fg(
					"dim",
					`... ${view.models.length - end} more; use arrows to scroll`,
				),
			);
		return lines;
	}

	private renderMainHeader(view: FailoverTuiView): string[] {
		const selectedModel = view.models[this.selectedIndex];
		const reasoningEffort = resolveReasoningEffort(view.config, selectedModel);
		const lines = [
			this.theme.fg("accent", "Pi Model Failover"),
			`Automation: ${view.mode}  Timeout: ${view.config.noProgressTimeoutSeconds === 0 ? "off" : `${view.config.noProgressTimeoutSeconds}s`}  Reasoning: ${reasoningEffort}`,
			`Current: ${view.current ? modelKey(view.current) : "none"}`,
			this.theme.fg(
				"dim",
				"Enter select  a add  d remove  [ ] reorder  e cycle  t settings  i reasoning  r restore  q close",
			),
		];
		if (this.reasoningSelectionIndex !== undefined) {
			const choices = REASONING_EFFORTS.map((effort, index) =>
				index === this.reasoningSelectionIndex ? `[${effort}]` : effort,
			).join("  ");
			lines.push(
				this.theme.fg(
					"accent",
					`Select reasoning: ${choices}  ↑↓ move  Enter select  Esc cancel`,
				),
			);
		}
		if (this.addSelectionIndex !== undefined && this.addCandidates) {
			const model = this.addCandidates[this.addSelectionIndex];
			if (model)
				lines.push(
					this.theme.fg(
						"accent",
						`Add model ${this.addSelectionIndex + 1}/${this.addCandidates.length}: ${modelKey(model)}  ↑↓ move  Enter add  Esc cancel`,
					),
				);
		}
		return lines;
	}

	private renderTransition(view: FailoverTuiView): string[] {
		const lines: string[] = [];
		if (view.latestTransition) {
			const source = view.latestTransition.source
				? modelKey(view.latestTransition.source)
				: "none";
			const target = view.latestTransition.target
				? modelKey(view.latestTransition.target)
				: "none";
			lines.push(
				this.theme.fg(
					"dim",
					`Last: ${source} -> ${target} (${view.latestTransition.reason})`,
				),
			);
		}
		if (view.exhaustionSummary)
			lines.push(this.theme.fg("error", `Exhausted: ${view.exhaustionSummary}`));
		return lines;
	}

	render(width: number): string[] {
		const view = this.getView();
		if (this.settingsMode) {
			if (this.paramsMode) return this.renderParams(width, view);
			return this.renderSettings(width, view);
		}
		this.clampSelection();
		const lines: string[] = [];
		const add = (line: string) =>
			lines.push(truncateToWidth(line, Math.max(1, width), ""));
		const border = this.border.render(width);
		const firstBorder = border[0];
		if (firstBorder) add(firstBorder);
		for (const line of this.renderMainHeader(view)) add(line);
		add("");
		for (const line of this.renderModelList(view)) add(line);
		for (const line of this.renderTransition(view)) add(line);
		const lastBorder = border.at(-1);
		if (lastBorder) add(lastBorder);
		return lines.map((line) => padRight(truncateToWidth(line, width, ""), width));
	}

	invalidate(): void {
		this.border.invalidate();
	}
}
