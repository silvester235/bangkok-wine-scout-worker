import { aboutCommand } from './about';
import { helpCommand } from './help';
import { pingCommand } from './ping';
import type { CommandHandler } from './types';
import { versionCommand } from './version';

const commands: Record<string, CommandHandler> = {
	about: aboutCommand,
	help: helpCommand,
	ping: pingCommand,
	version: versionCommand,
};

export function routeCommand(input: string): string {
	const commandName = input.trim().toLowerCase().replace(/^\//, '');
	const command = commands[commandName];

	if (command) {
		return command();
	}

	return `👋 Bangkok Wine Scout received:\n\n${input}\n\nSend "help" to see available commands.`;
}
