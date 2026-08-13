export interface WorkerEnv {
	LINE_CHANNEL_ACCESS_TOKEN: string;
	EVENT_INTAKES: R2Bucket;
	DB: D1Database;
	AI: Ai;
	IMAGE_PROCESSING_QUEUE: Queue;
	AI_PROVIDER: string;
	AI_MODEL: string;
	EDITORIAL_VISION_MODEL?: string;
	CLOUDFLARE_ACCOUNT_ID?: string;
	HIGH_THRESHOLD: string;
	LOW_THRESHOLD: string;
	AI_TIMEOUT_MS: string;
	LINE_TEXT_CONTEXT_WINDOW_SECONDS: string;
	LINE_IMAGE_BATCH_WINDOW_SECONDS: string;
	LINE_MESSAGE_BATCH_WINDOW_SECONDS?: string;
	AGENT_SUBMISSION_WINDOW_SECONDS?: string;
	AGENT_DONE_SETTLEMENT_SECONDS?: string;
	LINE_V2_CHANNEL_SECRET?: string;
	LINE_V2_CHANNEL_ACCESS_TOKEN?: string;
	WINE_SCOUT_SUBMISSION_WORKFLOW?: Workflow<{submissionId:string}>;
	PUBLIC_SITE_ORIGIN?: string;
	ENABLE_PUBLIC_EVENT_PAGES?: string;
	INGESTION_MODE?: string;
	V2_PUBLICATION_ENABLED?: string;
	/** Secret Bearer token for authenticated administrator endpoints. */
	ADMIN_API_TOKEN?: string;
	/** LINE user ID that receives private new-event notifications. */
	ADMIN_LINE_USER_ID?: string;
}
