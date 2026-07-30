import type { CommandHandler } from './types';

export const helpCommand: CommandHandler = () =>
	[
		'🍷 Bangkok Wine Scout commands',
		'',
		'help — show this list',
		'about — what Bangkok Wine Scout does',
		'version — show the current version',
		'ping — check whether the bot is online',
	].join('\n');
