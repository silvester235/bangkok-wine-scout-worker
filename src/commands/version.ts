import { APP_NAME, VERSION } from '../config';
import type { CommandHandler } from './types';

export const versionCommand: CommandHandler = () =>
	`${APP_NAME} v${VERSION}`;
