import { handlePublicApi } from './routes/events';
import { handleHealth } from './routes/health';
import { handleHome } from './routes/home';
import { handleWebhook, processImageMessage, type ImageProcessingMessage } from './routes/webhook';
import { processImageBatch, type BatchProcessingMessage } from './services/line-image-batch-processing';
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

		if (url.pathname.startsWith('/api/')) {
			return handlePublicApi(request, env);
		}

		if (request.method === 'POST' && url.pathname === '/webhook') {
			return handleWebhook(request, env);
		}

		return notFoundResponse();
	},

	async queue(batch: MessageBatch<ImageProcessingMessage|BatchProcessingMessage>, env: WorkerEnv): Promise<void> {
		for (const message of batch.messages) {
			try {
				if(message.body.type==='process_batch') await processImageBatch(message.body,env);
				else await processImageMessage(message.body, env);
				message.ack();
			} catch (error) {
				console.error('IMAGE PROCESSING FAILED:', error);
				message.retry();
			}
		}
	},
} satisfies ExportedHandler<WorkerEnv, ImageProcessingMessage|BatchProcessingMessage>;
