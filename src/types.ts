export const REASONING_EFFORTS = [
	"off",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface ModelRef {
	provider: string;
	id: string;
}

export function modelKey(model: ModelRef): string {
	return `${model.provider}/${model.id}`;
}

export function modelLabel(model: ModelRef): string {
	return modelKey(model);
}

export interface FailoverConfig {
	version: 2;
	enabled: boolean;
	paused: boolean;
	models: ModelRef[];
	reasoningEffort: ReasoningEffort;
	noProgressTimeoutSeconds: number;
	manualRecovery: Record<string, string>;
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
	sameModelContinuationUsed: boolean;
	activeModel?: ModelRef;
	completed: boolean;
}

export interface Transition {
	source?: ModelRef;
	target?: ModelRef;
	reason: string;
	at: number;
}
