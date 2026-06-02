import type {
  CliOptions,
  EnvironmentSource,
  ParsedCliArguments,
  ReviewLevel,
  RepoRef,
} from './types.js';

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_MAX_FILES = 40;
const DEFAULT_MAX_LINES = 1500;
const DEFAULT_HOST = 'github.com';
const DEFAULT_REVIEW_LEVEL: ReviewLevel = 'normal';
const REVIEW_LEVELS = new Set<ReviewLevel>(['light', 'normal', 'deep']);

const FLAG_NAMES = new Set([
  '--repo',
  '--pr',
  '--org',
  '--dry-run',
  '--no-approve',
  '--concurrency',
  '--max-files',
  '--max-lines',
  '--model',
  '--review-level',
]);

export class CliArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliArgumentError';
  }
}

export function parseCliArgs(argv: readonly string[]): ParsedCliArguments {
  const args: ParsedCliArguments = {
    dryRun: false,
    noApprove: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }

    if (!token.startsWith('--')) {
      throw new CliArgumentError(`Unexpected positional argument: ${token}`);
    }

    const [flag, inlineValue] = splitFlagToken(token);

    if (!FLAG_NAMES.has(flag)) {
      throw new CliArgumentError(`Unknown flag: ${flag}`);
    }

    switch (flag) {
      case '--dry-run':
        assertBooleanFlag(flag, inlineValue);
        args.dryRun = true;
        break;
      case '--no-approve':
        assertBooleanFlag(flag, inlineValue);
        args.noApprove = true;
        break;
      case '--repo':
        args.repo = consumeStringValue(flag, inlineValue, argv, () => {
          index += 1;
          return argv[index];
        });
        break;
      case '--org':
        args.org = consumeStringValue(flag, inlineValue, argv, () => {
          index += 1;
          return argv[index];
        });
        break;
      case '--model':
        args.model = consumeStringValue(flag, inlineValue, argv, () => {
          index += 1;
          return argv[index];
        });
        break;
      case '--review-level':
        args.reviewLevel = consumeReviewLevelValue(flag, inlineValue, argv, () => {
          index += 1;
          return argv[index];
        });
        break;
      case '--pr':
        args.pr = consumeIntegerValue(flag, inlineValue, argv, () => {
          index += 1;
          return argv[index];
        });
        break;
      case '--concurrency':
        args.concurrency = consumeIntegerValue(flag, inlineValue, argv, () => {
          index += 1;
          return argv[index];
        });
        break;
      case '--max-files':
        args.maxFiles = consumeIntegerValue(flag, inlineValue, argv, () => {
          index += 1;
          return argv[index];
        });
        break;
      case '--max-lines':
        args.maxLines = consumeIntegerValue(flag, inlineValue, argv, () => {
          index += 1;
          return argv[index];
        });
        break;
      default:
        throw new CliArgumentError(`Unhandled flag: ${flag}`);
    }
  }

  return args;
}

export function resolveCliOptions(
  argv: readonly string[],
  environment: EnvironmentSource,
): CliOptions {
  const parsed = parseCliArgs(argv);
  const repo = parsed.repo
    ? parseRepoRef(parsed.repo, environment.GH_HOST ?? DEFAULT_HOST)
    : undefined;
  const model = parsed.model ?? readNonEmptyString(environment.OPENAI_MODEL);

  if (!model) {
    throw new CliArgumentError(
      'Missing model. Set --model or OPENAI_MODEL.',
    );
  }

  if (parsed.pr !== undefined && repo === undefined) {
    throw new CliArgumentError('--pr requires --repo.');
  }

  if (parsed.org && repo && parsed.org !== repo.owner) {
    throw new CliArgumentError(
      `--org=${parsed.org} does not match repository owner ${repo.owner}.`,
    );
  }

  const concurrency =
    parsed.concurrency ??
    parseEnvInteger(
      environment.AGENT_REVIEW_CONCURRENCY,
      'AGENT_REVIEW_CONCURRENCY',
      DEFAULT_CONCURRENCY,
    );
  const maxFiles =
    parsed.maxFiles ??
    parseEnvInteger(
      environment.AGENT_REVIEW_MAX_FILES,
      'AGENT_REVIEW_MAX_FILES',
      DEFAULT_MAX_FILES,
    );
  const maxLines =
    parsed.maxLines ??
    parseEnvInteger(
      environment.AGENT_REVIEW_MAX_LINES,
      'AGENT_REVIEW_MAX_LINES',
      DEFAULT_MAX_LINES,
    );

  return {
    repo,
    pr: parsed.pr,
    org: parsed.org,
    dryRun: parsed.dryRun,
    noApprove: parsed.noApprove,
    concurrency,
    maxFiles,
    maxLines,
    model,
    reviewLevel: parsed.reviewLevel ?? DEFAULT_REVIEW_LEVEL,
  };
}

