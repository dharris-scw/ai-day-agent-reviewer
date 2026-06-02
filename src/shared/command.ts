import { spawn } from 'node:child_process';

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
}

export interface CommandRunner {
  run(command: string, args: string[], options?: CommandOptions): Promise<CommandResult>;
}

export class CommandExecutionError extends Error {
  command: string;
  args: string[];
  cwd?: string;
  stdout: string;
  stderr: string;
  exitCode: number;

  constructor(
    command: string,
    args: string[],
    options: CommandOptions | undefined,
    result: CommandResult,
  ) {
    super(
      [
        `Command failed: ${command} ${args.join(' ')}`.trim(),
        options?.cwd ? `cwd=${options.cwd}` : undefined,
        result.stderr.trim() || undefined,
      ]
        .filter(Boolean)
        .join('\n'),
    );
    this.name = 'CommandExecutionError';
    this.command = command;
    this.args = args;
    this.cwd = options?.cwd;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
    this.exitCode = result.exitCode;
  }
}

export class SpawnCommandRunner implements CommandRunner {
  async run(command: string, args: string[], options: CommandOptions = {}): Promise<CommandResult> {
    return await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: 'pipe',
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });

      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });

      child.on('error', reject);
      child.on('close', (exitCode) => {
        resolve({
          stdout,
          stderr,
          exitCode: exitCode ?? 1,
        });
      });

      if (options.stdin !== undefined) {
        child.stdin.write(options.stdin);
      }
      child.stdin.end();
    });
  }
}

export async function runOrThrow(
  runner: CommandRunner,
  command: string,
  args: string[],
  options?: CommandOptions,
): Promise<CommandResult> {
  const result = await runner.run(command, args, options);
  if (result.exitCode !== 0) {
    throw new CommandExecutionError(command, args, options, result);
  }
  return result;
}
