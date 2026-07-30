import { APP_NAME, VERSION } from '../config';
import type { WebhookPayload } from '../types/webhook';

interface Env {
	LINE_CHANNEL_ACCESS_TOKEN: string;
}

interface LineTextEvent {
	type: 'message';
	replyToken: string;
	message: {
		type: 'text';
		text: string;
	};
}

async function replyToLine(
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
			messages: [
				{
					type: 'text',
					text,
				},
			],
		}),
	});

	if (!response.ok) {
		const errorBody = await response.text();
		throw new Error(
			`LINE Reply API failed: ${response.status} ${errorBody}`,
		);
	}
}

interface Env {
	LINE_CHANNEL_ACCESS_TOKEN: string;
}
async function replyMessage(
	replyToken: string,
	text: string,
	env: Env,
): Promise<void> {
	await fetch('https://api.line.me/v2/bot/message/reply', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
		},
		body: JSON.stringify({
			replyToken,
			messages: [
				{
					type: 'text',
					text,
				},
			],
		}),
	});
}

export async function handleWebhook(
	request: Request,
	env: Env,
): Promise<Response> {
	try {
		const body = (await request.json()) as WebhookPayload;

		console.log(JSON.stringify(body, null, 2));
const event = body.events?.[0] as LineTextEvent | undefined;

if (
	event?.type === 'message' &&
	event.message?.type === 'text' &&
	event.replyToken
) {
	await replyMessage(
		event.replyToken,
		`👋 Bangkok Wine Scout received:\n\n${event.message.text}`,
		env,
	);
}
		for (const event of body.events ?? []) {
			const lineEvent = event as LineTextEvent;

			if (
				lineEvent.type === 'message' &&
				lineEvent.message?.type === 'text'
			) {
				await replyToLine(
					lineEvent.replyToken,
					`👋 Bangkok Wine Scout received:\n\n${lineEvent.message.text}`,
					env.LINE_CHANNEL_ACCESS_TOKEN,
				);
			}
		}

		return Response.json({
			status: 'ok',
			received: true,
			service: APP_NAME,
			version: VERSION,
			timestamp: new Date().toISOString(),
		});
	} catch (error) {
		console.error('Webhook error:', error);

		return Response.json(
			{
				status: 'error',
				message: 'Webhook processing failed',
				service: APP_NAME,
				version: VERSION,
				timestamp: new Date().toISOString(),
			},
			{
				status: 500,
			},
		);
	}
}