export function parseRepoRef(input: string, defaultHost = DEFAULT_HOST): RepoRef {
  const value = readNonEmptyString(input);

  if (!value) {
    throw new CliArgumentError('Repository value must not be empty.');
  }

  const parts = value.split('/').filter((part) => part.length > 0);

  if (parts.length === 2) {
    const [owner, repo] = parts;
    return { host: defaultHost, owner, repo };
  }

  if (parts.length === 3) {
    const [host, owner, repo] = parts;
    return { host, owner, repo };
  }

  throw new CliArgumentError(
    `Invalid repository "${input}". Expected owner/repo or host/owner/repo.`,
  );
}

function splitFlagToken(token: string): [string, string | undefined] {
  const equalsIndex = token.indexOf('=');

  if (equalsIndex === -1) {
    return [token, undefined];
  }

  return [token.slice(0, equalsIndex), token.slice(equalsIndex + 1)];
}

function consumeStringValue(
  flag: string,
  inlineValue: string | undefined,
  _argv: readonly string[],
  consumeNext: () => string | undefined,
): string {
  const value = inlineValue ?? consumeNext();

  if (value === undefined || value.startsWith('--')) {
    throw new CliArgumentError(`Missing value for ${flag}.`);
  }

  const normalized = readNonEmptyString(value);

  if (!normalized) {
    throw new CliArgumentError(`Value for ${flag} must not be empty.`);
  }

  return normalized;
}

function consumeIntegerValue(
  flag: string,
  inlineValue: string | undefined,
  _argv: readonly string[],
  consumeNext: () => string | undefined,
): number {
  const rawValue = consumeStringValue(flag, inlineValue, _argv, consumeNext);
  return parsePositiveInteger(rawValue, flag);
}

function consumeReviewLevelValue(
  flag: string,
  inlineValue: string | undefined,
  _argv: readonly string[],
  consumeNext: () => string | undefined,
): ReviewLevel {
  const rawValue = consumeStringValue(flag, inlineValue, _argv, consumeNext);

  if (REVIEW_LEVELS.has(rawValue as ReviewLevel)) {
    return rawValue as ReviewLevel;
  }

  throw new CliArgumentError(
    `${flag} must be one of: light, normal, deep.`,
  );
}

function parsePositiveInteger(input: string, label: string): number {
  if (!/^\d+$/.test(input)) {
    throw new CliArgumentError(`${label} must be a positive integer.`);
  }

  const value = Number.parseInt(input, 10);

  if (value <= 0) {
    throw new CliArgumentError(`${label} must be greater than zero.`);
  }

  return value;
}

function parseEnvInteger(
  rawValue: string | undefined,
  label: string,
  fallback: number,
): number {
  if (rawValue === undefined) {
    return fallback;
  }

  const value = readNonEmptyString(rawValue);

  if (!value) {
    return fallback;
  }

  return parsePositiveInteger(value, label);
}

function readNonEmptyString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function assertBooleanFlag(flag: string, inlineValue: string | undefined): void {
  if (inlineValue !== undefined) {
    throw new CliArgumentError(`${flag} does not accept a value.`);
  }
}
