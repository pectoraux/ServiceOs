/**
 * Dynamic/structural proof: the frozen canonical Service Work workflow
 * state machine (WORK-004, CRITICAL — the deterministic transition rules).
 *
 * Proves the canonical table in transitions.ts is exactly the machine from
 * architecture.md §7:
 * - the closed 12-state enumeration;
 * - the happy path draft -> ready -> accepted -> in_progress -> verifying
 *   -> completed is legal end-to-end;
 * - the in_progress <-> waiting_information/waiting_approval/blocked loop
 *   edges and the verifying -> in_progress rework edge are legal;
 * - in_progress -> completed is ILLEGAL (completion must pass through
 *   verifying);
 * - terminal states (completed/cancelled/failed/expired) are absorbing: no
 *   outgoing edge exists;
 * - the alternative terminal entries (cancel/fail/expire) are legal from
 *   EVERY non-terminal state and from no terminal state;
 * - self-loops are illegal everywhere;
 * - rule ids derive deterministically (canonical vs terminal);
 * - the table is frozen code: repeated evaluation is stable (AC-2
 *   determinism, no configuration or data input exists).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CANONICAL_TRANSITIONS,
  RESUMABLE_STATES,
  TERMINAL_STATES,
  WORKFLOW_STATES,
  isLegalTransition,
  isTerminal,
  isWorkflowState,
  listLegalTransitions,
  transitionRuleId,
} from '../src/modules/workflow/index.js';

const NON_TERMINAL = WORKFLOW_STATES.filter((state) => !isTerminal(state));
const ALL_STATES = [...WORKFLOW_STATES];

test('the state enumeration is the closed canonical set (12 states)', () => {
  assert.equal(WORKFLOW_STATES.length, 12);
  assert.deepEqual([...WORKFLOW_STATES].sort(), [
    'accepted',
    'blocked',
    'cancelled',
    'completed',
    'draft',
    'expired',
    'failed',
    'in_progress',
    'ready',
    'verifying',
    'waiting_approval',
    'waiting_information',
  ]);
  // Every key of the table is exactly the enumeration.
  assert.deepEqual(Object.keys(CANONICAL_TRANSITIONS).sort(), [...WORKFLOW_STATES].sort());
});

test('the happy path is legal end-to-end', () => {
  const happyPath = ['draft', 'ready', 'accepted', 'in_progress', 'verifying', 'completed'] as const;
  for (let i = 0; i < happyPath.length - 1; i += 1) {
    const from = happyPath[i] as (typeof happyPath)[number];
    const to = happyPath[i + 1] as (typeof happyPath)[number];
    assert.ok(isLegalTransition(from, to), `${from} -> ${to} must be legal`);
  }
});

test('the waiting/blocked loop edges are legal in both directions', () => {
  for (const resumable of RESUMABLE_STATES) {
    assert.ok(isLegalTransition('in_progress', resumable), `in_progress -> ${resumable} must be legal`);
    assert.ok(isLegalTransition(resumable, 'in_progress'), `${resumable} -> in_progress must be legal`);
  }
  // verifying may rework back into in_progress.
  assert.ok(isLegalTransition('verifying', 'in_progress'));
});

test('completion must pass through verifying (in_progress -> completed is illegal)', () => {
  assert.equal(isLegalTransition('in_progress', 'completed'), false);
  assert.ok(isLegalTransition('verifying', 'completed'));
  // No other state reaches completed directly.
  for (const state of NON_TERMINAL) {
    if (state !== 'verifying') {
      assert.equal(isLegalTransition(state, 'completed'), false, `${state} -> completed must be illegal`);
    }
  }
});

test('terminal states are absorbing: no outgoing transitions exist', () => {
  for (const terminal of TERMINAL_STATES) {
    assert.deepEqual(CANONICAL_TRANSITIONS[terminal], []);
    assert.equal(listLegalTransitions(terminal).length, 0);
  }
});

test('alternative terminal entries are legal from every non-terminal state', () => {
  const alternatives = ['cancelled', 'failed', 'expired'] as const;
  for (const from of NON_TERMINAL) {
    for (const to of alternatives) {
      assert.ok(isLegalTransition(from, to), `${from} -> ${to} must be legal`);
    }
  }
  // ...and from no terminal state.
  for (const from of TERMINAL_STATES) {
    for (const to of alternatives) {
      assert.equal(isLegalTransition(from, to), false, `${from} -> ${to} must be illegal`);
    }
  }
});

test('self-loops are illegal everywhere', () => {
  for (const state of ALL_STATES) {
    assert.equal(isLegalTransition(state, state), false, `${state} -> ${state} must be illegal`);
  }
});

test('draft can only move forward to ready or exit to a terminal state', () => {
  assert.deepEqual([...CANONICAL_TRANSITIONS.draft], ['ready', 'cancelled', 'failed', 'expired']);
});

test('rule ids derive deterministically: canonical edges vs terminal entries', () => {
  assert.equal(transitionRuleId('draft', 'ready'), 'canonical:draft->ready');
  assert.equal(transitionRuleId('in_progress', 'verifying'), 'canonical:in_progress->verifying');
  assert.equal(transitionRuleId('verifying', 'completed'), 'canonical:verifying->completed');
  assert.equal(transitionRuleId('waiting_information', 'in_progress'), 'canonical:waiting_information->in_progress');
  assert.equal(transitionRuleId('draft', 'cancelled'), 'terminal:cancelled');
  assert.equal(transitionRuleId('in_progress', 'expired'), 'terminal:expired');
  assert.equal(transitionRuleId('verifying', 'failed'), 'terminal:failed');
});

test('listLegalTransitions matches the table and marks terminal continuations', () => {
  for (const state of ALL_STATES) {
    const continuations = listLegalTransitions(state);
    assert.deepEqual(
      continuations.map((c) => c.to),
      [...CANONICAL_TRANSITIONS[state]],
      `continuations of ${state} must match the canonical table order`,
    );
    for (const continuation of continuations) {
      assert.equal(continuation.ruleId, transitionRuleId(state, continuation.to));
      assert.equal(continuation.terminal, isTerminal(continuation.to));
    }
  }
  // The continuation hook for a terminal state is empty.
  assert.deepEqual(listLegalTransitions('completed'), []);
});

test('the table is deterministic: repeated evaluation is stable', () => {
  for (let round = 0; round < 3; round += 1) {
    for (const from of ALL_STATES) {
      for (const to of ALL_STATES) {
        assert.equal(isLegalTransition(from, to), CANONICAL_TRANSITIONS[from].includes(to));
      }
    }
  }
});

test('isWorkflowState guards the closed enumeration (fail closed)', () => {
  for (const state of ALL_STATES) {
    assert.ok(isWorkflowState(state));
  }
  assert.equal(isWorkflowState('DRAFT'), false);
  assert.equal(isWorkflowState('in-progress'), false);
  assert.equal(isWorkflowState('deleted'), false);
  assert.equal(isWorkflowState(''), false);
});
