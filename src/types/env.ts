export interface WorkerEnv {
	LINE_CHANNEL_ACCESS_TOKEN: string;
	EVENT_INTAKES: R2Bucket;
	DB: D1Database;
	AI: Ai;
	IMAGE_PROCESSING_QUEUE: Queue;
	AI_PROVIDER: string;
	AI_MODEL: string;
	HIGH_THRESHOLD: string;
	LOW_THRESHOLD: string;
	AI_TIMEOUT_MS: string;
	LINE_TEXT_CONTEXT_WINDOW_SECONDS: string;
}
