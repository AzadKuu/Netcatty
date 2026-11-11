import assert from 'node:assert/strict';
import test from 'node:test';
import { tool } from 'ai';
import { z } from 'zod';
import {
  createCattyPlanTool,
  decorateToolsWithRetryGuidance,
  type PlanStep,
} from './capabilityTools';

test('plan tool records the full step list and reports progress', async () => {
  let recorded: PlanStep[] | undefined;
  const planTool = createCattyPlanTool({ onPlanUpdate: (items) => { recorded = items; } });

  const result = await (planTool as unknown as {
    execute: (args: { steps: Array<{ text: string; completed?: boolean }> }) => Promise<string>;
  }).execute({
    steps: [
      { text: 'List the remote directory', completed: true },
      { text: 'Fetch the failing log tail' },
    ],
  });

  assert.deepEqual(recorded, [
    { text: 'List the remote directory', completed: true },
    { text: 'Fetch the failing log tail', completed: false },
  ]);
  assert.equal(result, 'Plan updated (1/2 done):\n[x] List the remote directory\n[ ] Fetch the failing log tail');
});

test('plan tool trims step text and tolerates a missing callback', async () => {
  const planTool = createCattyPlanTool();
  const result = await (planTool as unknown as {
    execute: (args: { steps: Array<{ text: string; completed?: boolean }> }) => Promise<string>;
  }).execute({ steps: [{ text: '  restart the service  ', completed: false }] });

  assert.match(result, /\[ \] restart the service/);
});

test('retry guidance decorates thrown tool errors instead of rejecting', async () => {
  const failing = tool({
    description: 'always throws',
    inputSchema: z.object({ path: z.string().optional() }),
    execute: async () => {
      throw new Error("ENOENT: no such file or directory, open '/nope'");
    },
  });

  const decorated = decorateToolsWithRetryGuidance({ read_file: failing });
  const result = await (decorated.read_file as unknown as {
    execute: (args: { path: string }, options: unknown) => Promise<string>;
  }).execute({ path: '/nope' }, {});

  assert.match(result, /\[tool failure\]/);
  assert.match(result, /ENOENT/);
  assert.match(result, /retry once/i);
  assert.match(result, /Do not end the task/);
});

test('retry guidance appends to structured error results and leaves successes alone', async () => {
  const returningError = tool({
    description: 'returns an error object',
    inputSchema: z.object({}),
    execute: async () => ({ error: 'Permission denied (publickey)' }),
  });
  const succeeding = tool({
    description: 'returns text',
    inputSchema: z.object({}),
    execute: async () => 'ok',
  });

  const decorated = decorateToolsWithRetryGuidance({ ssh_exec: returningError, terminal_execute: succeeding });

  const failure = await (decorated.ssh_exec as unknown as { execute: (a: object, o: unknown) => Promise<{ error: string }> })
    .execute({}, {});
  assert.match(failure.error, /Permission denied/);
  assert.match(failure.error, /retry once/i);

  const success = await (decorated.terminal_execute as unknown as { execute: (a: object, o: unknown) => Promise<string> })
    .execute({}, {});
  assert.equal(success, 'ok');
});

test('tools without an execute function pass through untouched', () => {
  const plain = { description: 'no execute' } as unknown as { execute?: unknown };
  const decorated = decorateToolsWithRetryGuidance({ weird: plain });
  assert.equal(decorated.weird, plain);
});
