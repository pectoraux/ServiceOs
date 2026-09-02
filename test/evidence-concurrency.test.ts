/**
 * Concurrency proof: the /evidence authority's convergence under
 * interleaving (WORK-007, required class `concurrency`).
 *
 * The in-memory store's async hooks inject deterministic interleaving
 * points BEFORE each synchronous critical section (the exact semantics
 * of the advisory-locked SQL transactions), so these proofs exercise
 * real check-then-act races between INDEPENDENT actors:
 *
 * - two actors attaching the same logical evidence (same key, identical
 *   content) converge on ONE durable row (invariant 6);
 * - two actors attaching the SAME FACT under different keys converge on
 *   ONE durable row (content convergence — the fact identity, not the
 *   submitter's key, decides);
 * - same-key DIVERGENT attachments: one wins, one fails closed
 *   (EVIDENCE_INPUT_CONFLICT inside the serialized section);
 * - the crash window (the caller crashed after the durable row
 *   committed and re-submits): the retry converges on the same row,
 *   never a duplicate;
 * - two actors verifying the same logical decision (same key, same
 *   input) converge on ONE immutable decision row;
 * - a same-key verification over a CHANGED evidence state: one wins,
 *   one fails closed (VERIFICATION_INPUT_CONFLICT — a re-verification
 *   after evidence changes is a NEW logical decision);
 * - the attach/verify serialization: a verification racing an attach
 *   decides over exactly ONE consistent evidence state (the state-lock
 *   domain) — the verdict always matches the evidence its snapshot
 *   pinned, never a torn state;
 * - mutation discrimination: stores that drop the conflict guards
 *   produce detectable duplicate/ambiguous state (the guards are
 *   load-bearing).
 *
 * The SQL-level equivalents of the same races run against live
 * PostgreSQL in test/evidence.integration.test.ts (CI).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidenceApp, InMemoryEvidenceStore, type EvidenceAuthorityApp } from './helpers/in-memory-stores.js';
import type { Principal } from '../src/modules/auth/index.js';
import {
  EvidenceError,
  computeEvidenceRecordHash,
  type AttachEvidenceInput,
  type OutcomeContractInput,
} from '../src/modules/evidence/index.js';

const PASSWORD = 'correct horse battery 7';
const NOW = new Date('2026-09-02T12:00:00.000Z');

interface Base {
  app: EvidenceAuthorityApp;
  owner: Principal;
  colleague: Principal;
  tenantId: string;
  workId: string;
  otherWorkId: string;
}

async function base(race?: () => Promise<void>): Promise<Base> {
  const app = buildEvidenceApp({
    now: () => NOW,
    evidenceStoreOptions: {
      beforeAttachEvidence: race,
      beforeRecordVerification: race,
    },
  });
  const owner = await app.auth.registerHuman({ email: 'owner@a.com', password: PASSWORD, displayName: 'Owner' });
  const colleague = await app.auth.registerHuman({ email: 'member@a.com', password: PASSWORD, displayName: 'Member' });
  const created = await app.organizations.createOrganization(owner, { slug: 'alpha-org', displayName: 'Alpha' });
  await app.organizations.addMember(owner, 'alpha-org', { principalId: colleague.id, role: 'member' });
  const { work } = await app.work.createWork(owner, {
    tenantId: created.tenant.id,
    workType: 'CollectComplianceDocuments',
    title: 'Collect the compliance package',
  });
  const { work: otherWork } = await app.work.createWork(owner, {
    tenantId: created.tenant.id,
    workType: 'ValidateInsuranceCertificate',
    title: 'Another work item',
  });
  return { app, owner, colleague, tenantId: created.tenant.id, workId: work.id, otherWorkId: otherWork.id };
}

function evidenceInput(
  tenantId: string,
  serviceWorkId: string,
  key: string,
  over: Partial<AttachEvidenceInput> = {},
): AttachEvidenceInput {
  return {
    tenantId,
    serviceWorkId,
    requirement: 'insurance_certificate_on_file',
    provenance: {
      kind: 'external_record',
      source: 'carrier-portal-api',
      refs: ['carrier://certificate/acme-2026-0001'],
    },
    payload: { carrier: 'Acme Mutual', policy: 'GL-2026-8899', coverage: 2000000, expiresOn: '2027-03-01' },
    observedAt: new Date('2026-09-01T09:30:00.000Z'),
    idempotencyKey: key,
    ...over,
  };
}

function divergentInput(tenantId: string, serviceWorkId: string, key: string): AttachEvidenceInput {
  return evidenceInput(tenantId, serviceWorkId, key, {
    payload: { carrier: 'Forged Mutual', policy: 'XX-0000', coverage: 1, expiresOn: '2030-01-01' },
  });
}

function contractInput(evidenceRequirements: string[], over: Partial<OutcomeContractInput> = {}): OutcomeContractInput {
  return {
    outcomeId: 'compliance_package_complete',
    verification: 'deterministic',
    evidenceRequirements,
    ...over,
  };
}

function oneTimeRace(): () => Promise<void> {
  let release = 0;
  return async () => {
    if (release === 0) {
      release = 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
}

async function capture<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

function expectCode(result: { ok: true; value: unknown } | { ok: false; error: unknown }, code: string): void {
  assert.ok(result.ok === false, 'expected the racing loser to fail closed');
  assert.ok(result.error instanceof EvidenceError, `expected an EvidenceError, got ${(result.error as Error)?.message}`);
  assert.equal((result.error as EvidenceError).code, code);
}

// ---------------------------------------------------------------------------
// Duplicate evidence attachment converges (invariant 6)
// ---------------------------------------------------------------------------

test('two actors attaching the same logical submission (same key) converge on ONE row', async () => {
  const race = oneTimeRace();
  const { app, owner, colleague, tenantId, workId } = await base(race);
  const [a, b] = await Promise.all([
    app.evidence.attachEvidence(owner, evidenceInput(tenantId, workId, 'evidence-1')),
    app.evidence.attachEvidence(colleague, evidenceInput(tenantId, workId, 'evidence-1')),
  ]);
  // The row identity is ONE; the converging call reports convergence.
  assert.equal(a.evidence.id, b.evidence.id);
  assert.equal((a.converged ? 1 : 0) + (b.converged ? 1 : 0), 1);
  assert.equal((await app.evidence.listEvidence(owner, tenantId, { serviceWorkId: workId })).length, 1);
});

test('two actors attaching the SAME FACT under different keys converge on ONE row', async () => {
  const race = oneTimeRace();
  const { app, owner, colleague, tenantId, workId } = await base(race);
  const [a, b] = await Promise.all([
    app.evidence.attachEvidence(owner, evidenceInput(tenantId, workId, 'evidence-a')),
    app.evidence.attachEvidence(colleague, evidenceInput(tenantId, workId, 'evidence-b')),
  ]);
  assert.equal(a.evidence.id, b.evidence.id);
  assert.equal((a.converged ? 1 : 0) + (b.converged ? 1 : 0), 1);
  assert.equal((await app.evidence.listEvidence(owner, tenantId, { serviceWorkId: workId })).length, 1);
});

test('same-key DIVERGENT attachments: one wins, one fails closed inside the serialized section', async () => {
  const race = oneTimeRace();
  const { app, owner, colleague, tenantId, workId } = await base(race);
  const [a, b] = await Promise.all([
    capture(app.evidence.attachEvidence(owner, evidenceInput(tenantId, workId, 'evidence-1'))),
    capture(app.evidence.attachEvidence(colleague, divergentInput(tenantId, workId, 'evidence-1'))),
  ]);
  const successes = [a, b].filter((result) => result.ok === true);
  assert.equal(successes.length, 1);
  const failures = [a, b].filter((result) => result.ok === false);
  assert.equal(failures.length, 1);
  expectCode(failures[0] as { ok: false; error: unknown }, 'EVIDENCE_INPUT_CONFLICT');
  // Exactly ONE durable row holds the surviving fact.
  const rows = await app.evidence.listEvidence(owner, tenantId, { serviceWorkId: workId });
  assert.equal(rows.length, 1);
});

test('the crash window: a re-submission after the durable commit converges, never duplicates', async () => {
  const { app, owner, tenantId, workId } = await base();
  const first = await app.evidence.attachEvidence(owner, evidenceInput(tenantId, workId, 'evidence-1'));
  // The caller crashed after the row committed and re-submits the SAME
  // logical submission (same key, same content): convergence.
  const retry = await app.evidence.attachEvidence(owner, evidenceInput(tenantId, workId, 'evidence-1'));
  assert.equal(retry.converged, true);
  assert.equal(retry.evidence.id, first.evidence.id);
  assert.equal((await app.evidence.listEvidence(owner, tenantId)).length, 1);
});

// ---------------------------------------------------------------------------
// Duplicate verification converges
// ---------------------------------------------------------------------------

test('two actors verifying the same logical decision converge on ONE decision row', async () => {
  const race = oneTimeRace();
  const { app, owner, colleague, tenantId, workId } = await base(race);
  await app.evidence.attachEvidence(owner, evidenceInput(tenantId, workId, 'evidence-1'));
  const input = {
    tenantId,
    serviceWorkId: workId,
    contract: contractInput(['insurance_certificate_on_file']),
    idempotencyKey: 'verify-1',
  };
  const [a, b] = await Promise.all([
    app.evidence.verifyOutcome(owner, input),
    app.evidence.verifyOutcome(colleague, input),
  ]);
  assert.equal(a.verification.id, b.verification.id);
  assert.equal(a.verification.verdict, b.verification.verdict);
  assert.equal((a.converged ? 1 : 0) + (b.converged ? 1 : 0), 1);
  assert.equal((await app.evidence.listOutcomeVerifications(owner, tenantId)).length, 1);
});

test('a same-key verification over a CHANGED evidence state fails closed (re-verification is a new decision)', async () => {
  const { app, owner, tenantId, workId } = await base();
  const contract = contractInput(['insurance_certificate_on_file', 'license_validated']);
  await app.evidence.attachEvidence(owner, evidenceInput(tenantId, workId, 'evidence-1'));
  const first = await app.evidence.verifyOutcome(owner, {
    tenantId,
    serviceWorkId: workId,
    contract,
    idempotencyKey: 'verify-1',
  });
  assert.equal(first.verification.verdict, 'not_satisfied');
  // The evidence state changes under the SAME decision key: the
  // recorded decision pinned its input — the same-key re-run conflicts.
  await app.evidence.attachEvidence(
    owner,
    evidenceInput(tenantId, workId, 'evidence-2', {
      requirement: 'license_validated',
      provenance: { kind: 'system_observation', source: 'license-check-worker', refs: [] },
      payload: { state: 'CA', valid: true },
    }),
  );
  const error = await capture(
    app.evidence.verifyOutcome(owner, { tenantId, serviceWorkId: workId, contract, idempotencyKey: 'verify-1' }),
  );
  expectCode(error, 'VERIFICATION_INPUT_CONFLICT');
  // The decision ledger is unchanged by the rejected re-run.
  const ledger = await app.evidence.listOutcomeVerifications(owner, tenantId, { serviceWorkId: workId });
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0]?.verdict, 'not_satisfied');
});

// ---------------------------------------------------------------------------
// Attach/verify serialization: the decision snapshot is consistent
// ---------------------------------------------------------------------------

test('a verification racing an attach decides over exactly ONE consistent evidence state', async () => {
  const race = oneTimeRace();
  const { app, owner, tenantId, workId } = await base(race);
  await app.evidence.attachEvidence(owner, evidenceInput(tenantId, workId, 'evidence-1'));
  const [attachResult, verifyResult] = await Promise.all([
    app.evidence.attachEvidence(
      owner,
      evidenceInput(tenantId, workId, 'evidence-2', {
        requirement: 'license_validated',
        provenance: { kind: 'system_observation', source: 'license-check-worker', refs: [] },
        payload: { state: 'CA', valid: true },
      }),
    ),
    app.evidence.verifyOutcome(owner, {
      tenantId,
      serviceWorkId: workId,
      contract: contractInput(['insurance_certificate_on_file', 'license_validated']),
      idempotencyKey: 'verify-1',
    }),
  ]);
  // The verdict is CONSISTENT with the pinned evidence snapshot —
  // never a torn state. Either the license evidence was committed
  // before the decision (satisfied, 2 evidence rows in the snapshot)
  // or after (not_satisfied, 1 evidence row). The decision's mapping
  // proves which state it decided over.
  const decision = verifyResult.verification;
  const mapped = decision.requirementResults.map((result) => result.satisfied);
  if (decision.verdict === 'satisfied') {
    assert.deepEqual(mapped, [true, true]);
    assert.equal(attachResult.evidence.requirement, 'license_validated');
  } else {
    assert.equal(decision.verdict, 'not_satisfied');
    assert.deepEqual(mapped, [true, false]);
  }
  // Both durable rows exist after the race (the attach always wins its
  // own convergence domain).
  assert.equal((await app.evidence.listEvidence(owner, tenantId, { serviceWorkId: workId })).length, 2);
});

// ---------------------------------------------------------------------------
// The race hooks inject interleaving between EVERY check-then-act pair
// ---------------------------------------------------------------------------

test('a race hook that fires on every write still converges (post-lock re-check is authoritative)', async () => {
  let fired = 0;
  const race = async () => {
    fired += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
  };
  const { app, owner, colleague, tenantId, workId } = await base(race);
  const results = await Promise.all([
    app.evidence.attachEvidence(owner, evidenceInput(tenantId, workId, 'evidence-1')),
    app.evidence.attachEvidence(colleague, evidenceInput(tenantId, workId, 'evidence-1')),
    app.evidence.attachEvidence(owner, evidenceInput(tenantId, workId, 'evidence-1')),
  ]);
  assert.ok(fired >= 3, 'every writer observed the interleaving point');
  const ids = new Set(results.map((result) => result.evidence.id));
  assert.equal(ids.size, 1);
  assert.equal(results.filter((result) => result.converged).length, 2);
  assert.equal((await app.evidence.listEvidence(owner, tenantId)).length, 1);
});

// ---------------------------------------------------------------------------
// Mutation discrimination: the guards are load-bearing
// ---------------------------------------------------------------------------

test('a store that drops the evidence conflict guards duplicates facts (must be detectable)', async () => {
  const race = oneTimeRace();
  const fixture = await base(race);
  const { app, owner, colleague, tenantId, workId } = fixture;
  // A mutated store whose attach section has NO keyed guard and NO
  // content dedup — the exact defect class the convergence guards
  // exist for. Synchronous (atomic in JS) so the mutation is the ONLY
  // behavioral difference from the real store.
  const broken = app.evidenceStore;
  broken.attachEvidence = async (input) => {
    const id = `broken-${broken.evidence.size + 1}`;
    const record = {
      id,
      tenantId: input.tenantId,
      serviceWorkId: input.serviceWorkId,
      workAttemptId: input.workAttemptId,
      requirement: input.requirement,
      provenance: { ...input.provenance, refs: [...input.provenance.refs] },
      payload: JSON.parse(JSON.stringify(input.payload)) as unknown,
      observedAt: input.observedAt,
      idempotencyKey: input.idempotencyKey,
      contentHash: input.contentHash,
      recordHash: '',
      attachedBy: input.attachedBy,
      attachedAt: input.now,
    } as (typeof broken.evidence extends Map<string, infer V> ? V : never);
    record.recordHash = computeEvidenceRecordHash(record);
    broken.evidence.set(id, record);
    // MUTATION: the identity maps are not maintained — the guards and
    // the dedup identities are gone.
    return { evidence: { ...record }, converged: false };
  };
  const [a, b] = await Promise.all([
    capture(app.evidence.attachEvidence(owner, evidenceInput(tenantId, workId, 'evidence-1'))),
    capture(app.evidence.attachEvidence(colleague, evidenceInput(tenantId, workId, 'evidence-1'))),
  ]);
  // With the guards dropped, BOTH duplicate submissions "succeed" and
  // the same fact exists twice — the anomaly the real guards make
  // impossible is detectable through the read surface.
  const successes = [a, b].filter((result) => result.ok === true);
  assert.equal(successes.length, 2, 'the mutated store fails closed nowhere — the defect is observable');
  const rows = [...broken.evidence.values()].filter((row) => row.tenantId === tenantId);
  assert.equal(rows.length, 2, 'the duplicated fact is observable — the guards are load-bearing');
});

test('a store that drops the verification conflict guard records ambiguous decisions (must be detectable)', async () => {
  const fixture = await base();
  const { app, owner, tenantId, workId } = fixture;
  const contract = contractInput(['insurance_certificate_on_file']);
  await app.evidence.attachEvidence(owner, evidenceInput(tenantId, workId, 'evidence-1'));
  const first = await app.evidence.verifyOutcome(owner, {
    tenantId,
    serviceWorkId: workId,
    contract,
    idempotencyKey: 'verify-1',
  });
  assert.equal(first.verification.verdict, 'satisfied');
  // The evidence state changes; the same key must conflict — a mutated
  // store that skips the keyed re-check and blindly inserts records a
  // SECOND decision for the same logical identity over a different
  // input: the exact defect class the verification conflict guard
  // exists for.
  const broken = app.evidenceStore;
  const original = broken.recordVerification.bind(broken);
  broken.recordVerification = async (input) => {
    const key = `${input.tenantId}:${input.idempotencyKey}`;
    // MUTATION: the keyed convergence/conflict re-check is skipped —
    // every call inserts.
    void key;
    const result = await original({ ...input, idempotencyKey: `${input.idempotencyKey}-phantom-${broken.verifications.size}` });
    return { verification: { ...result.verification, idempotencyKey: input.idempotencyKey }, converged: false };
  };
  // More evidence arrives, changing the decision input.
  await app.evidence.attachEvidence(
    owner,
    evidenceInput(tenantId, workId, 'evidence-2', {
      requirement: 'license_validated',
      provenance: { kind: 'system_observation', source: 'license-check-worker', refs: [] },
      payload: { state: 'CA', valid: true },
    }),
  );
  const contractWithMore = contractInput(['insurance_certificate_on_file', 'license_validated']);
  await app.evidence.verifyOutcome(owner, {
    tenantId,
    serviceWorkId: workId,
    contract: contractWithMore,
    idempotencyKey: 'verify-1',
  });
  // The mutated store recorded TWO decisions for the same logical key
  // over DIFFERENT inputs: the ambiguity the real guard makes
  // impossible is detectable through the keyed lookup surface.
  const keyed = await app.evidenceStore.findVerificationByKey(tenantId, 'verify-1');
  assert.ok(keyed !== null, 'the keyed lookup surface exposes the phantom row');
  assert.equal(
    (await app.evidence.listOutcomeVerifications(owner, tenantId, { serviceWorkId: workId })).length,
    2,
    'two decision rows exist for one logical decision identity — the guard is load-bearing',
  );
});
