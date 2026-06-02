import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_CONCURRENCY = 2;
export const DEFAULT_MAX_FILES = 40;
export const DEFAULT_MAX_LINES = 1500;
export const DEFAULT_WORKSPACE_ROOT = "/tmp/agent-review";
export const DEFAULT_STATE_PATH = join(homedir(), ".agent-review", "state.json");
export const OPENAI_API_BASE_URL = "https://api.openai.com/v1";
