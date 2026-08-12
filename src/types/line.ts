export interface LineEventSource {
	userId?: string;
	groupId?: string;
	roomId?: string;
}

export interface LineTextMessageEvent {
	type: 'message';
	webhookEventId?: string;
	replyToken: string;
	timestamp?: number;
	source?: LineEventSource;
	message: {
		id: string;
		type: 'text';
		text: string;
	};
}

export interface LineImageMessageEvent {
	type: 'message';
	webhookEventId?: string;
	replyToken: string;
	timestamp?: number;
	source?: LineEventSource;
	message: {
		id: string;
		type: 'image';
		imageSet?: {id:string;index?:number;total?:number};
		contentProvider?: {
			type: 'line' | 'external';
			originalContentUrl?: string;
			previewImageUrl?: string;
		};
	};
}

export type LineWebhookEvent =
	| LineTextMessageEvent
	| LineImageMessageEvent
	| Record<string, unknown>;

export interface LineWebhookPayload {
	destination?: string;
	events?: LineWebhookEvent[];
}
