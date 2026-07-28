export function textResponse(body: string, status = 200): Response {
	return new Response(body, {
		status,
		headers: {
			'content-type': 'text/plain; charset=UTF-8',
		},
	});
}

export function notFoundResponse(): Response {
	return textResponse('Not found', 404);
}
