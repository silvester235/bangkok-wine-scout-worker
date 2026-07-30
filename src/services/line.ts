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
