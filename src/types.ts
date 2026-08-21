export const REASONING_EFFORTS = [
	"off",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const ERROR_HANDLING_MODES = ["smart", "switch", "retry"] as const;

export type ErrorHandlingMode = (typeof ERROR_HANDLING_MODES)[number];

export interface ModelRef {
	provider: string;
	id: string;
}

export function modelKey(model: ModelRef): string {
	return `${model.provider}/${model.id}`;
}

export const MODEL_PARAMETER_NAMES = [
	"promptCacheKey",
	"promptCacheRetention",
	"reasoningEffort",
	"sessionAffinity",
] as const;

export type ModelParameterName = (typeof MODEL_PARAMETER_NAMES)[number];

/** Per-model toggles controlling which request parameters the extension injects. */
export interface ModelParameterToggles {
	promptCacheKey: boolean;
	promptCacheRetention: boolean;
	reasoningEffort: boolean;
	sessionAffinity: boolean;
}

export interface FailoverConfig {
	version: 5;
	enabled: boolean;
	paused: boolean;
	models: ModelRef[];
	reasoningEffort: ReasoningEffort;
	cooldownMinutes: number;
	errorHandlingMode: ErrorHandlingMode;
	maxRetries: number;
	noProgressTimeoutSeconds: number;
	manualRecovery: Record<string, string>;
	/** Per-model parameter toggles keyed by modelKey(provider/id); absent = all on. */
	modelParameters: Record<string, ModelParameterToggles>;
	/** Per-model reasoning levels keyed by modelKey(provider/id); absent = global fallback. */
	modelReasoningEfforts: Record<string, ReasoningEffort>;
}

export type AutomationMode = "enabled" | "paused" | "disabled";
export type ProgressAttemptKind =
	| "initial"
	| "native-retry"
	| "extension-continuation";

export type FailureKind =
	| "persistent"
	| "cooldown"
	| "unknown"
	| "no-progress"
	| "cancelled"
	| "tool-failure"
	| "none";

export interface FailureInput {
	status?: number;
	message?: string;
	stopReason?: string;
	timedOut?: boolean;
	toolError?: boolean;
}

export interface FailureClassification {
	kind: FailureKind;
	reason: string;
}

export interface RequestState {
	id: number;
	attempted: Set<string>;
	reasons: Map<string, string>;
	sameModelRetries: number;
	activeModel?: ModelRef;
	completed: boolean;
}

export interface Transition {
	source?: ModelRef;
	target?: ModelRef;
	reason: string;
	at: number;
}
