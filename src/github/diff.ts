export interface CommentableLine {
  line: number;
  kind: 'context' | 'addition';
}

export interface ParsedDiffFile {
  path: string;
  previousPath?: string;
  isNew: boolean;
  isDeleted: boolean;
  commentableLines: Map<number, CommentableLine>;
}

export interface ParsedDiffIndex {
  files: Map<string, ParsedDiffFile>;
}

export interface FilePatch {
  path: string;
  patch: string;
}

function normalizePath(value: string): string {
  return value.replace(/^[ab]\//, '');
}

export function parseUnifiedDiff(diffText: string): ParsedDiffIndex {
  const files = new Map<string, ParsedDiffFile>();
  const lines = diffText.split('\n');

  let currentFile: ParsedDiffFile | undefined;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const rawLine of lines) {
    if (rawLine.startsWith('diff --git ')) {
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(rawLine);
      if (!match) {
        currentFile = undefined;
        inHunk = false;
        continue;
      }

      currentFile = {
        path: normalizePath(match[2]),
        previousPath: normalizePath(match[1]),
        isNew: false,
        isDeleted: false,
        commentableLines: new Map(),
      };
      files.set(currentFile.path, currentFile);
      inHunk = false;
      continue;
    }

    if (!currentFile) {
      continue;
    }

    if (rawLine.startsWith('new file mode ')) {
      currentFile.isNew = true;
      continue;
    }

    if (rawLine.startsWith('deleted file mode ')) {
      currentFile.isDeleted = true;
      continue;
    }

    if (rawLine.startsWith('rename from ')) {
      currentFile.previousPath = rawLine.slice('rename from '.length);
      continue;
    }

    if (rawLine.startsWith('rename to ')) {
      const renamedPath = rawLine.slice('rename to '.length);
      files.delete(currentFile.path);
      currentFile.path = renamedPath;
      files.set(currentFile.path, currentFile);
      continue;
    }

    if (rawLine.startsWith('+++ ')) {
      if (rawLine === '+++ /dev/null') {
        currentFile.isDeleted = true;
      } else {
        const nextPath = normalizePath(rawLine.slice(4));
        if (nextPath !== currentFile.path) {
          files.delete(currentFile.path);
          currentFile.path = nextPath;
          files.set(currentFile.path, currentFile);
        }
      }
      continue;
    }

    if (rawLine.startsWith('@@ ')) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rawLine);
      if (!match) {
        inHunk = false;
        continue;
      }
      oldLine = Number(match[1]);
      newLine = Number(match[2]);
      inHunk = true;
      continue;
    }

    if (!inHunk) {
      continue;
    }

    if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
      currentFile.commentableLines.set(newLine, {
        line: newLine,
        kind: 'addition',
      });
      newLine += 1;
      continue;
    }

    if (rawLine.startsWith('-') && !rawLine.startsWith('---')) {
      oldLine += 1;
      continue;
    }

    if (rawLine.startsWith(' ')) {
      currentFile.commentableLines.set(newLine, {
        line: newLine,
        kind: 'context',
      });
      oldLine += 1;
      newLine += 1;
      continue;
    }

    if (rawLine.startsWith('\\ No newline at end of file')) {
      continue;
    }

    inHunk = false;
  }

  return { files };
}

export function splitUnifiedDiffByFile(diffText: string): Map<string, FilePatch> {
  const files = new Map<string, FilePatch>();
  const sections = diffText.split(/^diff --git /m).filter(Boolean);

  for (const section of sections) {
    const chunk = section.startsWith("a/") ? `diff --git ${section}` : section;
    const firstLine = chunk.split("\n", 1)[0] ?? "";
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(firstLine);
    if (!match) {
      continue;
    }

    const path = normalizePath(match[2]);
    files.set(path, { path, patch: chunk.trimEnd() });
  }

  return files;
}
