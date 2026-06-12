import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCliRenderer,
  formatTaskRow,
  renderCliSnapshot,
  type CliRenderStream,
} from '../../src/cli/renderer.js';

function createOutput(): {
  output: CliRenderStream;
  text: () => string;
} {
  const chunks: string[] = [];

  return {
    output: {
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
    },
    text() {
      return chunks.join('');
    },
  };
}

test('formatTaskRow renders queued, skipped, and complete rows', () => {
  assert.equal(
    formatTaskRow({
      id: 'acme/widget#42',
      label: 'acme/widget#42',
      status: 'queued',
    }),
    '[ ] acme/widget#42',
  );

  assert.equal(
    formatTaskRow({
      id: 'acme/widget#43',
      label: 'acme/widget#43',
      status: 'skipped',
      message: 'draft',
    }),
    '[-] acme/widget#43 - draft',
  );

  assert.equal(
    formatTaskRow({
      id: 'acme/widget#44',
      label: 'acme/widget#44',
      status: 'complete',
      findingsCount: 1,
      message: 'saved to dry-run.json',
    }),
    '[x] acme/widget#44 (1 finding) - saved to dry-run.json',
  );
});

test('renderCliSnapshot includes spinner label and preserves task order', () => {
  const lines = renderCliSnapshot(
    [
      {
        id: 'acme/widget#42',
        label: 'acme/widget#42',
        status: 'reviewing',
      },
      {
        id: 'acme/widget#43',
        label: 'acme/widget#43',
        status: 'queued',
      },
    ],
    'Reviewing pull requests',
  );

  assert.deepEqual(lines, [
    '- Reviewing pull requests',
    '[>] acme/widget#42',
    '[ ] acme/widget#43',
  ]);
});

test('plain renderer emits deterministic append-only snapshots', () => {
  const { output, text } = createOutput();
  const renderer = createCliRenderer({ output });

  renderer.setSpinnerLabel('Reviewing pull requests');
  renderer.upsertTask({
    id: 'acme/widget#42',
    label: 'acme/widget#42',
    status: 'queued',
  });
  renderer.upsertTask({
    id: 'acme/widget#42',
    label: 'acme/widget#42',
    status: 'reviewing',
  });
  renderer.upsertTask({
    id: 'acme/widget#42',
    label: 'acme/widget#42',
    status: 'complete',
    findingsCount: 2,
  });
  renderer.stop();

  const rendered = text();
  assert.match(
    rendered,
    /^- Reviewing pull requests\n\n- Reviewing pull requests\n\[ \] acme\/widget#42\n\n- Reviewing pull requests\n\[>\] acme\/widget#42\n\n- Reviewing pull requests\n\[x\] acme\/widget#42 \(2 findings\)\n\n$/,
  );
});

test('renderer preserves first-seen task order across updates', () => {
  const { output, text } = createOutput();
  const renderer = createCliRenderer({ output });

  renderer.setSpinnerLabel('Reviewing pull requests');
  renderer.upsertTask({
    id: 'acme/widget#43',
    label: 'acme/widget#43',
    status: 'queued',
  });
  renderer.upsertTask({
    id: 'acme/widget#42',
    label: 'acme/widget#42',
    status: 'queued',
  });
  renderer.upsertTask({
    id: 'acme/widget#43',
    label: 'acme/widget#43',
    status: 'complete',
    findingsCount: 3,
  });
  renderer.stop();

  assert.match(
    text(),
    /- Reviewing pull requests\n\[x\] acme\/widget#43 \(3 findings\)\n\[ \] acme\/widget#42/,
  );
});
