import { APP_NAME, VERSION } from '../config';
import { routeCommand } from '../commands/router';
import { replyToLine } from '../services/line';
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

export async function handleWebhook(
	request: Request,
	env: Env,
): Promise<Response> {
	try {
		const body = (await request.json()) as WebhookPayload;

		console.log(JSON.stringify(body, null, 2));

		for (const event of body.events ?? []) {
			const lineEvent = event as LineTextEvent;

			if (
				lineEvent.type === 'message' &&
				lineEvent.message?.type === 'text' &&
				lineEvent.replyToken
			) {
				const replyText = routeCommand(lineEvent.message.text);

				await replyToLine(
					lineEvent.replyToken,
					replyText,
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
