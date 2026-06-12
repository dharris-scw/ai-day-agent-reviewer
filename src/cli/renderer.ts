export type CliTaskStatus = "queued" | "reviewing" | "skipped" | "complete";

export interface CliTaskRow {
  id: string;
  label: string;
  status: CliTaskStatus;
  findingsCount?: number;
  message?: string;
}

export interface CliRenderStream {
  write(chunk: string): boolean;
  isTTY?: boolean;
}

export interface CliRendererOptions {
  output: CliRenderStream;
}

export interface CliRenderer {
  setSpinnerLabel(label?: string): void;
  upsertTask(task: CliTaskRow): void;
  removeTask(id: string): void;
  tick(): void;
  stop(): void;
}

export function createCliRenderer(options: CliRendererOptions): CliRenderer {
  return new PlainCliRenderer(options.output);
}

export function formatTaskRow(task: CliTaskRow): string {
  switch (task.status) {
    case "queued":
      return appendMessage(`[ ] ${task.label}`, task.message);
    case "reviewing":
      return appendMessage(`[>] ${task.label}`, task.message);
    case "skipped":
      return appendMessage(`[-] ${task.label}`, task.message);
    case "complete":
      return appendMessage(
        appendFindings(`[x] ${task.label}`, task.findingsCount),
        task.message,
      );
    default: {
      const exhaustiveCheck: never = task.status;
      return exhaustiveCheck;
    }
  }
}

export function renderCliSnapshot(
  tasks: readonly CliTaskRow[],
  spinnerLabel?: string,
): string[] {
  const lines: string[] = [];

  if (spinnerLabel) {
    lines.push(`- ${spinnerLabel}`);
  }

  for (const task of tasks) {
    lines.push(formatTaskRow(task));
  }

  return lines;
}

class PlainCliRenderer implements CliRenderer {
  private readonly output: CliRenderStream;
  private readonly tasks = new Map<string, CliTaskRow>();
  private readonly taskOrder: string[] = [];

  private spinnerLabel?: string;
  private lastSnapshot?: string;
  private stopped = false;

  constructor(output: CliRenderStream) {
    this.output = output;
  }

  setSpinnerLabel(label?: string): void {
    this.ensureActive();
    const nextLabel = normalizeLabel(label);
    if (nextLabel === this.spinnerLabel) {
      return;
    }
    this.spinnerLabel = nextLabel;
    this.render();
  }

  upsertTask(task: CliTaskRow): void {
    this.ensureActive();

    const normalizedTask = normalizeTask(task);
    if (!this.tasks.has(normalizedTask.id)) {
      this.taskOrder.push(normalizedTask.id);
    }

    this.tasks.set(normalizedTask.id, normalizedTask);
    this.render();
  }

  removeTask(id: string): void {
    this.ensureActive();

    if (!this.tasks.delete(id)) {
      return;
    }

    const index = this.taskOrder.indexOf(id);
    if (index >= 0) {
      this.taskOrder.splice(index, 1);
    }

    this.render();
  }

  tick(): void {
    this.ensureActive();
  }

  stop(): void {
    if (this.stopped) {
      return;
    }

    this.render();
    this.stopped = true;
  }

  private ensureActive(): void {
    if (this.stopped) {
      throw new Error("CLI renderer has already been stopped.");
    }
  }

  private render(): void {
    const tasks = this.taskOrder
      .map((taskId) => this.tasks.get(taskId))
      .filter((task): task is CliTaskRow => task !== undefined);
    const snapshot = renderCliSnapshot(tasks, this.spinnerLabel).join("\n");

    if (snapshot === this.lastSnapshot) {
      return;
    }

    this.output.write(`${snapshot}\n\n`);
    this.lastSnapshot = snapshot;
  }
}

function appendMessage(text: string, message?: string): string {
  const nextMessage = normalizeLabel(message);
  return nextMessage ? `${text} - ${nextMessage}` : text;
}

function appendFindings(text: string, findingsCount?: number): string {
  if (findingsCount === undefined) {
    return text;
  }

  const count = Math.max(0, Math.trunc(findingsCount));
  const noun = count === 1 ? "finding" : "findings";
  return `${text} (${count} ${noun})`;
}

function normalizeTask(task: CliTaskRow): CliTaskRow {
  return {
    id: task.id,
    label: task.label.trim(),
    status: task.status,
    findingsCount:
      task.findingsCount === undefined
        ? undefined
        : Math.max(0, Math.trunc(task.findingsCount)),
    message: normalizeLabel(task.message),
  };
}

function normalizeLabel(label?: string): string | undefined {
  const trimmed = label?.trim();
  return trimmed ? trimmed : undefined;
}
