import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { FailoverProviderState } from "./provider.ts";
import type {
	Inheritable,
	SharedChainScope,
	SharedChainSettings,
	SharedCoordinationStatus,
	SharedTargetOverride,
	SharedTargetRuntime,
	SharedTargetSettings,
} from "./shared-state.ts";
import type {
	ErrorHandlingMode,
	GeneratedFailoverConfigV8,
	GeneratedFailoverModelV8,
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
import {
	Key,
	matchesKey,
	truncateToWidth,
	type Component,
	visibleWidth,
} from "@earendil-works/pi-tui";

type FailoverHistoryEntry =
	NonNullable<FailoverProviderState["onTransition"]> extends (
		transition: infer Transition,
	) => void
		? Transition & { timestamp: number }
		: never;

export interface FailoverTuiView {
	config: GeneratedFailoverConfigV8;
	available: readonly ModelRef[];
	targets: ReadonlyMap<
		string,
		{ settings: SharedTargetSettings; runtime: SharedTargetRuntime }
	>;
	scopes: ReadonlyMap<string, SharedChainScope>;
	coordination: SharedCoordinationStatus;
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
	onSetTargetReasoning: (
		target: ModelRef,
		effort: Inheritable<ReasoningEffort>,
		modelId: string,
	) => Promise<void>;
	onSetTargetErrorHandling: (
		target: ModelRef,
		mode: Inheritable<ErrorHandlingMode>,
		modelId: string,
	) => Promise<void>;
	onSetTargetMaxRetries: (
		target: ModelRef,
		value: string,
		modelId: string,
	) => Promise<void>;
	onSetTargetTimeout: (
		target: ModelRef,
		value: string,
		modelId: string,
	) => Promise<void>;
	onSetTargetParameter: (
		target: ModelRef,
		parameter: ModelParameterName,
		enabled: Inheritable<boolean>,
		modelId: string,
	) => Promise<void>;
	onSetScopeReasoning: (
		modelId: string,
		effort: ReasoningEffort,
	) => Promise<void>;
	onSetScopeErrorHandling: (
		modelId: string,
		mode: ErrorHandlingMode,
	) => Promise<void>;
	onSetScopeMaxRetries: (modelId: string, value: string) => Promise<void>;
	onSetScopeTimeout: (modelId: string, value: string) => Promise<void>;
	onSetScopeParameter: (
		modelId: string,
		parameter: ModelParameterName,
		enabled: boolean,
	) => Promise<void>;
	onToggleTarget: (target: ModelRef, enabled: boolean) => Promise<void>;
	onResetTarget: (target: ModelRef) => Promise<void>;
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

function createPanel(
	width: number,
	border: DynamicBorder,
): {
	lines: string[];
	add: (line: string) => void;
	border: string[];
} {
	const lines: string[] = [];
	const add = (line: string) =>
		lines.push(truncateToWidth(line, Math.max(1, width), ""));
	const renderedBorder = border.render(width);
	if (renderedBorder[0]) add(renderedBorder[0]);
	return { lines, add, border: renderedBorder };
}

type NumericSettingKey = "maxRetries" | "noProgressTimeoutSeconds";
type SettingKey =
	| "reasoning"
	| "errorHandlingMode"
	| NumericSettingKey
	| "resetTarget"
	| ModelParameterName;

const SETTING_KEYS: readonly SettingKey[] = [
	"reasoning",
	"errorHandlingMode",
	"maxRetries",
	"noProgressTimeoutSeconds",
	"resetTarget",
	...MODEL_PARAMETER_NAMES,
];

const SETTING_LABELS: Record<SettingKey, string> = {
	reasoning: "Reasoning",
	errorHandlingMode: "Error behavior",
	maxRetries: "Max retries",
	noProgressTimeoutSeconds: "No-result timeout",
	resetTarget: "Reset target state",
	promptCacheKey: "prompt_cache_key",
	promptCacheRetention: "prompt_cache_retention",
	reasoningEffort: "reasoning effort",
	sessionAffinity: "session headers",
};

const SCOPE_SETTING_KEYS = SETTING_KEYS.filter((key) => key !== "resetTarget");
const TARGET_ERROR_HANDLING_MODES: readonly Inheritable<ErrorHandlingMode>[] = [
	"inherit",
	...ERROR_HANDLING_MODES,
];
const TARGET_REASONING_EFFORTS: readonly Inheritable<ReasoningEffort>[] = [
	"inherit",
	...REASONING_EFFORTS,
];
const ERROR_HANDLING_LABELS: Record<ErrorHandlingMode, string> = {
	smart: "smart",
	switch: "switch immediately",
	retry: "retry then switch",
};

const MAX_VISIBLE_ROWS = 20;

function isParameterKey(value: SettingKey): value is ModelParameterName {
	return (MODEL_PARAMETER_NAMES as readonly string[]).includes(value);
}

type TargetSettingsContext = {
	kind: "target";
	model: GeneratedFailoverModelV8;
	target: ModelRef;
	settings: SharedTargetSettings;
	override: SharedTargetOverride;
};

type ScopeSettingsContext = {
	kind: "scope";
	model: GeneratedFailoverModelV8;
	settings: SharedChainSettings;
};

type SettingsContext = TargetSettingsContext | ScopeSettingsContext;

function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.ceil(ms / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.ceil(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	return `${Math.ceil(minutes / 60)}h`;
}

function formatCooldownMinutes(ms: number): string {
	return `${Math.max(1, Math.ceil(Math.max(0, ms) / 60_000))}m`;
}

function coordinationLine(status: SharedCoordinationStatus): string {
	return status.coordination === "shared"
		? "Coordination: shared"
		: `Coordination: local-only (${status.reason})`;
}

function targetStatus(
	runtime: SharedTargetRuntime | undefined,
	now: number,
): string {
	if (!runtime) return " eligible";
	let status: string;
	if (runtime.manualRecovery) {
		status = ` manual recovery: ${runtime.manualRecovery.reason}`;
	} else if (runtime.cooldownUntil !== null && runtime.cooldownUntil > now) {
		status = ` cooldown ${formatCooldownMinutes(runtime.cooldownUntil - now)}`;
	} else if (runtime.nextEligibleAt !== null && runtime.nextEligibleAt > now) {
		status = ` retry delay ${formatDuration(runtime.nextEligibleAt - now)}`;
	} else {
		status = " eligible";
	}
	if (runtime.cumulativeCooldownMs > 0)
		status += `; cumulative cooldown ${formatDuration(runtime.cumulativeCooldownMs)}`;
	return status;
}

export class FailoverEditor implements Component {
	private selectedIndex = 0;
	private scrollOffset = 0;
	private detailModelId: string | undefined;
	private detailTargetIndex = 0;
	private detailScrollOffset = 0;
	private addTargetCandidates: readonly ModelRef[] | undefined;
	private addTargetSelectionIndex: number | undefined;
	private addTargetScrollOffset = 0;
	private addModelName: string | undefined;
	private renameModelName: string | undefined;
	private settingsTarget: ModelRef | undefined;
	private settingsScopeModelId: string | undefined;
	private settingsSelectionIndex = 0;
	private settingsInput: { key: NumericSettingKey; value: string } | undefined;
	private behaviorSelectionIndex: number | undefined;
	private reasoningSelectionIndex: number | undefined;
	private readonly pendingTargetParameters = new Map<
		string,
		{ value: Inheritable<boolean> }
	>();
	private readonly pendingTargetEnabled = new Map<string, { value: boolean }>();
	private actionQueue: Promise<void> = Promise.resolve();
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

	/** Resolve when every serialized UI action dispatched so far has settled. */
	whenIdle(): Promise<void> {
		return this.actionQueue;
	}

	private selectedModel(): GeneratedFailoverModelV8 | undefined {
		return this.getView().config.models[this.selectedIndex];
	}

	private detailModel(): GeneratedFailoverModelV8 | undefined {
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
		const maxOffset = Math.max(0, count - MAX_VISIBLE_ROWS);
		if (this.selectedIndex < this.scrollOffset)
			this.scrollOffset = this.selectedIndex;
		else if (this.selectedIndex >= this.scrollOffset + MAX_VISIBLE_ROWS)
			this.scrollOffset = this.selectedIndex - MAX_VISIBLE_ROWS + 1;
		this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
	}

	private clampDetailTarget(): void {
		const count = this.detailModel()?.chain.length ?? 0;
		this.detailTargetIndex =
			count === 0 ? 0 : Math.min(this.detailTargetIndex, count - 1);
		const maxOffset = Math.max(0, count - MAX_VISIBLE_ROWS);
		if (this.detailTargetIndex < this.detailScrollOffset)
			this.detailScrollOffset = this.detailTargetIndex;
		else if (this.detailTargetIndex >= this.detailScrollOffset + MAX_VISIBLE_ROWS)
			this.detailScrollOffset = this.detailTargetIndex - MAX_VISIBLE_ROWS + 1;
		this.detailScrollOffset = Math.min(this.detailScrollOffset, maxOffset);
	}

	private clampAddTarget(): void {
		const count = this.addTargetCandidates?.length ?? 0;
		const index = this.addTargetSelectionIndex ?? 0;
		if (count === 0) {
			this.addTargetScrollOffset = 0;
			return;
		}
		const maxOffset = Math.max(0, count - MAX_VISIBLE_ROWS);
		if (index < this.addTargetScrollOffset) this.addTargetScrollOffset = index;
		else if (index >= this.addTargetScrollOffset + MAX_VISIBLE_ROWS)
			this.addTargetScrollOffset = index - MAX_VISIBLE_ROWS + 1;
		this.addTargetScrollOffset = Math.min(this.addTargetScrollOffset, maxOffset);
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

	private closeSettings(): void {
		this.settingsTarget = undefined;
		this.settingsScopeModelId = undefined;
		this.settingsInput = undefined;
		this.behaviorSelectionIndex = undefined;
		this.reasoningSelectionIndex = undefined;
	}

	private resetSettingsNavigation(): void {
		this.settingsSelectionIndex = 0;
		this.settingsInput = undefined;
		this.behaviorSelectionIndex = undefined;
		this.reasoningSelectionIndex = undefined;
	}

	private openTargetSettings(): void {
		const target = this.detailTarget();
		if (!target) return;
		this.settingsTarget = { ...target };
		this.settingsScopeModelId = undefined;
		this.resetSettingsNavigation();
	}

	private openScopeSettings(): void {
		const model = this.detailModel();
		if (!model || !this.getView().scopes.has(model.id)) return;
		this.settingsTarget = undefined;
		this.settingsScopeModelId = model.id;
		this.resetSettingsNavigation();
	}

	private settingsContext(): SettingsContext | undefined {
		const view = this.getView();
		if (this.settingsTarget) {
			const target = this.settingsTarget;
			const model = this.detailModel();
			if (!model) return undefined;
			const key = modelKey(target);
			const currentTarget = model.chain.find((entry) => modelKey(entry) === key);
			const record = view.targets.get(key);
			const override = view.scopes.get(model.id)?.overrides[key];
			if (!currentTarget || !record || !override) return undefined;
			return {
				kind: "target",
				model,
				target: currentTarget,
				settings: record.settings,
				override,
			};
		}
		const modelId = this.settingsScopeModelId;
		if (!modelId) return undefined;
		const model = view.config.models.find((entry) => entry.id === modelId);
		const scope = view.scopes.get(modelId);
		if (!model || !scope) return undefined;
		return { kind: "scope", model, settings: scope.settings };
	}

	private settingsKeys(context: SettingsContext): readonly SettingKey[] {
		return context.kind === "target" ? SETTING_KEYS : SCOPE_SETTING_KEYS;
	}

	private settingValue(context: SettingsContext, key: SettingKey): string {
		if (key === "resetTarget") return "action";
		const settings =
			context.kind === "target" ? context.override : context.settings;
		if (key === "reasoning") return settings.reasoningEffort;
		if (key === "errorHandlingMode") {
			const value = settings.errorHandlingMode;
			return value === "inherit" ? value : ERROR_HANDLING_LABELS[value];
		}
		if (key === "maxRetries") return String(settings.maxRetries);
		if (key === "noProgressTimeoutSeconds") {
			const value = settings.noProgressTimeoutSeconds;
			if (value === "inherit") return value;
			return value === 0 ? "off" : `${value}s`;
		}
		const value = settings.modelParameters[key];
		return value === "inherit" ? value : value ? "on" : "off";
	}

	private beginSettingsEdit(context: SettingsContext): void {
		const key = this.settingsKeys(context)[this.settingsSelectionIndex];
		if (!key) return;
		if (key === "resetTarget") {
			if (context.kind === "target")
				this.runAction(() => this.actions.onResetTarget(context.target));
			return;
		}
		if (isParameterKey(key)) {
			if (context.kind === "target") {
				const pendingKey = `${context.model.id}:${modelKey(context.target)}:${key}`;
				const pending = this.pendingTargetParameters.get(pendingKey);
				const current = pending?.value ?? context.override.modelParameters[key];
				const next: Inheritable<boolean> =
					current === "inherit" ? true : current ? false : "inherit";
				const pendingUpdate = { value: next };
				this.pendingTargetParameters.set(pendingKey, pendingUpdate);
				this.runAction(async () => {
					try {
						await this.actions.onSetTargetParameter(
							context.target,
							key,
							next,
							context.model.id,
						);
					} finally {
						if (this.pendingTargetParameters.get(pendingKey) === pendingUpdate)
							this.pendingTargetParameters.delete(pendingKey);
					}
				});
			} else {
				this.runAction(() =>
					this.actions.onSetScopeParameter(
						context.model.id,
						key,
						!context.settings.modelParameters[key],
					),
				);
			}
			return;
		}
		if (key === "errorHandlingMode") {
			const choices: readonly string[] =
				context.kind === "target"
					? TARGET_ERROR_HANDLING_MODES
					: ERROR_HANDLING_MODES;
			const current =
				context.kind === "target"
					? context.override.errorHandlingMode
					: context.settings.errorHandlingMode;
			this.behaviorSelectionIndex = Math.max(0, choices.indexOf(current));
			return;
		}
		if (key === "reasoning") {
			const choices: readonly string[] =
				context.kind === "target" ? TARGET_REASONING_EFFORTS : REASONING_EFFORTS;
			const current =
				context.kind === "target"
					? context.override.reasoningEffort
					: context.settings.reasoningEffort;
			this.reasoningSelectionIndex = Math.max(0, choices.indexOf(current));
			return;
		}
		const settings =
			context.kind === "target" ? context.override : context.settings;
		this.settingsInput = { key, value: String(settings[key]) };
	}

	private saveNumericSetting(
		context: SettingsContext,
		key: NumericSettingKey,
		value: string,
	): void {
		if (context.kind === "target") {
			if (key === "maxRetries") {
				this.runAction(() =>
					this.actions.onSetTargetMaxRetries(
						context.target,
						value,
						context.model.id,
					),
				);
				return;
			}
			this.runAction(() =>
				this.actions.onSetTargetTimeout(context.target, value, context.model.id),
			);
			return;
		}
		if (key === "maxRetries") {
			this.runAction(() =>
				this.actions.onSetScopeMaxRetries(context.model.id, value),
			);
			return;
		}
		this.runAction(() => this.actions.onSetScopeTimeout(context.model.id, value));
	}

	private handleNumericSettingInput(
		data: string,
		context: SettingsContext,
	): void {
		const edit = this.settingsInput;
		if (!edit) return;
		if (this.isCancelInput(data)) {
			this.settingsInput = undefined;
			return;
		}
		if (matchesKey(data, Key.backspace)) {
			edit.value = edit.value === "inherit" ? "" : edit.value.slice(0, -1);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.settingsInput = undefined;
			this.saveNumericSetting(context, edit.key, edit.value);
			return;
		}
		if (/^\d+$/.test(data)) {
			edit.value = /^\d+$/.test(edit.value) ? edit.value + data : data;
			return;
		}
		if (context.kind === "target" && /^[a-z]+$/i.test(data)) {
			edit.value =
				/^[a-z]+$/i.test(edit.value) && edit.value !== "inherit"
					? edit.value + data.toLowerCase()
					: data.toLowerCase();
		}
	}

	private handleBehaviorInput(data: string, context: SettingsContext): void {
		const index = this.behaviorSelectionIndex;
		if (index === undefined) return;
		const choices: readonly string[] =
			context.kind === "target"
				? TARGET_ERROR_HANDLING_MODES
				: ERROR_HANDLING_MODES;
		if (this.isCancelInput(data)) {
			this.behaviorSelectionIndex = undefined;
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.behaviorSelectionIndex = Math.max(0, index - 1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.behaviorSelectionIndex = Math.min(choices.length - 1, index + 1);
			return;
		}
		if (!matchesKey(data, Key.enter)) return;
		const mode = choices[index];
		this.behaviorSelectionIndex = undefined;
		if (!mode) return;
		if (context.kind === "target") {
			this.runAction(() =>
				this.actions.onSetTargetErrorHandling(
					context.target,
					mode as Inheritable<ErrorHandlingMode>,
					context.model.id,
				),
			);
			return;
		}
		this.runAction(() =>
			this.actions.onSetScopeErrorHandling(
				context.model.id,
				mode as ErrorHandlingMode,
			),
		);
	}

	private handleReasoningInput(data: string, context: SettingsContext): void {
		const index = this.reasoningSelectionIndex;
		if (index === undefined) return;
		const choices: readonly string[] =
			context.kind === "target" ? TARGET_REASONING_EFFORTS : REASONING_EFFORTS;
		if (this.isCancelInput(data)) {
			this.reasoningSelectionIndex = undefined;
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.reasoningSelectionIndex = Math.max(0, index - 1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.reasoningSelectionIndex = Math.min(choices.length - 1, index + 1);
			return;
		}
		if (!matchesKey(data, Key.enter)) return;
		const effort = choices[index];
		this.reasoningSelectionIndex = undefined;
		if (!effort) return;
		if (context.kind === "target") {
			this.runAction(() =>
				this.actions.onSetTargetReasoning(
					context.target,
					effort as Inheritable<ReasoningEffort>,
					context.model.id,
				),
			);
			return;
		}
		this.runAction(() =>
			this.actions.onSetScopeReasoning(
				context.model.id,
				effort as ReasoningEffort,
			),
		);
	}

	private handleSettingsInput(data: string): void {
		const context = this.settingsContext();
		if (!context) {
			this.closeSettings();
			return;
		}
		if (this.settingsInput) {
			this.handleNumericSettingInput(data, context);
			return;
		}
		if (this.behaviorSelectionIndex !== undefined) {
			this.handleBehaviorInput(data, context);
			return;
		}
		if (this.reasoningSelectionIndex !== undefined) {
			this.handleReasoningInput(data, context);
			return;
		}
		if (this.isCancelInput(data)) {
			this.closeSettings();
			return;
		}
		const keys = this.settingsKeys(context);
		if (matchesKey(data, Key.up)) {
			this.settingsSelectionIndex = Math.max(0, this.settingsSelectionIndex - 1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.settingsSelectionIndex = Math.min(
				keys.length - 1,
				this.settingsSelectionIndex + 1,
			);
			return;
		}
		if (matchesKey(data, Key.enter)) this.beginSettingsEdit(context);
	}

	private openAddTarget(model: GeneratedFailoverModelV8): void {
		const configured = new Set(model.chain.map(modelKey));
		const candidates = this.getView().available.filter(
			(target) => !configured.has(modelKey(target)),
		);
		if (candidates.length === 0) return;
		this.addTargetCandidates = candidates;
		this.addTargetSelectionIndex = 0;
		this.addTargetScrollOffset = 0;
	}

	private handleAddTargetInput(data: string, modelId: string): void {
		const candidates = this.addTargetCandidates;
		const index = this.addTargetSelectionIndex;
		if (!candidates || index === undefined) return;
		if (this.isCancelInput(data)) {
			this.addTargetCandidates = undefined;
			this.addTargetSelectionIndex = undefined;
			this.addTargetScrollOffset = 0;
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.addTargetSelectionIndex = Math.max(0, index - 1);
			this.clampAddTarget();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.addTargetSelectionIndex = Math.min(candidates.length - 1, index + 1);
			this.clampAddTarget();
			return;
		}
		if (!matchesKey(data, Key.enter)) return;
		const target = candidates[index];
		this.addTargetCandidates = undefined;
		this.addTargetSelectionIndex = undefined;
		this.addTargetScrollOffset = 0;
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
		if (data.length === 1) set(get() + data);
	}

	private handleDetailCommand(
		data: string,
		model: GeneratedFailoverModelV8,
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
			case "e": {
				const target = this.detailTarget();
				if (target) {
					const targetKey = modelKey(target);
					const enabled =
						this.pendingTargetEnabled.get(targetKey)?.value ??
						this.getView().targets.get(targetKey)?.settings.enabled !== false;
					const pendingUpdate = { value: !enabled };
					this.pendingTargetEnabled.set(targetKey, pendingUpdate);
					this.runAction(async () => {
						try {
							await this.actions.onToggleTarget(target, pendingUpdate.value);
						} finally {
							if (this.pendingTargetEnabled.get(targetKey) === pendingUpdate)
								this.pendingTargetEnabled.delete(targetKey);
						}
					});
				}
				return;
			}
			case "t":
				this.openScopeSettings();
				return;
			case "r": {
				const target = this.detailTarget();
				if (target) this.runAction(() => this.actions.onResetTarget(target));
				return;
			}
			default:
				return;
		}
	}

	private handleDetailInput(
		data: string,
		model: GeneratedFailoverModelV8,
	): void {
		if (this.isCancelInput(data)) {
			this.detailModelId = undefined;
			this.closeSettings();
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
			if (target) {
				this.runAction(async () => {
					await this.actions.onMoveTarget(model.id, target, direction);
					const latest = this.detailModel();
					if (!latest) return;
					const index = latest.chain.findIndex(
						(entry) => modelKey(entry) === modelKey(target),
					);
					if (index < 0) return;
					this.detailTargetIndex = index;
					this.clampDetailTarget();
				});
			}
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.openTargetSettings();
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
				if (model) this.renameModelName = model.name;
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
		if (
			this.settingsTarget !== undefined ||
			this.settingsScopeModelId !== undefined
		) {
			this.handleSettingsInput(data);
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

	private renderModelList(view: FailoverTuiView): string[] {
		if (view.config.models.length === 0)
			return [this.theme.fg("warning", "No failover models configured")];
		this.clampSelection();
		const lines: string[] = [];
		const start = this.scrollOffset;
		const end = Math.min(start + MAX_VISIBLE_ROWS, view.config.models.length);
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
		model: GeneratedFailoverModelV8,
	): string[] {
		if (model.chain.length === 0)
			return [this.theme.fg("warning", "No targets configured")];
		this.clampDetailTarget();
		const lines: string[] = [];
		const start = this.detailScrollOffset;
		const end = Math.min(start + MAX_VISIBLE_ROWS, model.chain.length);
		lines.push(
			this.theme.fg(
				"dim",
				`Targets: ${model.chain.length}  Showing ${start + 1}-${end}`,
			),
		);
		const now = Date.now();
		for (let index = start; index < end; index++) {
			const target = model.chain[index];
			if (!target) continue;
			const selected = index === this.detailTargetIndex;
			const key = modelKey(target);
			const enabled = view.targets.get(key)?.settings.enabled !== false;
			lines.push(
				this.theme.fg(
					selected ? "accent" : "text",
					`${selected ? ">" : " "} ${index + 1}. ${key}${enabled ? "" : " [disabled]"}${targetStatus(view.targets.get(key)?.runtime, now)}`,
				),
			);
		}
		if (end < model.chain.length)
			lines.push(
				this.theme.fg(
					"dim",
					`... ${model.chain.length - end} more; use arrows to scroll`,
				),
			);
		return lines;
	}

	private renderAddTargetCandidates(): string[] {
		const candidates = this.addTargetCandidates;
		const selectedIndex = this.addTargetSelectionIndex;
		if (!candidates || selectedIndex === undefined) return [];
		this.clampAddTarget();
		const start = this.addTargetScrollOffset;
		const end = Math.min(start + MAX_VISIBLE_ROWS, candidates.length);
		const selected = candidates[selectedIndex];
		const lines = [
			this.theme.fg(
				"dim",
				`Candidates: ${candidates.length}  Showing ${start + 1}-${end}`,
			),
			...(selected
				? [
						this.theme.fg(
							"accent",
							`Add target ${selectedIndex + 1}/${candidates.length}: ${modelKey(selected)}  Up/Down move  Enter add  Esc cancel`,
						),
					]
				: []),
		];
		for (let index = start; index < end; index++) {
			const target = candidates[index];
			if (!target) continue;
			lines.push(
				this.theme.fg(
					index === selectedIndex ? "accent" : "text",
					`${index === selectedIndex ? ">" : " "} ${index + 1}. ${modelKey(target)}`,
				),
			);
		}
		if (end < candidates.length)
			lines.push(
				this.theme.fg(
					"dim",
					`... ${candidates.length - end} more; use arrows to scroll`,
				),
			);
		return lines;
	}

	private renderDetail(
		view: FailoverTuiView,
		model: GeneratedFailoverModelV8,
	): string[] {
		return [
			this.theme.fg("accent", `Failover Model: ${model.id}`),
			`Name: ${model.name}  Enabled: ${model.enabled ? "yes" : "no"}`,
			this.theme.fg(
				"dim",
				"Enter target settings  t chain settings  a add  d remove  e toggle  [ ] reorder  r reset  Esc back",
			),
			"",
			...this.renderChain(view, model),
			...(this.addTargetSelectionIndex === undefined
				? []
				: this.renderAddTargetCandidates()),
		];
	}

	private renderSettings(width: number): string[] {
		const context = this.settingsContext();
		if (!context) {
			this.closeSettings();
			return [];
		}
		const { lines, add, border } = createPanel(width, this.border);
		const title =
			context.kind === "target"
				? `Target Settings: ${modelKey(context.target)}`
				: `Chain Settings: ${context.model.id}`;
		add(this.theme.fg("accent", title));
		add(coordinationLine(this.getView().coordination));
		add(this.theme.fg("dim", "Up/Down select  Enter edit/cycle  Esc back"));
		add("");
		for (const [index, key] of this.settingsKeys(context).entries()) {
			const selected = index === this.settingsSelectionIndex;
			const value =
				key === "resetTarget" ? "" : `: ${this.settingValue(context, key)}`;
			add(
				this.theme.fg(
					selected ? "accent" : "text",
					`${selected ? ">" : " "} ${SETTING_LABELS[key]}${value}`,
				),
			);
		}
		if (this.behaviorSelectionIndex !== undefined) {
			const modes: readonly string[] =
				context.kind === "target"
					? TARGET_ERROR_HANDLING_MODES
					: ERROR_HANDLING_MODES;
			const choices = modes
				.map((mode, index) => {
					const label =
						mode === "inherit"
							? mode
							: ERROR_HANDLING_LABELS[mode as ErrorHandlingMode];
					return index === this.behaviorSelectionIndex ? `[${label}]` : label;
				})
				.join("  ");
			add(this.theme.fg("accent", `Error behavior: ${choices}`));
			add(this.theme.fg("dim", "Up/Down move  Enter save  Esc cancel"));
		} else if (this.reasoningSelectionIndex !== undefined) {
			const efforts: readonly string[] =
				context.kind === "target" ? TARGET_REASONING_EFFORTS : REASONING_EFFORTS;
			const choices = efforts
				.map((effort, index) =>
					index === this.reasoningSelectionIndex ? `[${effort}]` : effort,
				)
				.join("  ");
			add(this.theme.fg("accent", `Reasoning: ${choices}`));
			add(this.theme.fg("dim", "Up/Down move  Enter save  Esc cancel"));
		} else if (this.settingsInput) {
			add(
				this.theme.fg(
					"accent",
					`Enter ${SETTING_LABELS[this.settingsInput.key]}: ${this.settingsInput.value || "_"}`,
				),
			);
			add(
				this.theme.fg(
					"dim",
					context.kind === "target"
						? "digits or inherit  Enter save  Esc cancel"
						: "digits  Enter save  Esc cancel",
				),
			);
		}
		const lastBorder = border.at(-1);
		if (lastBorder) add(lastBorder);
		return lines.map((line) => padRight(truncateToWidth(line, width, ""), width));
	}

	render(width: number): string[] {
		const view = this.getView();
		if (
			this.settingsTarget !== undefined ||
			this.settingsScopeModelId !== undefined
		) {
			const settings = this.renderSettings(width);
			if (settings.length > 0) return settings;
		}
		const { lines, add, border } = createPanel(width, this.border);
		if (this.addModelName !== undefined) {
			add(this.theme.fg("accent", "Add failover model"));
			add(this.theme.fg("accent", `Name: ${this.addModelName || "_"}`));
			add(this.theme.fg("dim", "type name  Enter create  Esc cancel"));
		} else if (this.renameModelName !== undefined) {
			add(this.theme.fg("accent", "Rename failover model"));
			add(this.theme.fg("accent", `Name: ${this.renameModelName || "_"}`));
			add(this.theme.fg("dim", "type name  Enter save  Esc cancel"));
		} else if (this.detailModelId === undefined) {
			add(this.theme.fg("accent", "Pi Model Failover"));
			add(coordinationLine(view.coordination));
			add(
				this.theme.fg(
					"dim",
					"Enter edit  a add  d remove  e toggle  r rename  q close",
				),
			);
			add("");
			for (const line of this.renderModelList(view)) add(line);
		} else {
			const model = this.detailModel();
			if (model) {
				add(coordinationLine(view.coordination));
				for (const line of this.renderDetail(view, model)) add(line);
			} else {
				this.detailModelId = undefined;
				this.closeSettings();
				add(this.theme.fg("accent", "Pi Model Failover"));
				add(coordinationLine(view.coordination));
				add("");
				for (const line of this.renderModelList(view)) add(line);
			}
		}
		const lastBorder = border.at(-1);
		if (lastBorder) add(lastBorder);
		return lines.map((line) => padRight(truncateToWidth(line, width, ""), width));
	}

	invalidate(): void {
		this.border.invalidate();
	}
}

function historyTimestamp(timestamp: number): string {
	const date = new Date(timestamp);
	const pad = (value: number): string => String(value).padStart(2, "0");
	return Number.isNaN(date.getTime())
		? "---- -- -- --:--:--"
		: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function historyThinking(entry: FailoverHistoryEntry): string {
	if (!entry.reasoningControlled) return "inherited";
	if (!entry.mappedEffort) return "unsupported";
	if (entry.mappedEffort === "none") return "off";
	return entry.mappedEffort;
}

const MAX_VISIBLE_HISTORY = 20;

export class FailoverHistoryPanel implements Component {
	private scrollOffset = 0;
	private readonly border: DynamicBorder;

	constructor(
		private readonly theme: Theme,
		private readonly getHistory: () => readonly FailoverHistoryEntry[],
		private readonly onClose: () => void,
	) {
		this.border = new DynamicBorder((text: string) => theme.fg("accent", text));
	}

	handleInput(data: string): void {
		if (
			matchesKey(data, Key.escape) ||
			data === "q" ||
			matchesKey(data, Key.ctrl("c"))
		) {
			this.onClose();
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
			const maxOffset = Math.max(
				0,
				this.getHistory().length - MAX_VISIBLE_HISTORY,
			);
			this.scrollOffset = Math.max(
				0,
				Math.min(
					maxOffset,
					this.scrollOffset + (matchesKey(data, Key.down) ? 1 : -1),
				),
			);
		}
	}

	render(width: number): string[] {
		const { lines, add, border } = createPanel(width, this.border);
		add(this.theme.fg("accent", "Failover History"));
		add(this.theme.fg("dim", "Esc/q close  Up/Down scroll"));
		add("");
		const history = this.getHistory();
		if (history.length === 0) {
			add(this.theme.fg("dim", "No failover transitions recorded."));
		} else {
			const maxOffset = Math.max(0, history.length - MAX_VISIBLE_HISTORY);
			this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
			const visible = history.slice(
				this.scrollOffset,
				this.scrollOffset + MAX_VISIBLE_HISTORY,
			);
			add(
				this.theme.fg(
					"dim",
					`Showing ${this.scrollOffset + 1}-${this.scrollOffset + visible.length} of ${history.length}`,
				),
			);
			for (const entry of visible) {
				add(
					`${historyTimestamp(entry.timestamp)} ${entry.modelId} ${entry.source ? modelKey(entry.source) : "start"} -> ${modelKey(entry.target)} [${historyThinking(entry)}] ${entry.reason}`,
				);
			}
		}
		const lastBorder = border.at(-1);
		if (lastBorder) add(lastBorder);
		return lines.map((line) => padRight(truncateToWidth(line, width, ""), width));
	}

	invalidate(): void {
		this.border.invalidate();
	}
}
