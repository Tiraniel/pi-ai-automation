import { asArray, asBoolean, asInteger, asRecord, asString, asThinkingLevel } from "./guards.js";
import type {
	DeepPlanningConfig,
	DeepPlanningPlannerConfig,
} from "../types.js";

function normalizePlannerCount(value: unknown): number | undefined {
	const count = asInteger(value);
	if (count === undefined) return undefined;
	return Math.max(1, count);
}

function hasPlannerData(planner: DeepPlanningPlannerConfig): boolean {
	return [
		planner.id,
		planner.role,
		planner.provider,
		planner.model,
		planner.modelPreset,
		planner.thinkingLevel,
		planner.instructions,
	].some((value) => value !== undefined);
}

function normalizeDeepPlanningPlanner(value: unknown): DeepPlanningPlannerConfig | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const planner: DeepPlanningPlannerConfig = {};
	const id = asString(record.id);
	if (id !== undefined && id.trim()) planner.id = id.trim();
	const role = asString(record.role);
	if (role !== undefined && role.trim()) planner.role = role.trim();
	const provider = asString(record.provider);
	if (provider !== undefined && provider.trim()) planner.provider = provider.trim();
	const model = asString(record.model);
	if (model !== undefined && model.trim()) planner.model = model.trim();
	const modelPreset = asString(record.modelPreset);
	if (modelPreset !== undefined && modelPreset.trim()) planner.modelPreset = modelPreset.trim();
	const thinkingLevel = asThinkingLevel(record.thinkingLevel);
	if (thinkingLevel !== undefined) planner.thinkingLevel = thinkingLevel;
	const instructions = asString(record.instructions);
	if (instructions !== undefined && instructions.trim()) planner.instructions = instructions.trim();
	return hasPlannerData(planner) ? planner : undefined;
}

function normalizePlanners(value: unknown): DeepPlanningPlannerConfig[] | undefined {
	const raw = asArray(value);
	if (!raw) return undefined;
	const planners: DeepPlanningPlannerConfig[] = [];
	for (const entry of raw) {
		const planner = normalizeDeepPlanningPlanner(entry);
		if (planner) planners.push(planner);
	}
	return planners.length ? planners : undefined;
}

export function normalizeDeepPlanning(value: unknown): DeepPlanningConfig | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const config: DeepPlanningConfig = {};
	const enabled = asBoolean(record.enabled);
	if (enabled !== undefined) config.enabled = enabled;
	const plannerCount = normalizePlannerCount(record.plannerCount);
	if (plannerCount !== undefined) config.plannerCount = plannerCount;
	const maxConcurrency = normalizePlannerCount(record.maxConcurrency);
	if (maxConcurrency !== undefined) config.maxConcurrency = maxConcurrency;
	const rounds = normalizePlannerCount(record.rounds);
	if (rounds !== undefined) config.rounds = rounds;
	const roomIdPrefix = asString(record.roomIdPrefix);
	if (roomIdPrefix !== undefined && roomIdPrefix.trim()) config.roomIdPrefix = roomIdPrefix.trim().toLowerCase();
	const planners = normalizePlanners(record.planners);
	if (planners !== undefined) config.planners = planners;
	const verifier = asBoolean(record.verifier);
	if (verifier !== undefined) config.verifier = verifier;
	return Object.keys(config).length ? config : undefined;
}

export function readDeepPlanningConfig(record: Record<string, unknown>): DeepPlanningConfig | undefined {
	const canonical = normalizeDeepPlanning(record.deepPlanning);
	if (canonical) return canonical;
	return normalizeDeepPlanning(record.deep_planning);
}
