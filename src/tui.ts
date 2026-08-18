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
	ModelRef,
	AutomationMode,
	ReasoningEffort,
	Transition,
} from "./types.ts";
import { modelKey, REASONING_EFFORTS } from "./types.ts";

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
	onSetTimeout: (value: string) => Promise<void>;
	onSetReasoningEffort: (effort: ReasoningEffort) => Promise<void>;
	onRestore: () => Promise<void>;
}

export function runTuiAction(
	action: () => Promise<void>,
	onError: (error: unknown) => void,
): void {
	void Promise.resolve().then(action).catch(onError);
}

function padRight(text: string, width: number): string {
	if (visibleWidth(text) >= width) return truncateToWidth(text, width, "");
	return text + " ".repeat(width - visibleWidth(text));
}

const MAX_VISIBLE_MODELS = 20;

export class FailoverEditor implements Component {
	private selectedIndex = 0;
	private scrollOffset = 0;
	private reasoningSelectionIndex: number | undefined;
	private addCandidates: readonly ModelRef[] | undefined;
	private addSelectionIndex: number | undefined;
	private timeoutInput: string | undefined;
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
		this.actionQueue = this.actionQueue.then(action).catch(this.actions.onError);
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

	handleInput(data: string): void {
		const view = this.getView();
		if (this.addSelectionIndex !== undefined && this.addCandidates) {
			if (
				matchesKey(data, Key.escape) ||
				data === "q" ||
				matchesKey(data, Key.ctrl("c"))
			) {
				this.addCandidates = undefined;
				this.addSelectionIndex = undefined;
				return;
			}
			if (matchesKey(data, Key.up)) {
				this.addSelectionIndex = Math.max(0, this.addSelectionIndex - 1);
				return;
			}
			if (matchesKey(data, Key.down)) {
				this.addSelectionIndex = Math.min(
					this.addCandidates.length - 1,
					this.addSelectionIndex + 1,
				);
				return;
			}
			if (matchesKey(data, Key.enter)) {
				const model = this.addCandidates[this.addSelectionIndex];
				this.addCandidates = undefined;
				this.addSelectionIndex = undefined;
				if (model) this.runAction(() => this.actions.onAdd(model));
			}
			return;
		}
		if (this.timeoutInput !== undefined) {
			if (
				matchesKey(data, Key.escape) ||
				data === "q" ||
				matchesKey(data, Key.ctrl("c"))
			) {
				this.timeoutInput = undefined;
				return;
			}
			if (matchesKey(data, Key.backspace)) {
				this.timeoutInput = this.timeoutInput.slice(0, -1);
				return;
			}
			if (matchesKey(data, Key.enter)) {
				const value = this.timeoutInput;
				this.timeoutInput = undefined;
				this.runAction(() => this.actions.onSetTimeout(value));
				return;
			}
			if (/^\d+$/.test(data)) this.timeoutInput += data;
			return;
		}
		if (this.reasoningSelectionIndex !== undefined) {
			if (
				matchesKey(data, Key.escape) ||
				data === "q" ||
				matchesKey(data, Key.ctrl("c"))
			) {
				this.reasoningSelectionIndex = undefined;
				return;
			}
			if (matchesKey(data, Key.up)) {
				this.reasoningSelectionIndex = Math.max(
					0,
					this.reasoningSelectionIndex - 1,
				);
				return;
			}
			if (matchesKey(data, Key.down)) {
				this.reasoningSelectionIndex = Math.min(
					REASONING_EFFORTS.length - 1,
					this.reasoningSelectionIndex + 1,
				);
				return;
			}
			if (matchesKey(data, Key.enter)) {
				const effort = REASONING_EFFORTS[this.reasoningSelectionIndex];
				this.reasoningSelectionIndex = undefined;
				if (effort) {
					this.runAction(() => this.actions.onSetReasoningEffort(effort));
				}
			}
			return;
		}
		if (
			matchesKey(data, Key.escape) ||
			data === "q" ||
			matchesKey(data, Key.ctrl("c"))
		) {
			this.actions.onClose();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.clampSelection();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.selectedIndex = Math.min(
				Math.max(0, view.models.length - 1),
				this.selectedIndex + 1,
			);
			this.clampSelection();
			return;
		}
		if (matchesKey(data, Key.leftbracket)) {
			const index = this.selectedIndex;
			this.runAction(() => this.actions.onMove(index, -1));
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			return;
		}
		if (matchesKey(data, Key.rightbracket)) {
			const index = this.selectedIndex;
			this.runAction(() => this.actions.onMove(index, 1));
			this.selectedIndex = Math.min(
				Math.max(0, view.models.length - 1),
				this.selectedIndex + 1,
			);
			return;
		}
		if (data === "a") {
			const configured = new Set(view.models.map(modelKey));
			const candidates = view.available.filter(
				(model) => !configured.has(modelKey(model)),
			);
			if (candidates.length > 0) {
				this.addCandidates = candidates;
				this.addSelectionIndex = 0;
			}
			return;
		}
		if (data === "d") {
			const index = this.selectedIndex;
			const model = this.selectedModel();
			if (model) this.runAction(() => this.actions.onRemove(index));
			return;
		}
		if (data === "e") {
			this.runAction(this.actions.onToggleEnabled);
			return;
		}
		if (data === "t") {
			this.timeoutInput = "";
			return;
		}
		if (data === "i") {
			const currentIndex = REASONING_EFFORTS.indexOf(view.config.reasoningEffort);
			this.reasoningSelectionIndex = currentIndex >= 0 ? currentIndex : 0;
			return;
		}
		if (data === "r") {
			this.runAction(this.actions.onRestore);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			const model = this.selectedModel();
			if (model) this.runAction(() => this.actions.onSelect(model));
		}
	}

