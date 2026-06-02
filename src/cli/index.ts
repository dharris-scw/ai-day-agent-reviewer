#!/usr/bin/env node

import { resolveCliOptions } from './args.js';
import type { CliOptions } from './types.js';

export function getCliOptions(
  argv: readonly string[] = process.argv.slice(2),
  environment = process.env,
): CliOptions {
  return resolveCliOptions(argv, environment);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = getCliOptions();
  process.stdout.write(`${JSON.stringify(options, null, 2)}\n`);
}
