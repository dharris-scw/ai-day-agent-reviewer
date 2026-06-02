import { readFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { PullRequestMetadata } from "../github/types.js";
import { splitUnifiedDiffByFile } from "../github/diff.js";
import type { ChangedFileInput, PullRequestReviewInput, RepositoryContextFile } from "../review-engine/types.js";

export async function buildPullRequestReviewInput(args: {
  repoDir: string;
  metadata: PullRequestMetadata;
  diff: string;
  maxFiles: number;
  maxLines: number;
}): Promise<PullRequestReviewInput> {
  const patchMap = splitUnifiedDiffByFile(args.diff);
  const changedFiles: ChangedFileInput[] = [];

  for (const file of args.metadata.changedFiles) {
    const patch = patchMap.get(file.path)?.patch;
    if (!patch) {
      continue;
    }

    const content = await safeRead(join(args.repoDir, file.path));
    changedFiles.push({
      path: file.path,
      content,
      patch,
      additions: file.additions,
      deletions: file.deletions,
      context: await buildFileContext(args.repoDir, file.path)
    });
  }

  return {
    owner: args.metadata.repository.owner,
    repo: args.metadata.repository.name,
    title: args.metadata.title,
    description: args.metadata.body,
    baseSha: args.metadata.baseSha,
    headSha: args.metadata.headSha,
    changedFiles,
    repositoryContext: await buildRepositoryContext(args.repoDir),
    coverage: {
      maxFiles: args.maxFiles,
      maxLines: args.maxLines
    }
  };
}

async function buildRepositoryContext(repoDir: string): Promise<RepositoryContextFile[]> {
  const interesting = ["README.md", "package.json", "tsconfig.json", "pyproject.toml", "go.mod", "Cargo.toml"];
  const files = await Promise.all(
    interesting.map(async (path) => ({
      path,
      content: await safeRead(join(repoDir, path))
    }))
  );

  return files.filter((file) => file.content.length > 0);
}

async function buildFileContext(repoDir: string, filePath: string): Promise<string> {
  const snippets: string[] = [];
  const siblingTest = await findSiblingTest(repoDir, filePath);
  if (siblingTest) {
    snippets.push(`Related test: ${siblingTest.path}\n${truncate(siblingTest.content, 4000)}`);
  }

  const imports = await collectRelativeImports(repoDir, filePath);
  for (const imported of imports) {
    snippets.push(`Imported file: ${imported.path}\n${truncate(imported.content, 3000)}`);
  }

  return snippets.join("\n\n");
}

async function findSiblingTest(repoDir: string, filePath: string): Promise<RepositoryContextFile | undefined> {
  const absolute = resolve(repoDir, filePath);
  const stem = basename(filePath, extname(filePath));
  const extension = extname(filePath);
  const candidates = [
    join(dirname(absolute), `${stem}.test${extension}`),
    join(dirname(absolute), `${stem}.spec${extension}`)
  ];

  for (const candidate of candidates) {
    const content = await safeRead(candidate);
    if (content) {
      return {
        path: candidate.slice(repoDir.length + 1),
        content
      };
    }
  }

  return undefined;
}

async function collectRelativeImports(repoDir: string, filePath: string): Promise<RepositoryContextFile[]> {
  const absolute = resolve(repoDir, filePath);
  const source = await safeRead(absolute);
  if (!source) {
    return [];
  }

  const matches = [...source.matchAll(/from\s+["'](\.[^"']+)["']/g)];
  const files: RepositoryContextFile[] = [];
  for (const match of matches) {
    const relative = match[1];
    if (!relative) {
      continue;
    }
    const imported = await resolveImport(repoDir, dirname(filePath), relative);
    if (!imported) {
      continue;
    }
    files.push(imported);
  }

  return dedupeByPath(files);
}

async function resolveImport(
  repoDir: string,
  importerDir: string,
  relative: string
): Promise<RepositoryContextFile | undefined> {
  const base = resolve(repoDir, importerDir, relative);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, join(base, "index.ts"), join(base, "index.js")];
  for (const candidate of candidates) {
    const content = await safeRead(candidate);
    if (content) {
      return {
        path: candidate.slice(repoDir.length + 1),
        content
      };
    }
  }
  return undefined;
}

async function safeRead(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n...[truncated]`;
}

function dedupeByPath(files: RepositoryContextFile[]): RepositoryContextFile[] {
  const seen = new Set<string>();
  return files.filter((file) => {
    if (seen.has(file.path)) {
      return false;
    }
    seen.add(file.path);
    return true;
  });
}
