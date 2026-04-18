const FLAG_NAMES_WITH_VALUES = new Set([
  '--since',
  '-s',
  '--until',
  '-u',
  '--api-url',
  '--token',
]);

export interface ResolvedCliArgs {
  command: string;
  bareToken?: string;
  unknownCommand?: string;
  positionals: string[];
}

export function isSubmitToken(value: string): boolean {
  return /^(?:bematist|bm|pharos)_[A-Za-z0-9][A-Za-z0-9-]*$/.test(value);
}

export function getPositionalArgs(args: string[]): string[] {
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg.startsWith('--') && arg.includes('=')) continue;
    if (FLAG_NAMES_WITH_VALUES.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith('-')) continue;

    positionals.push(arg);
  }

  return positionals;
}

export function resolveCliArgs(
  args: string[],
  commands: ReadonlySet<string>,
): ResolvedCliArgs {
  if (args.includes('--help') || args.includes('-h')) {
    return { command: 'help', positionals: [] };
  }

  const positionals = getPositionalArgs(args);
  const first = positionals[0];

  if (!first) {
    return { command: 'summary', positionals };
  }

  if (commands.has(first)) {
    return { command: first, positionals };
  }

  if (positionals.length === 1 && isSubmitToken(first)) {
    return { command: 'submit', bareToken: first, positionals };
  }

  return { command: 'unknown', unknownCommand: first, positionals };
}
