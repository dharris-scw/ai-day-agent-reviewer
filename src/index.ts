import { runCli } from "./main.js";

void runCli(process.argv.slice(2), process.env).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
