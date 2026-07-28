import { APP_NAME, VERSION } from '../config';

export function handleHealth(): Response {
	return Response.json({
		status: 'ok',
		service: APP_NAME,
		version: VERSION,
		timestamp: new Date().toISOString(),
	});
}
