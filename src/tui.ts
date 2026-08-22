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
	ErrorHandlingMode,
	GeneratedFailoverConfig,
	GeneratedFailoverModel,
	ModelParameterName,
	ModelRef,
	ReasoningEffort,
} from "./types.ts";
import {
	ERROR_HANDLING_MODES,
	modelKey,
	MODEL_PARAMETER_NAMES,
	REASONING_EFFORTS,
} from "./types.ts";

export interface FailoverTuiView {
	config: GeneratedFailoverConfig;
	available: readonly ModelRef[];
	cooldowns: ReadonlyMap<string, number>;
	manualRecovery: ReadonlyMap<string, string>;
}

export interface FailoverTuiActions {
	onClose: () => void;
	onError: (error: unknown) => void;
	onAddModel: (name: string) => Promise<void>;
	onRemoveModel: (id: string) => Promise<void>;
	onToggleModel: (id: string) => Promise<void>;
	onRenameModel: (id: string, name: string) => Promise<void>;
	onAddTarget: (id: string, target: ModelRef) => Promise<void>;
	onRemoveTarget: (id: string, target: ModelRef) => Promise<void>;
	onMoveTarget: (
		id: string,
		target: ModelRef,
		direction: -1 | 1,
	) => Promise<void>;
	onSetReasoning: (id: string, effort: ReasoningEffort) => Promise<void>;
	onSetCooldown: (id: string, minutes: string) => Promise<void>;
	onSetErrorHandling: (id: string, mode: ErrorHandlingMode) => Promise<void>;
	onSetMaxRetries: (id: string, value: string) => Promise<void>;
	onSetTimeout: (id: string, value: string) => Promise<void>;
	onSetTargetReasoning: (
		id: string,
		target: ModelRef,
		effort: ReasoningEffort | undefined,
	) => Promise<void>;
	onSetTargetParameter: (
		id: string,
		target: ModelRef,
		parameter: ModelParameterName,
		enabled: boolean,
	) => Promise<void>;
	onRestore: (id: string) => Promise<void>;
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
	| "reasoning"
	| "cooldown"
	| "errorHandlingMode"
	| "maxRetries"
	| "noProgressTimeoutSeconds"
	| "targetParameters";

const SETTING_KEYS: readonly SettingKey[] = [
	"reasoning",
	"cooldown",
	"errorHandlingMode",
	"maxRetries",
	"noProgressTimeoutSeconds",
	"targetParameters",
];

const SETTING_LABELS: Record<SettingKey, string> = {
	reasoning: "Reasoning level",
	cooldown: "Cooldown",
	errorHandlingMode: "Error behavior",
	maxRetries: "Max retries",
	noProgressTimeoutSeconds: "No-result timeout",
	targetParameters: "Target parameters",
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
const TARGET_REASONING_CHOICES: readonly (ReasoningEffort | undefined)[] = [
	undefined,
	...REASONING_EFFORTS,
];

export class FailoverEditor implements Component {
	private selectedIndex = 0;
	private scrollOffset = 0;
	private detailModelId: string | undefined;
	private detailTargetIndex = 0;
	private detailScrollOffset = 0;
	private addTargetCandidates: readonly ModelRef[] | undefined;
	private addTargetSelectionIndex: number | undefined;
	private addModelName: string | undefined;
	private renameModelName: string | undefined;
	private settingsMode = false;
	private settingsSelectionIndex = 0;
	private settingsInput: { key: SettingKey; value: string } | undefined;
	private behaviorSelectionIndex: number | undefined;
	private reasoningSelectionIndex: number | undefined;
	private paramsMode = false;
	private paramsReturnToSettings = false;
	private paramsTargetIndex = 0;
	private paramsSelectionIndex = 0;
	private targetReasoningSelectionIndex: number | undefined;
	private actionQueue = Promise.resolve();
	private readonly border: DynamicBorder;

	constructor(
		private readonly theme: Theme,
		private readonly getView: () => FailoverTuiView,
		private readonly actions: FailoverTuiActions,
	) {
		this.border = new DynamicBorder((text: string) => theme.fg("accent", text));
	}

	private runAction(action: () => Promise<void>): void {
		const previous = this.actionQueue;
		this.actionQueue = runTuiAction(
			() => previous.then(action),
			this.actions.onError,
		);
	}

	private selectedModel(): GeneratedFailoverModel | undefined {
		return this.getView().config.models[this.selectedIndex];
	}

	private detailModel(): GeneratedFailoverModel | undefined {
		if (this.detailModelId === undefined) return undefined;
		return this.getView().config.models.find(
			(model) => model.id === this.detailModelId,
		);
	}

	private detailTarget(): ModelRef | undefined {
		return this.detailModel()?.chain[this.detailTargetIndex];
	}

	private clampSelection(): void {
		const count = this.getView().config.models.length;
		this.selectedIndex =
			count === 0 ? 0 : Math.min(this.selectedIndex, count - 1);
		const maxOffset = Math.max(0, count - MAX_VISIBLE_MODELS);
		if (this.selectedIndex < this.scrollOffset)
			this.scrollOffset = this.selectedIndex;
		else if (this.selectedIndex >= this.scrollOffset + MAX_VISIBLE_MODELS)
			this.scrollOffset = this.selectedIndex - MAX_VISIBLE_MODELS + 1;
		this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
	}

	private clampDetailTarget(): void {
		const count = this.detailModel()?.chain.length ?? 0;
		this.detailTargetIndex =
			count === 0 ? 0 : Math.min(this.detailTargetIndex, count - 1);
		const maxOffset = Math.max(0, count - MAX_VISIBLE_MODELS);
		if (this.detailTargetIndex < this.detailScrollOffset)
			this.detailScrollOffset = this.detailTargetIndex;
		else if (
			this.detailTargetIndex >=
			this.detailScrollOffset + MAX_VISIBLE_MODELS
		)
			this.detailScrollOffset = this.detailTargetIndex - MAX_VISIBLE_MODELS + 1;
		this.detailScrollOffset = Math.min(this.detailScrollOffset, maxOffset);
	}

	private isCancelInput(data: string): boolean {
		return (
			matchesKey(data, Key.escape) ||
			data === "q" ||
			matchesKey(data, Key.ctrl("c"))
		);
	}

	private openDetail(): void {
		const model = this.selectedModel();
		if (!model) return;
		this.detailModelId = model.id;
		this.detailTargetIndex = 0;
		this.detailScrollOffset = 0;
	}

	private beginSettingsEdit(model: GeneratedFailoverModel): void {
		const key = SETTING_KEYS[this.settingsSelectionIndex];
		if (!key) return;
		if (key === "targetParameters") {
			if (model.chain.length === 0) return;
			this.paramsMode = true;
			this.paramsReturnToSettings = true;
			this.paramsTargetIndex = Math.min(
				this.detailTargetIndex,
				model.chain.length - 1,
			);
			this.paramsSelectionIndex = 0;
			this.targetReasoningSelectionIndex = undefined;
			return;
		}
		if (key === "errorHandlingMode") {
			this.behaviorSelectionIndex = Math.max(
				0,
				ERROR_HANDLING_MODES.indexOf(model.errorHandlingMode),
			);
			return;
		}
		if (key === "reasoning") {
			this.reasoningSelectionIndex = Math.max(
				0,
				REASONING_EFFORTS.indexOf(model.reasoningEffort),
			);
			return;
		}
		const numericValues = {
			cooldown: model.cooldownMinutes,
			maxRetries: model.maxRetries,
			noProgressTimeoutSeconds: model.noProgressTimeoutSeconds,
		};
		this.settingsInput = { key, value: String(numericValues[key]) };
	}

	private saveNumericSetting(
		modelId: string,
		key: SettingKey,
		value: string,
	): void {
		switch (key) {
			case "cooldown":
				this.runAction(() => this.actions.onSetCooldown(modelId, value));
				return;
			case "maxRetries":
				this.runAction(() => this.actions.onSetMaxRetries(modelId, value));
				return;
			case "noProgressTimeoutSeconds":
				this.runAction(() => this.actions.onSetTimeout(modelId, value));
				return;
			default:
				return;
		}
	}

	private handleNumericSettingInput(data: string, modelId: string): void {
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
			this.saveNumericSetting(modelId, edit.key, edit.value);
			return;
		}
		if (/^\d+$/.test(data)) edit.value += data;
	}

	private handleBehaviorInput(data: string, modelId: string): void {
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
		if (mode)
			this.runAction(() => this.actions.onSetErrorHandling(modelId, mode));
	}

	private handleReasoningInput(data: string, modelId: string): void {
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
		if (effort)
			this.runAction(() => this.actions.onSetReasoning(modelId, effort));
	}

	private handleSettingsMenuInput(
		data: string,
		model: GeneratedFailoverModel,
	): void {
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
		if (matchesKey(data, Key.enter)) this.beginSettingsEdit(model);
	}

	private targetReasoningChoiceIndex(
		model: GeneratedFailoverModel,
		target: ModelRef,
	): number {
		const override = model.targetOverrides[modelKey(target)];
		const effort = override?.reasoningEffort;
		if (effort === undefined) return 0;
		const index = REASONING_EFFORTS.indexOf(effort);
		return index < 0 ? 0 : index + 1;
	}

	private handleTargetReasoningInput(
		data: string,
		model: GeneratedFailoverModel,
		target: ModelRef,
	): void {
		const index = this.targetReasoningSelectionIndex;
		if (index === undefined) return;
		if (this.isCancelInput(data)) {
			this.targetReasoningSelectionIndex = undefined;
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.targetReasoningSelectionIndex = Math.max(0, index - 1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.targetReasoningSelectionIndex = Math.min(
				TARGET_REASONING_CHOICES.length - 1,
				index + 1,
			);
			return;
		}
		if (!matchesKey(data, Key.enter)) return;
		const effort = TARGET_REASONING_CHOICES[index];
		this.targetReasoningSelectionIndex = undefined;
		this.runAction(() =>
			this.actions.onSetTargetReasoning(model.id, target, effort),
		);
	}

	private parameterEnabled(
		model: GeneratedFailoverModel,
		target: ModelRef,
		parameter: ModelParameterName,
	): boolean {
		const override = model.targetOverrides[modelKey(target)]?.modelParameters;
		const base = model.modelParameters;
		if (!override) return base[parameter];
		return override[parameter];
	}

	private handleParamsInput(
		data: string,
		model: GeneratedFailoverModel,
		target: ModelRef,
	): void {
		if (this.targetReasoningSelectionIndex !== undefined) {
			this.handleTargetReasoningInput(data, model, target);
			return;
		}
		if (this.isCancelInput(data)) {
			this.paramsMode = false;
			if (!this.paramsReturnToSettings) this.settingsMode = false;
			this.paramsReturnToSettings = false;
			return;
		}
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
		if (!matchesKey(data, Key.enter) && data !== " ") return;
		if (this.paramsSelectionIndex === 0) {
			this.targetReasoningSelectionIndex = this.targetReasoningChoiceIndex(
				model,
				target,
			);
			return;
		}
		const parameter = MODEL_PARAMETER_NAMES[this.paramsSelectionIndex - 1];
		if (!parameter) return;
		const enabled = this.parameterEnabled(model, target, parameter);
		this.runAction(() =>
			this.actions.onSetTargetParameter(model.id, target, parameter, !enabled),
		);
	}

	private handleSettingsInput(
		data: string,
		model: GeneratedFailoverModel,
	): void {
		if (this.paramsMode) {
			const target = model.chain[this.paramsTargetIndex];
			if (!target) {
				// The chain shrank underneath params mode; fall back instead of
				// swallowing every key with no way out.
				this.paramsMode = false;
				this.settingsMode = this.paramsReturnToSettings;
				this.paramsReturnToSettings = false;
				return;
			}
			this.handleParamsInput(data, model, target);
			return;
		}
		if (this.settingsInput) {
			this.handleNumericSettingInput(data, model.id);
			return;
		}
		if (this.behaviorSelectionIndex !== undefined) {
			this.handleBehaviorInput(data, model.id);
			return;
		}
		if (this.reasoningSelectionIndex !== undefined) {
			this.handleReasoningInput(data, model.id);
			return;
		}
		this.handleSettingsMenuInput(data, model);
	}

	private openAddTarget(model: GeneratedFailoverModel): void {
		const configured = new Set(model.chain.map(modelKey));
		const candidates = this.getView().available.filter(
			(target) => !configured.has(modelKey(target)),
		);
		if (candidates.length === 0) return;
		this.addTargetCandidates = candidates;
		this.addTargetSelectionIndex = 0;
	}

	private handleAddTargetInput(data: string, modelId: string): void {
		const candidates = this.addTargetCandidates;
		const index = this.addTargetSelectionIndex;
		if (!candidates || index === undefined) return;
		if (this.isCancelInput(data)) {
			this.addTargetCandidates = undefined;
			this.addTargetSelectionIndex = undefined;
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.addTargetSelectionIndex = Math.max(0, index - 1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.addTargetSelectionIndex = Math.min(candidates.length - 1, index + 1);
			return;
		}
		if (!matchesKey(data, Key.enter)) return;
		const target = candidates[index];
		this.addTargetCandidates = undefined;
		this.addTargetSelectionIndex = undefined;
		if (target) this.runAction(() => this.actions.onAddTarget(modelId, target));
	}

	private handleTextInput(
		data: string,
		get: () => string,
		set: (value: string) => void,
		reset: () => void,
		commit: (value: string) => void,
	): void {
		if (this.isCancelInput(data)) {
			reset();
			return;
		}
		if (matchesKey(data, Key.backspace)) {
			set(get().slice(0, -1));
			return;
		}
		if (matchesKey(data, Key.enter)) {
			const value = get().trim();
			reset();
			if (value) commit(value);
			return;
		}
		if (data.length === 1 && !matchesKey(data, Key.enter)) set(get() + data);
	}

	private handleDetailCommand(
		data: string,
		model: GeneratedFailoverModel,
	): void {
		switch (data) {
			case "a":
				this.openAddTarget(model);
				return;
			case "d": {
				const target = this.detailTarget();
				if (target)
					this.runAction(() => this.actions.onRemoveTarget(model.id, target));
				return;
			}
			case "t":
				this.settingsMode = true;
				this.paramsMode = false;
				this.paramsReturnToSettings = false;
				this.settingsSelectionIndex = 0;
				return;
			case "p": {
				if (model.chain.length === 0) return;
				this.settingsMode = true;
				this.paramsMode = true;
				this.paramsReturnToSettings = false;
				this.paramsTargetIndex = this.detailTargetIndex;
				this.paramsSelectionIndex = 0;
				this.targetReasoningSelectionIndex = undefined;
				return;
			}
			case "r":
				this.runAction(() => this.actions.onRestore(model.id));
				return;
			default:
				return;
		}
	}

	private handleDetailInput(data: string, model: GeneratedFailoverModel): void {
		if (this.isCancelInput(data)) {
			this.detailModelId = undefined;
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
			const direction = matchesKey(data, Key.up) ? -1 : 1;
			this.detailTargetIndex = Math.min(
				Math.max(0, model.chain.length - 1),
				Math.max(0, this.detailTargetIndex + direction),
			);
			this.clampDetailTarget();
			return;
		}
		if (matchesKey(data, Key.leftbracket) || matchesKey(data, Key.rightbracket)) {
			const direction = matchesKey(data, Key.leftbracket) ? -1 : 1;
			const target = this.detailTarget();
			if (target)
				this.runAction(() =>
					this.actions.onMoveTarget(model.id, target, direction),
				);
			this.detailTargetIndex = Math.min(
				Math.max(0, model.chain.length - 1),
				Math.max(0, this.detailTargetIndex + direction),
			);
			return;
		}
		this.handleDetailCommand(data, model);
	}

	private handleMainCommand(data: string): void {
		switch (data) {
			case "a":
				this.addModelName = "";
				return;
			case "d": {
				const model = this.selectedModel();
				if (model) this.runAction(() => this.actions.onRemoveModel(model.id));
				return;
			}
			case "e": {
				const model = this.selectedModel();
				if (model) this.runAction(() => this.actions.onToggleModel(model.id));
				return;
			}
			case "r": {
				const model = this.selectedModel();
				if (model) {
					this.renameModelName = model.name;
				}
				return;
			}
			default:
				return;
		}
	}

	private handleMainInput(data: string): void {
		if (this.isCancelInput(data)) {
			this.actions.onClose();
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
			const direction = matchesKey(data, Key.up) ? -1 : 1;
			this.selectedIndex = Math.min(
				Math.max(0, this.getView().config.models.length - 1),
				Math.max(0, this.selectedIndex + direction),
			);
			this.clampSelection();
			return;
		}
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
			this.openDetail();
			return;
		}
		this.handleMainCommand(data);
	}

	handleInput(data: string): void {
		if (this.addModelName !== undefined) {
			this.handleTextInput(
				data,
				() => this.addModelName ?? "",
				(value) => {
					this.addModelName = value;
				},
				() => {
					this.addModelName = undefined;
				},
				(value) => this.runAction(() => this.actions.onAddModel(value)),
			);
			return;
		}
		if (this.renameModelName !== undefined) {
			this.handleTextInput(
				data,
				() => this.renameModelName ?? "",
				(value) => {
					this.renameModelName = value;
				},
				() => {
					this.renameModelName = undefined;
				},
				(value) => {
					const model = this.selectedModel();
					if (model)
						this.runAction(() => this.actions.onRenameModel(model.id, value));
				},
			);
			return;
		}
		if (this.settingsMode) {
			const model = this.detailModel();
			if (model) {
				this.handleSettingsInput(data, model);
				return;
			}
			this.settingsMode = false;
			return;
		}
		if (this.addTargetSelectionIndex !== undefined) {
			const model = this.detailModel();
			if (model) this.handleAddTargetInput(data, model.id);
			return;
		}
		if (this.detailModelId !== undefined) {
			const model = this.detailModel();
			if (model) {
				this.handleDetailInput(data, model);
				return;
			}
			this.detailModelId = undefined;
			return;
		}
		this.handleMainInput(data);
	}

	private modelStatus(
		view: FailoverTuiView,
		id: string,
		key: string,
		now: number,
	): string {
		const cooldown = view.cooldowns.get(`${id}:${key}`);
		if (cooldown && cooldown > now)
			return ` cooldown ${Math.ceil((cooldown - now) / 60000)}m`;
		const recovery = view.manualRecovery.get(`${id}:${key}`);
		return recovery ? ` manual recovery: ${recovery}` : "";
	}

	private renderModelList(view: FailoverTuiView): string[] {
		if (view.config.models.length === 0)
			return [this.theme.fg("warning", "No failover models configured")];
		const lines: string[] = [];
		const start = this.scrollOffset;
		const end = Math.min(start + MAX_VISIBLE_MODELS, view.config.models.length);
		lines.push(
			this.theme.fg(
				"dim",
				`Models: ${view.config.models.length}  Showing ${start + 1}-${end}`,
			),
		);
		for (let index = start; index < end; index++) {
			const model = view.config.models[index];
			if (!model) continue;
			const selected = index === this.selectedIndex;
			const chain = model.chain.map(modelKey).join(" \u2192 ") || "empty";
			lines.push(
				this.theme.fg(
					selected ? "accent" : "text",
					`${selected ? ">" : " "} ${index + 1}. ${model.id} "${model.name}"${model.enabled ? "" : " [disabled]"}  ${chain}`,
				),
			);
		}
		if (end < view.config.models.length)
			lines.push(
				this.theme.fg(
					"dim",
					`... ${view.config.models.length - end} more; use arrows to scroll`,
				),
			);
		return lines;
	}

	private renderChain(
		view: FailoverTuiView,
		model: GeneratedFailoverModel,
	): string[] {
		if (model.chain.length === 0)
			return [this.theme.fg("warning", "No targets configured")];
		const lines: string[] = [];
		const start = this.detailScrollOffset;
		const end = Math.min(start + MAX_VISIBLE_MODELS, model.chain.length);
		const now = Date.now();
		for (let index = start; index < end; index++) {
			const target = model.chain[index];
			if (!target) continue;
			const key = modelKey(target);
			const selected = index === this.detailTargetIndex;
			lines.push(
				this.theme.fg(
					selected ? "accent" : "text",
					`${selected ? ">" : " "} ${index + 1}. ${key}${this.modelStatus(view, model.id, key, now)}`,
				),
			);
		}
		return lines;
	}

	private renderDetail(
		view: FailoverTuiView,
		model: GeneratedFailoverModel,
	): string[] {
		const lines: string[] = [
			this.theme.fg("accent", `Failover Model: ${model.id}`),
			`Name: ${model.name}  Enabled: ${model.enabled ? "yes" : "no"}`,
			`Reasoning: ${model.reasoningEffort}  Cooldown: ${model.cooldownMinutes === 0 ? "off" : `${model.cooldownMinutes}m`}  Error: ${ERROR_HANDLING_LABELS[model.errorHandlingMode]}  Retries: ${model.maxRetries}  Timeout: ${model.noProgressTimeoutSeconds === 0 ? "off" : `${model.noProgressTimeoutSeconds}s`}`,
			this.theme.fg(
				"dim",
				"a add target  d remove  [ ] reorder  p target params  t settings  r restore  Esc back",
			),
			"",
			...this.renderChain(view, model),
		];
		if (this.addTargetSelectionIndex !== undefined && this.addTargetCandidates) {
			const target = this.addTargetCandidates[this.addTargetSelectionIndex];
			if (target)
				lines.push(
					this.theme.fg(
						"accent",
						`Add target ${this.addTargetSelectionIndex + 1}/${this.addTargetCandidates.length}: ${modelKey(target)}  \u2191\u2193 move  Enter add  Esc cancel`,
					),
				);
		}
		return lines;
	}

	/** Start a bordered panel: collected lines plus a width-clamping writer. */
	private beginPanel(width: number): {
		lines: string[];
		add: (line: string) => void;
		border: string[];
	} {
		const lines: string[] = [];
		const add = (line: string) =>
			lines.push(truncateToWidth(line, Math.max(1, width), ""));
		const border = this.border.render(width);
		if (border[0]) add(border[0]);
		return { lines, add, border };
	}

	private renderSettings(
		model: GeneratedFailoverModel,
		width: number,
	): string[] {
		if (this.paramsMode) return this.renderParams(model, width);
		const { lines, add, border } = this.beginPanel(width);
		add(this.theme.fg("accent", `Settings: ${model.id}`));
		add(this.theme.fg("dim", "\u2191\u2193 select  Enter edit  Esc back"));
		add("");
		for (const [index, key] of SETTING_KEYS.entries()) {
			const selected = index === this.settingsSelectionIndex;
			add(
				this.theme.fg(
					selected ? "accent" : "text",
					`${selected ? ">" : " "} ${SETTING_LABELS[key]}: ${this.settingValue(model, key)}`,
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
			add(this.theme.fg("dim", "\u2191\u2193 move  Enter save  Esc cancel"));
		} else if (this.reasoningSelectionIndex !== undefined) {
			const choices = REASONING_EFFORTS.map((effort, index) =>
				index === this.reasoningSelectionIndex ? `[${effort}]` : effort,
			).join("  ");
			add(this.theme.fg("accent", `Reasoning level: ${choices}`));
			add(this.theme.fg("dim", "\u2191\u2193 move  Enter save  Esc cancel"));
		} else if (this.settingsInput) {
			add(
				this.theme.fg(
					"accent",
					`Enter ${SETTING_LABELS[this.settingsInput.key]}: ${this.settingsInput.value || "_"}`,
				),
			);
			add(this.theme.fg("dim", "digits  Enter save  Esc cancel"));
		}
		const lastBorder = border.at(-1);
		if (lastBorder) add(lastBorder);
		return lines.map((line) => padRight(truncateToWidth(line, width, ""), width));
	}

	private renderParams(model: GeneratedFailoverModel, width: number): string[] {
		const { lines, add, border } = this.beginPanel(width);
		add(this.theme.fg("accent", `Target Parameters: ${model.id}`));
		const target = model.chain[this.paramsTargetIndex];
		if (!target) {
			add(this.theme.fg("warning", "No target selected"));
			const lastBorder = border.at(-1);
			if (lastBorder) add(lastBorder);
			return lines.map((line) =>
				padRight(truncateToWidth(line, width, ""), width),
			);
		}
		add(this.theme.fg("dim", `Target: ${modelKey(target)}`));
		add(this.theme.fg("dim", "Enter select/toggle  Esc back"));
		add("");
		const override = model.targetOverrides[modelKey(target)];
		const selectedReasoning = this.paramsSelectionIndex === 0;
		const configuredReasoning = override?.reasoningEffort;
		add(
			this.theme.fg(
				selectedReasoning ? "accent" : "text",
				`${selectedReasoning ? ">" : " "} Reasoning level: ${configuredReasoning ?? "inherit"}`,
			),
		);
		for (const [index, parameter] of MODEL_PARAMETER_NAMES.entries()) {
			const selected = index + 1 === this.paramsSelectionIndex;
			const enabled = this.parameterEnabled(model, target, parameter);
			add(
				this.theme.fg(
					selected ? "accent" : "text",
					`${selected ? ">" : " "} ${PARAMETER_LABELS[parameter]}: ${enabled ? "on" : "off"}`,
				),
			);
		}
		if (this.targetReasoningSelectionIndex !== undefined) {
			const choices = TARGET_REASONING_CHOICES.map((effort, index) => {
				const label = effort ?? "inherit";
				return index === this.targetReasoningSelectionIndex ? `[${label}]` : label;
			}).join("  ");
			add(
				this.theme.fg(
					"accent",
					`Reasoning level: ${choices}  \u2191\u2193 move  Enter save  Esc cancel`,
				),
			);
		}
		const lastBorder = border.at(-1);
		if (lastBorder) add(lastBorder);
		return lines.map((line) => padRight(truncateToWidth(line, width, ""), width));
	}

	private settingValue(model: GeneratedFailoverModel, key: SettingKey): string {
		switch (key) {
			case "reasoning":
				return model.reasoningEffort;
			case "cooldown":
				return model.cooldownMinutes === 0 ? "off" : `${model.cooldownMinutes}m`;
			case "errorHandlingMode":
				return ERROR_HANDLING_LABELS[model.errorHandlingMode];
			case "maxRetries":
				return String(model.maxRetries);
			case "noProgressTimeoutSeconds":
				return model.noProgressTimeoutSeconds === 0
					? "off"
					: `${model.noProgressTimeoutSeconds}s`;
			case "targetParameters":
				return model.chain.length > 0 ? "\u2192 edit" : "\u2192 none";
			default:
				return "";
		}
	}

	render(width: number): string[] {
		const view = this.getView();
		if (this.settingsMode) {
			const model = this.detailModel();
			if (model) return this.renderSettings(model, width);
			this.settingsMode = false;
		}

		const { lines, add, border } = this.beginPanel(width);

		if (this.addModelName !== undefined) {
			add(this.theme.fg("accent", "Add failover model"));
			add(this.theme.fg("accent", `Name: ${this.addModelName || "_"}`));
			add(this.theme.fg("dim", "type name  Enter create  Esc cancel"));
		} else if (this.renameModelName !== undefined) {
			add(this.theme.fg("accent", "Rename failover model"));
			add(this.theme.fg("accent", `Name: ${this.renameModelName || "_"}`));
			add(this.theme.fg("dim", "type name  Enter save  Esc cancel"));
		} else if (this.detailModelId === undefined) {
			for (const line of this.renderMainHeader()) add(line);
			add("");
			for (const line of this.renderModelList(view)) add(line);
		} else {
			const model = this.detailModel();
			if (model) {
				for (const line of this.renderDetail(view, model)) add(line);
			} else {
				this.detailModelId = undefined;
				for (const line of this.renderMainHeader()) add(line);
				add("");
				for (const line of this.renderModelList(view)) add(line);
			}
		}

		const lastBorder = border.at(-1);
		if (lastBorder) add(lastBorder);
		return lines.map((line) => padRight(truncateToWidth(line, width, ""), width));
	}

	private renderMainHeader(): string[] {
		return [
			this.theme.fg("accent", "Pi Model Failover"),
			this.theme.fg(
				"dim",
				"Enter edit  a add  d remove  e toggle  r rename  q close",
			),
		];
	}

	invalidate(): void {
		this.border.invalidate();
	}
}
