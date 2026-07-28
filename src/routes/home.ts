import { APP_NAME } from '../config';
import { textResponse } from '../utils/responses';

export function handleHome(): Response {
	return textResponse(`${APP_NAME} is running.`);
}