	render(width: number): string[] {
		const view = this.getView();
		this.clampSelection();
		const lines: string[] = [];
		const add = (line: string) =>
			lines.push(truncateToWidth(line, Math.max(1, width), ""));
		const border = this.border.render(width);
		if (border[0]) add(border[0]);
		add(this.theme.fg("accent", "Pi Model Failover"));
		add(
			`Automation: ${view.mode}  Timeout: ${view.config.noProgressTimeoutSeconds === 0 ? "off" : `${view.config.noProgressTimeoutSeconds}s`}  Reasoning: ${view.config.reasoningEffort}`,
		);
		add(`Current: ${view.current ? modelKey(view.current) : "none"}`);
		add(
			this.theme.fg(
				"dim",
				"Enter select  a add  d remove  [ ] reorder  e toggle  t timeout  i reasoning  r restore  q close",
			),
		);
		if (this.reasoningSelectionIndex !== undefined) {
			const choices = REASONING_EFFORTS.map((effort, index) =>
				index === this.reasoningSelectionIndex ? `[${effort}]` : effort,
			).join("  ");
			add(
				this.theme.fg(
					"accent",
					`Select reasoning: ${choices}  ↑↓ move  Enter select  Esc cancel`,
				),
			);
		}
		if (this.timeoutInput !== undefined) {
			add(
				this.theme.fg(
					"accent",
					`Enter timeout: ${this.timeoutInput || "_"}  digits  Enter save  Esc cancel`,
				),
			);
		}
		if (this.addSelectionIndex !== undefined && this.addCandidates) {
			const model = this.addCandidates[this.addSelectionIndex];
			if (model) {
				add(
					this.theme.fg(
						"accent",
						`Add model ${this.addSelectionIndex + 1}/${this.addCandidates.length}: ${modelKey(model)}  ↑↓ move  Enter add  Esc cancel`,
					),
				);
			}
		}
		add("");
		if (view.models.length === 0) {
			add(this.theme.fg("warning", "No models configured"));
		} else {
			const start = this.scrollOffset;
			const end = Math.min(start + MAX_VISIBLE_MODELS, view.models.length);
			add(
				this.theme.fg(
					"dim",
					`Models: ${view.models.length}  Showing ${start + 1}-${end}`,
				),
			);
			for (let index = start; index < end; index++) {
				const model = view.models[index];
				if (!model) continue;
				const key = modelKey(model);
				const selected = index === this.selectedIndex;
				const current = view.current && modelKey(view.current) === key ? " *" : "";
				const cooldown = view.cooldowns.get(key);
				const recovery = view.manualRecovery.get(key);
				const status =
					cooldown && cooldown > Date.now()
						? ` cooldown ${Math.ceil((cooldown - Date.now()) / 60000)}m`
						: recovery
							? ` manual recovery: ${recovery}`
							: "";
				add(
					this.theme.fg(
						selected ? "accent" : "text",
						`${selected ? ">" : " "} ${index + 1}. ${key}${current}${status}`,
					),
				);
			}
			if (end < view.models.length) {
				add(
					this.theme.fg(
						"dim",
						`... ${view.models.length - end} more; use arrows to scroll`,
					),
				);
			}
		}
		if (view.latestTransition) {
			const source = view.latestTransition.source
				? modelKey(view.latestTransition.source)
				: "none";
			const target = view.latestTransition.target
				? modelKey(view.latestTransition.target)
				: "none";
			add(
				this.theme.fg(
					"dim",
					`Last: ${source} -> ${target} (${view.latestTransition.reason})`,
				),
			);
		}
		if (view.exhaustionSummary)
			add(this.theme.fg("error", `Exhausted: ${view.exhaustionSummary}`));
		if (border[border.length - 1]) add(border[border.length - 1]!);
		return lines.map((line) => padRight(truncateToWidth(line, width, ""), width));
	}

	invalidate(): void {
		this.border.invalidate();
	}
}
