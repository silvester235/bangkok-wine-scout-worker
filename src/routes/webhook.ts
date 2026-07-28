import { APP_NAME, VERSION } from '../config';
import type { WebhookPayload } from '../types/webhook';

export async function handleWebhook(request: Request): Promise<Response> {
	try {
		const body = (await request.json()) as WebhookPayload;

		console.log(JSON.stringify(body, null, 2));

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
				message: 'Invalid request body',
				service: APP_NAME,
				version: VERSION,
				timestamp: new Date().toISOString(),
			},
			{
				status: 400,
			},
		);
	}
}
