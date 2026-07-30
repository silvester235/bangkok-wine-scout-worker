export interface LineMessageContent {
	content: ArrayBuffer;
	contentType: string;
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
		const errorBody = await response.text();
		throw new Error(
			`LINE Content API failed: ${response.status} ${errorBody}`,
		);
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
