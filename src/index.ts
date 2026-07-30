import { handleHealth } from './routes/health';
import { handleHome } from './routes/home';
import { handleWebhook } from './routes/webhook';
import { notFoundResponse } from './utils/responses';

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === 'GET' && url.pathname === '/') {
			return handleHome();
		}

		if (request.method === 'GET' && url.pathname === '/health') {
			return handleHealth();
		}

		if (request.method === 'POST' && url.pathname === '/webhook') {
			return handleWebhook(request, env, ctx);
		}

		return notFoundResponse();
	},
} satisfies ExportedHandler<Env>;
