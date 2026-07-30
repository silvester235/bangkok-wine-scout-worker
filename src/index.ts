import { handleEvents } from './routes/events';
import { handleHealth } from './routes/health';
import { handleHome } from './routes/home';
import { handleWebhook, processImageMessage, type ImageProcessingMessage } from './routes/webhook';
import type { WorkerEnv } from './types/env';
import { notFoundResponse } from './utils/responses';

export default {
	async fetch(request, env: WorkerEnv): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === 'GET' && url.pathname === '/') {
			return handleHome();
		}

		if (request.method === 'GET' && url.pathname === '/health') {
			return handleHealth();
		}

		if (request.method === 'GET' && url.pathname === '/api/events') {
			return handleEvents(env);
		}

		if (request.method === 'POST' && url.pathname === '/webhook') {
			return handleWebhook(request, env);
		}

		return notFoundResponse();
	},

	async queue(batch: MessageBatch<ImageProcessingMessage>, env: WorkerEnv): Promise<void> {
		for (const message of batch.messages) {
			try {
				await processImageMessage(message.body, env);
				message.ack();
			} catch (error) {
				console.error('IMAGE PROCESSING FAILED:', error);
				message.retry();
			}
		}
	},
} satisfies ExportedHandler<WorkerEnv, ImageProcessingMessage>;
