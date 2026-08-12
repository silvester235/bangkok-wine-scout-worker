export interface LineMessageContent {
	content: ArrayBuffer;
	contentType: string;
}

export class LineContentDownloadError extends Error {
	readonly retryable:boolean;
	constructor(readonly status:number){
		super(`line_content_${status===404||status===410?'unavailable':'download_failed'}_http_${status}`);
		this.name='LineContentDownloadError';
		this.retryable=status===408||status===409||status===425||status===429||status>=500;
	}
}

export async function downloadLineMessageContent(
	messageId: string,
	accessToken: string,
): Promise<LineMessageContent> {
	const response = await fetch(
		`https://api-data.line.me/v2/bot/message/${encodeURIComponent(messageId)}/content`,
		{
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
		},
	);

	if (!response.ok) {
		await response.body?.cancel().catch(()=>undefined);
		throw new LineContentDownloadError(response.status);
	}

	return {
		content: await response.arrayBuffer(),
		contentType: response.headers.get('content-type') ?? 'application/octet-stream',
	};
}

export async function replyToLine(
	replyToken: string,
	text: string,
	accessToken: string,
): Promise<void> {
	const response = await fetch('https://api.line.me/v2/bot/message/reply', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${accessToken}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			replyToken,
			messages: [{ type: 'text', text }],
		}),
	});

	if (!response.ok) {
		const errorBody = await response.text();
		throw new Error(
			`LINE Reply API failed: ${response.status} ${errorBody}`,
		);
	}
}

export async function pushToLine(
	to: string,
	text: string,
	accessToken: string,
): Promise<void> {
	const response = await fetch('https://api.line.me/v2/bot/message/push', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${accessToken}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			to,
			messages: [{ type: 'text', text }],
		}),
	});

	if (!response.ok) {
		const errorBody = await response.text();
		throw new Error(
			`LINE Push API failed: ${response.status} ${errorBody}`,
		);
	}
}
