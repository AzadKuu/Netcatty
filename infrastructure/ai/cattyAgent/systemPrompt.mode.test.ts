import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSystemPrompt } from './systemPrompt';

const baseContext = {
  scopeType: 'terminal' as const,
  hosts: [],
  permissionMode: 'confirm' as const,
};

test('classic mode keeps the original prompt without the enhanced section', () => {
  const classic = buildSystemPrompt(baseContext);
  const explicitClassic = buildSystemPrompt({ ...baseContext, agentMode: 'classic' });

  assert.equal(explicitClassic, classic);
  assert.doesNotMatch(classic, /Execution Discipline \(enhanced mode\)/);
  assert.doesNotMatch(classic, /plan_update/);
});

test('enhanced mode appends the execution discipline rules', () => {
  const enhanced = buildSystemPrompt({ ...baseContext, agentMode: 'enhanced' });

  assert.match(enhanced, /## Execution Discipline \(enhanced mode\)/);
  assert.match(enhanced, /`plan_update`/);
  // Plan steps must be published before acting, and completed one at a time.
  assert.match(enhanced, /before the first action/i);
  // A single failure must not end the task: retry once with a concrete change.
  assert.match(enhanced, /retry \*\*once\*\*/i);
  assert.match(enhanced, /Never summarize a task as impossible after a single error/i);
  // The classic guidelines stay in place so only the delta is added.
  assert.match(enhanced, /## Guidelines/);
});

test('enhanced rules come after the cacheable static prefix', () => {
  const classic = buildSystemPrompt(baseContext);
  const enhanced = buildSystemPrompt({ ...baseContext, agentMode: 'enhanced' });

  const prefix = classic.slice(0, classic.indexOf('\n## '));
  assert.ok(enhanced.startsWith(prefix), 'static opening must be identical in both modes');
  assert.ok(enhanced.length > classic.length);
});
