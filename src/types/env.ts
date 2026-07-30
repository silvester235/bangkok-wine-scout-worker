export interface WorkerEnv {
	LINE_CHANNEL_ACCESS_TOKEN: string;
	EVENT_INTAKES: R2Bucket;
	EVENTS_DB: D1Database;
	AI: Ai;
}
