/**
 * Behavioral + discrimination proofs for the /evidence authority
 * (WORK-007, required classes `dynamic` + `discrimination`).
 *
 * Behavioral:
 * - evidence attaches with validated attribution (AC-1): a REAL Service
 *   Work identity in the tenant, an optional attempt that belongs to
 *   it; the row is immutable, tenant-scoped and carries preserved
 *   provenance (AC-3);
 * - reads round-trip (get + list + filters; a missing read is
 *   distinguishable from a genuine empty ledger — lock #30);
 * - outcome verification records the deterministic decision (AC-2):
 *   satisfied only when every contract requirement is satisfied by
 *   THIS work item's attached evidence; missing evidence is
 *   'not_satisfied' with the missing requirements listed (AC-4);
 * - duplicate attachment converges (invariant 6): same key + identical
 *   content, and the same FACT under a different key, both converge on
 *   ONE durable row; a same-key divergent input fails closed;
 * - re-verification after evidence changes is a NEW decision (new key);
 *   the same key over the same input converges;
 *
 * Discrimination / mutation:
 * - FABRICATED COMPLETION WITHOUT EVIDENCE FAILS (AC-4): verifying a
 *   contract with no attached evidence yields 'not_satisfied' with
 *   every requirement listed as missing — and the Service Work record
 *   is UNCHANGED (a verification never transitions work);
 * - WRONG-WORK EVIDENCE CANNOT SATISFY ANOTHER WORK ITEM (invariant 5):
 *   evidence attached to work B never satisfies work A's contract;
 * - the evidence of one attempt counts for the work outcome (attempt
 *   attribution is provenance, the outcome scope is the work);
 * - after-the-fact mutation of stored rows is DETECTED on read
 *   (tamper-evident surface — in-env pin of the read-path mapping);
 * - a full attach + SATISFIED verification flow leaves the Service Work
 *   record and attempts UNCHANGED (AC-2: business verification is
 *   distinct from transport/AI execution success AND from work
 *   lifecycle — /evidence never mutates work state);
 * - authorization happens BEFORE any domain data access; malformed
 *   inputs, unknown provenance kinds, AI-shaped verification
 *   declarations, foreign works/attempts and cross-tenant reads all
 *   fail closed with typed codes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidenceApp, type EvidenceAuthorityApp } from './helpers/in-memory-stores.js';
import type { Principal } from '../src/modules/auth/index.js';
import {
  EvidenceError,
  computeEvidenceContentHash,
  type AttachEvidenceInput,
  type OutcomeContractInput,
} from '../src/modules/evidence/index.js';

const PASSWORD = 'correct horse battery 7';
const NOW = new Date('2026-09-02T12:00:00.000Z');
const MISSING_UUID = '00000000-0000-4000-8000-000000000000';

/** Advancing clock: every write pins a distinct instant (durable order). */
function advancingClock(): () => Date {
  let tick = 0;
  return () => new Date(NOW.getTime() + tick++ * 1000);
}

interface Base {
  app: EvidenceAuthorityApp;
  owner: Principal;
  outsider: Principal;
  tenantId: string;
  otherTenantId: string;
  workId: string;
  attemptId: string;
  otherWorkId: string;
}

async function base(): Promise<Base> {
  const app = buildEvidenceApp({ now: advancingClock() });
  const owner = await app.auth.registerHuman({ email: 'owner@a.com', password: PASSWORD, displayName: 'Owner' });
  const outsider = await app.auth.registerHuman({ email: 'owner@b.com', password: PASSWORD, displayName: 'Outsider' });
  const created = await app.organizations.createOrganization(owner, { slug: 'alpha-org', displayName: 'Alpha' });
  const other = await app.organizations.createOrganization(outsider, { slug: 'beta-org', displayName: 'Beta' });
  const { work } = await app.work.createWork(owner, {
    tenantId: created.tenant.id,
    workType: 'CollectComplianceDocuments',
    title: 'Collect the subcontractor compliance package',
  });
  const { attempt } = await app.work.createAttempt(owner, created.tenant.id, work.id, { idempotencyKey: 'attempt-1' });
  const { work: otherWork } = await app.work.createWork(owner, {
    tenantId: created.tenant.id,
    workType: 'ValidateInsuranceCertificate',
    title: 'A different work item',
  });
  return {
    app,
    owner,
    outsider,
    tenantId: created.tenant.id,
    otherTenantId: other.tenant.id,
    workId: work.id,
    attemptId: attempt.id,
    otherWorkId: otherWork.id,
  };
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

function contractInput(evidenceRequirements: string[], over: Partial<OutcomeContractInput> = {}): OutcomeContractInput {
  return {
    outcomeId: 'compliance_package_complete',
    verification: 'deterministic',
    evidenceRequirements,
    ...over,
  };
}

async function evidenceError<T>(promise: Promise<T>): Promise<EvidenceError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof EvidenceError, `expected an EvidenceError, got ${(error as Error).message}`);
    return error;
  }
  throw new assert.AssertionError({ message: 'expected the call to fail closed' });
}

// ---------------------------------------------------------------------------
// Behavioral: attach + read (AC-1/AC-3)
// ---------------------------------------------------------------------------

test('evidence attaches with validated attribution and preserved provenance', async () => {
  const { app, owner, tenantId, workId, attemptId } = await base();
  const result = await app.evidence.attachEvidence(
    owner,
    evidenceInput(tenantId, workId, 'evidence-1', { workAttemptId: attemptId }),
  );
  assert.equal(result.converged, false);
  const record = result.evidence;
  assert.equal(record.tenantId, tenantId);
  assert.equal(record.serviceWorkId, workId);
  assert.equal(record.workAttemptId, attemptId);
  assert.equal(record.requirement, 'insurance_certificate_on_file');
  assert.deepEqual(record.provenance, {
    kind: 'external_record',
    source: 'carrier-portal-api',
    refs: ['carrier://certificate/acme-2026-0001'],
  });
  assert.deepEqual(record.payload, {
    carrier: 'Acme Mutual',
    policy: 'GL-2026-8899',
    coverage: 2000000,
    expiresOn: '2027-03-01',
  });
  assert.equal(record.observedAt.getTime(), new Date('2026-09-01T09:30:00.000Z').getTime());
  assert.equal(record.attachedBy, owner.id);
  assert.ok(record.attachedAt.getTime() >= NOW.getTime());
  // The actor-independent FACT content hash (the WORK-011 discipline).
  assert.equal(
    record.contentHash,
    computeEvidenceContentHash({
      tenantId,
      serviceWorkId: workId,
      workAttemptId: attemptId,
      requirement: 'insurance_certificate_on_file',
      provenance: { kind: 'external_record', source: 'carrier-portal-api', refs: ['carrier://certificate/acme-2026-0001'] },
      payload: { carrier: 'Acme Mutual', policy: 'GL-2026-8899', coverage: 2000000, expiresOn: '2027-03-01' },
      observedAt: new Date('2026-09-01T09:30:00.000Z'),
    }),
  );
  // Round-trip read (hash-verified).
  const read = await app.evidence.getEvidence(owner, tenantId, record.id);
  assert.equal(read.id, record.id);
  assert.equal(read.recordHash, record.recordHash);
});

test('evidence reads: list + filters; a missing read is distinguishable from an empty ledger', async () => {
  const { app, owner, tenantId, workId, attemptId } = await base();
  assert.deepEqual(await app.evidence.listEvidence(owner, tenantId, { serviceWorkId: workId }), []);
  const first = await app.evidence.attachEvidence(owner, evidenceInput(tenantId, workId, 'evidence-1'));
  const second = await app.evidence.attachEvidence(
    owner,
    evidenceInput(tenantId, workId, 'evidence-2', {
      requirement: 'license_validated',
      workAttemptId: attemptId,
      provenance: { kind: 'system_observation', source: 'license-check-worker', refs: [] },
      payload: { state: 'CA', valid: true },
    }),
  );
  const all = await app.evidence.listEvidence(owner, tenantId, { serviceWorkId: workId });
  assert.equal(all.length, 2);
  assert.equal(all[0]?.id, first.evidence.id);
  assert.equal(all[1]?.id, second.evidence.id);
  const byRequirement = await app.evidence.listEvidence(owner, tenantId, {
    serviceWorkId: workId,
    requirement: 'license_validated',
  });
  assert.equal(byRequirement.length, 1);
  assert.equal(byRequirement[0]?.id, second.evidence.id);
  const byAttempt = await app.evidence.listEvidence(owner, tenantId, {
    serviceWorkId: workId,
    workAttemptId: attemptId,
  });
  assert.equal(byAttempt.length, 1);
  assert.equal(byAttempt[0]?.id, second.evidence.id);
  // A missing single-record read is typed, not an empty result (lock #30).
  const missing = await evidenceError(app.evidence.getEvidence(owner, tenantId, MISSING_UUID));
  assert.equal(missing.code, 'EVIDENCE_NOT_FOUND');
});

// ---------------------------------------------------------------------------
// Behavioral: the deterministic outcome verification (AC-2/AC-4)
// ---------------------------------------------------------------------------

test('a satisfied outcome records the deterministic mapping with the exact evidence identities', async () => {
  const { app, owner, tenantId, workId } = await base();
  const attached = await app.evidence.attachEvidence(owner, evidenceInput(tenantId, workId, 'evidence-1'));
  const verified = await app.evidence.verifyOutcome(owner, {
    tenantId,
    serviceWorkId: workId,
    contract: contractInput(['insurance_certificate_on_file']),
    idempotencyKey: 'verify-1',
  });
  assert.equal(verified.converged, false);
  const decision = verified.verification;
  assert.equal(decision.verdict, 'satisfied');
  assert.equal(decision.outcomeId, 'compliance_package_complete');
  assert.equal(decision.verificationMode, 'deterministic');
  assert.deepEqual(decision.requirements, ['insurance_certificate_on_file']);
  assert.deepEqual(decision.requirementResults, [
    { requirement: 'insurance_certificate_on_file', satisfied: true, evidenceIds: [attached.evidence.id] },
  ]);
  assert.equal(decision.decidedBy, owner.id);
  assert.ok(decision.decidedAt.getTime() >= NOW.getTime());
  // Round-trip + latest read.
  const read = await app.evidence.getOutcomeVerification(owner, tenantId, decision.id);
  assert.equal(read.verdict, 'satisfied');
  const latest = await app.evidence.getLatestOutcomeVerification(owner, tenantId, workId, 'compliance_package_complete');
  assert.equal(latest.id, decision.id);
});

test('missing evidence is not_satisfied with the missing requirements listed (AC-4: no unearned success)', async () => {
  const { app, owner, tenantId, workId } = await base();
  await app.evidence.attachEvidence(owner, evidenceInput(tenantId, workId, 'evidence-1'));
  const verified = await app.evidence.verifyOutcome(owner, {
    tenantId,
    serviceWorkId: workId,
    contract: contractInput(['insurance_certificate_on_file', 'license_validated', 'vendor_acknowledgement']),
    idempotencyKey: 'verify-missing',
  });
  const decision = verified.verification;
  assert.equal(decision.verdict, 'not_satisfied');
  const missing = decision.requirementResults.filter((result) => !result.satisfied).map((result) => result.requirement);
  assert.deepEqual(missing, ['license_validated', 'vendor_acknowledgement']);
  // The satisfied requirement still maps to its evidence.
  assert.equal(decision.requirementResults[0]?.satisfied, true);
});

test('verification with NO attached evidence is not_satisfied on every requirement (fabricated completion fails)', async () => {
  const { app, owner, tenantId, workId } = await base();
  const verified = await app.evidence.verifyOutcome(owner, {
    tenantId,
    serviceWorkId: workId,
    contract: contractInput(['insurance_certificate_on_file', 'license_validated']),
    idempotencyKey: 'verify-empty',
  });
  assert.equal(verified.verification.verdict, 'not_satisfied');
  assert.ok(verified.verification.requirementResults.every((result) => !result.satisfied));
  assert.ok(verified.verification.requirementResults.every((result) => result.evidenceIds.length === 0));
});

test('the verdict is a pure function of the evidence set: more evidence flips a re-verification (new key)', async () => {
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
  // The missing evidence arrives.
  await app.evidence.attachEvidence(
    owner,
    evidenceInput(tenantId, workId, 'evidence-2', {
      requirement: 'license_validated',
      provenance: { kind: 'system_observation', source: 'license-check-worker', refs: [] },
      payload: { state: 'CA', valid: true },
    }),
  );
  // The SAME key over the changed evidence state fails closed: the
  // recorded decision pinned its input; a re-verification is a NEW
  // logical decision.
  const conflict = await evidenceError(
    app.evidence.verifyOutcome(owner, { tenantId, serviceWorkId: workId, contract, idempotencyKey: 'verify-1' }),
  );
  assert.equal(conflict.code, 'VERIFICATION_INPUT_CONFLICT');
  // A NEW key records the fresh deterministic decision.
  const second = await app.evidence.verifyOutcome(owner, {
    tenantId,
    serviceWorkId: workId,
    contract,
    idempotencyKey: 'verify-2',
  });
  assert.equal(second.verification.verdict, 'satisfied');
  // The latest-decision read reflects the newest state.
  const latest = await app.evidence.getLatestOutcomeVerification(owner, tenantId, workId, contract.outcomeId);
  assert.equal(latest.id, second.verification.id);
  assert.equal(latest.verdict, 'satisfied');
  // The ledger keeps BOTH decisions (immutable history — REQ-014).
  const ledger = await app.evidence.listOutcomeVerifications(owner, tenantId, { serviceWorkId: workId });
  assert.equal(ledger.length, 2);
  assert.equal(ledger[0]?.verdict, 'not_satisfied');
  assert.equal(ledger[1]?.verdict, 'satisfied');
});

test('the same verification re-run converges on the identical decision', async () => {
  const { app, owner, tenantId, workId } = await base();
  await app.evidence.attachEvidence(owner, evidenceInput(tenantId, workId, 'evidence-1'));
  const input = {
    tenantId,
    serviceWorkId: workId,
    contract: contractInput(['insurance_certificate_on_file']),
    idempotencyKey: 'verify-1',
  };
  const first = await app.evidence.verifyOutcome(owner, input);
  const retry = await app.evidence.verifyOutcome(owner, input);
  assert.equal(retry.converged, true);
  assert.equal(retry.verification.id, first.verification.id);
  assert.equal(retry.verification.verdict, first.verification.verdict);
  // Exactly one decision row exists.
  assert.equal((await app.evidence.listOutcomeVerifications(owner, tenantId)).length, 1);
});

test('the latest-decision read distinguishes missing from empty (lock #30)', async () => {
  const { app, owner, tenantId, workId } = await base();
  assert.deepEqual(await app.evidence.listOutcomeVerifications(owner, tenantId, { serviceWorkId: workId }), []);
  const error = await evidenceError(
    app.evidence.getLatestOutcomeVerification(owner, tenantId, workId, 'never_verified_outcome'),
  );
  assert.equal(error.code, 'VERIFICATION_NOT_FOUND');
});

// ---------------------------------------------------------------------------
// Behavioral: duplicate attachment convergence (invariant 6)
// ---------------------------------------------------------------------------

test('the same logical submission (same key, identical content) converges on ONE row', async () => {
  const { app, owner, tenantId, workId } = await base();
  const first = await app.evidence.attachEvidence(owner, evidenceInput(tenantId, workId, 'evidence-1'));
  const retry = await app.evidence.attachEvidence(owner, evidenceInput(tenantId, workId, 'evidence-1'));
  assert.equal(retry.converged, true);
  assert.equal(retry.evidence.id, first.evidence.id);
  assert.equal((await app.evidence.listEvidence(owner, tenantId)).length, 1);
});

test('the same FACT under a DIFFERENT key converges on ONE row (content convergence)', async () => {
  const { app, owner, tenantId, workId } = await base();
  const first = await app.evidence.attachEvidence(owner, evidenceInput(tenantId, workId, 'evidence-1'));
  const duplicate = await app.evidence.attachEvidence(owner, evidenceInput(tenantId, workId, 'evidence-other-key'));
  assert.equal(duplicate.converged, true);
  assert.equal(duplicate.evidence.id, first.evidence.id);
  assert.equal((await app.evidence.listEvidence(owner, tenantId)).length, 1);
  // Even a DIFFERENT PRINCIPAL re-reporting the same fact converges
  // (the content hash pins the fact, actor-independent).
  const colleague = await app.auth.registerHuman({ email: 'member@a.com', password: PASSWORD, displayName: 'Member' });
  await app.organizations.addMember(owner, 'alpha-org', { principalId: colleague.id, role: 'member' });
  const reReported = await app.evidence.attachEvidence(colleague, evidenceInput(tenantId, workId, 'evidence-third-key'));
  assert.equal(reReported.converged, true);
  assert.equal(reReported.evidence.id, first.evidence.id);
});

test('the same key on a DIFFERENT work item records a SEPARATE row (attribution is per work)', async () => {
  const { app, owner, tenantId, workId, otherWorkId } = await base();
  const first = await app.evidence.attachEvidence(owner, evidenceInput(tenantId, workId, 'evidence-1'));
  // The content identity is scoped to (tenant, work): the same
  // evidence payload attributed to ANOTHER work item is a distinct
  // fact (attribution is part of the fact) — no cross-work dedup.
  const elsewhere = await app.evidence.attachEvidence(owner, evidenceInput(tenantId, otherWorkId, 'evidence-2'));
  assert.equal(elsewhere.converged, false);
  assert.notEqual(elsewhere.evidence.id, first.evidence.id);
  assert.equal((await app.evidence.listEvidence(owner, tenantId)).length, 2);
});

test('the same key with divergent content fails closed', async () => {
  const { app, owner, tenantId, workId } = await base();
  await app.evidence.attachEvidence(owner, evidenceInput(tenantId, workId, 'evidence-1'));
  const error = await evidenceError(
    app.evidence.attachEvidence(
      owner,
      evidenceInput(tenantId, workId, 'evidence-1', {
        payload: { carrier: 'Acme Mutual', policy: 'GL-2026-8899', coverage: 5000000, expiresOn: '2027-03-01' },
      }),
    ),
  );
  assert.equal(error.code, 'EVIDENCE_INPUT_CONFLICT');
});

// ---------------------------------------------------------------------------
// Discrimination: wrong-work evidence never satisfies (invariant 5)
// ---------------------------------------------------------------------------

test('WRONG-WORK evidence cannot satisfy another work item outcome (invariant 5)', async () => {
  const { app, owner, tenantId, workId, otherWorkId } = await base();
  // The evidence is attached to the OTHER work item.
  await app.evidence.attachEvidence(owner, evidenceInput(tenantId, otherWorkId, 'evidence-other'));
  const verified = await app.evidence.verifyOutcome(owner, {
    tenantId,
    serviceWorkId: workId,
    contract: contractInput(['insurance_certificate_on_file']),
    idempotencyKey: 'verify-wrong-work',
  });
  assert.equal(verified.verification.verdict, 'not_satisfied');
  assert.deepEqual(verified.verification.requirementResults, [
    { requirement: 'insurance_certificate_on_file', satisfied: false, evidenceIds: [] },
  ]);
  // And the mirror: the other work item IS satisfied by its own evidence.
  const other = await app.evidence.verifyOutcome(owner, {
    tenantId,
    serviceWorkId: otherWorkId,
    contract: contractInput(['insurance_certificate_on_file']),
    idempotencyKey: 'verify-other',
  });
  assert.equal(other.verification.verdict, 'satisfied');
});

test('attempt-attributed evidence still satisfies the WORK outcome (the decision scope is the work)', async () => {
  const { app, owner, tenantId, workId, attemptId } = await base();
  await app.evidence.attachEvidence(
    owner,
    evidenceInput(tenantId, workId, 'evidence-attempt', { workAttemptId: attemptId }),
  );
  const verified = await app.evidence.verifyOutcome(owner, {
    tenantId,
    serviceWorkId: workId,
    contract: contractInput(['insurance_certificate_on_file']),
    idempotencyKey: 'verify-attempt-scope',
  });
  assert.equal(verified.verification.verdict, 'satisfied');
  assert.deepEqual(verified.verification.requirementResults[0]?.evidenceIds.length, 1);
});

// ---------------------------------------------------------------------------
// Discrimination: no work mutation, no lifecycle (AC-2; forbidden surface)
// ---------------------------------------------------------------------------

test('a full attach + SATISFIED verification leaves the Service Work record and attempts UNCHANGED', async () => {
  const { app, owner, tenantId, workId, attemptId } = await base();
  const workBefore = await app.work.getWork(owner, tenantId, workId);
  const attemptsBefore = await app.work.listAttempts(owner, tenantId, workId);
  await app.evidence.attachEvidence(
    owner,
    evidenceInput(tenantId, workId, 'evidence-1', { workAttemptId: attemptId }),
  );
  const verified = await app.evidence.verifyOutcome(owner, {
    tenantId,
    serviceWorkId: workId,
    contract: contractInput(['insurance_certificate_on_file']),
    idempotencyKey: 'verify-1',
  });
  assert.equal(verified.verification.verdict, 'satisfied');
  const workAfter = await app.work.getWork(owner, tenantId, workId);
  const attemptsAfter = await app.work.listAttempts(owner, tenantId, workId);
  assert.deepEqual(workAfter, workBefore);
  assert.deepEqual(attemptsAfter, attemptsBefore);
});

test('late evidence attaches to a superseded attempt without mutating work state (no status gate)', async () => {
  const { app, owner, tenantId, workId, attemptId } = await base();
  // Dispatch the original attempt, then create the post-dispatch retry:
  // the original is superseded (the /work retry protocol).
  await app.work.dispatchAttempt(owner, tenantId, attemptId);
  const { attempt: retryAttempt } = await app.work.createAttempt(owner, tenantId, workId, { idempotencyKey: 'attempt-2' });
  assert.equal(retryAttempt.supersedesId, attemptId);
  const attemptsBefore = await app.work.listAttempts(owner, tenantId, workId);
  // A late result arrives for the FIRST (now superseded) attempt.
  const late = await app.evidence.attachEvidence(
    owner,
    evidenceInput(tenantId, workId, 'evidence-late', { workAttemptId: attemptId }),
  );
  assert.equal(late.converged, false);
  assert.equal(late.evidence.workAttemptId, attemptId);
  // The work and attempts are UNCHANGED by the evidence append.
  assert.deepEqual(await app.work.listAttempts(owner, tenantId, workId), attemptsBefore);
});

// ---------------------------------------------------------------------------
// Discrimination: tamper-evident reads (AC-3; in-env pin of the mapping)
// ---------------------------------------------------------------------------

test('out-of-band mutation of stored rows is detected on read (tamper-evident surface)', async () => {
  const { app, owner, tenantId, workId } = await base();
  const attached = await app.evidence.attachEvidence(owner, evidenceInput(tenantId, workId, 'evidence-1'));
  const verified = await app.evidence.verifyOutcome(owner, {
    tenantId,
    serviceWorkId: workId,
    contract: contractInput(['insurance_certificate_on_file']),
    idempotencyKey: 'verify-1',
  });
  // 1. Evidence CONTENT tamper: a schema-legal, hash-covered column.
  const stored = app.evidenceStore.evidence.get(attached.evidence.id);
  assert.ok(stored !== undefined);
  stored.payload = { carrier: 'Tampered Carrier', policy: 'XX-0000', coverage: 1, expiresOn: '2030-01-01' };
  const tamperedEvidence = await evidenceError(app.evidence.getEvidence(owner, tenantId, attached.evidence.id));
  assert.equal(tamperedEvidence.code, 'EVIDENCE_RECORD_TAMPERED');
  // 2. Evidence PROVENANCE tamper (the record hash covers provenance).
  stored.payload = JSON.parse(
    JSON.stringify({
      carrier: 'Acme Mutual',
      policy: 'GL-2026-8899',
      coverage: 2000000,
      expiresOn: '2027-03-01',
    }),
  );
  stored.provenance = { ...stored.provenance, source: 'fabricated-source' };
  const tamperedProvenance = await evidenceError(app.evidence.listEvidence(owner, tenantId, { serviceWorkId: workId }));
  assert.equal(tamperedProvenance.code, 'EVIDENCE_RECORD_TAMPERED');
  // 3. Verification VERDICT tamper (the record hash covers the verdict).
  const storedDecision = app.evidenceStore.verifications.get(verified.verification.id);
  assert.ok(storedDecision !== undefined);
  storedDecision.verdict = 'not_satisfied';
  const tamperedDecision = await evidenceError(
    app.evidence.getOutcomeVerification(owner, tenantId, verified.verification.id),
  );
  assert.equal(tamperedDecision.code, 'VERIFICATION_RECORD_TAMPERED');
  // 4. Verification REQUIREMENT MAPPING tamper.
  storedDecision.verdict = 'satisfied';
  storedDecision.requirementResults = [
    { requirement: 'insurance_certificate_on_file', satisfied: false, evidenceIds: [] },
  ];
  const tamperedMapping = await evidenceError(
    app.evidence.getLatestOutcomeVerification(owner, tenantId, workId, 'compliance_package_complete'),
  );
  assert.equal(tamperedMapping.code, 'VERIFICATION_RECORD_TAMPERED');
});

// ---------------------------------------------------------------------------
// Discrimination: authorization before data; attribution validation
// ---------------------------------------------------------------------------

test('authorization happens BEFORE any domain data access', async () => {
  const { app, owner, outsider, tenantId, workId } = await base();
  const before = { ...app.evidenceStore.reads };
  const deniedAttach = await evidenceError(
    app.evidence.attachEvidence(outsider, evidenceInput(tenantId, workId, 'evidence-denied')),
  );
  assert.equal(deniedAttach.code, 'TENANT_FORBIDDEN');
  const deniedVerify = await evidenceError(
    app.evidence.verifyOutcome(outsider, {
      tenantId,
      serviceWorkId: workId,
      contract: contractInput(['insurance_certificate_on_file']),
      idempotencyKey: 'verify-denied',
    }),
  );
  assert.equal(deniedVerify.code, 'TENANT_FORBIDDEN');
  const deniedRead = await evidenceError(app.evidence.listEvidence(outsider, tenantId));
  assert.equal(deniedRead.code, 'TENANT_FORBIDDEN');
  const deniedLatest = await evidenceError(
    app.evidence.getLatestOutcomeVerification(outsider, tenantId, workId, 'compliance_package_complete'),
  );
  assert.equal(deniedLatest.code, 'TENANT_FORBIDDEN');
  // No store read happened during any denial.
  assert.deepEqual(app.evidenceStore.reads, before);
});

test('cross-tenant reads fail closed with the tenant predicate', async () => {
  const { app, owner, outsider, tenantId, workId, otherTenantId } = await base();
  const attached = await app.evidence.attachEvidence(owner, evidenceInput(tenantId, workId, 'evidence-1'));
  const foreign = await evidenceError(app.evidence.getEvidence(outsider, otherTenantId, attached.evidence.id));
  assert.equal(foreign.code, 'EVIDENCE_NOT_FOUND');
  const foreignList = await app.evidence.listEvidence(outsider, otherTenantId, { serviceWorkId: workId });
  assert.deepEqual(foreignList, []);
});

test('attribution validation: foreign work, foreign attempt, foreign tenant all fail closed', async () => {
  const { app, owner, tenantId, workId, otherWorkId, attemptId, otherTenantId } = await base();
  const foreignWork = await evidenceError(
    app.evidence.attachEvidence(
      owner,
      evidenceInput(tenantId, '00000000-0000-4000-8000-000000000000', 'evidence-foreign-work'),
    ),
  );
  assert.equal(foreignWork.code, 'WORK_NOT_FOUND');
  const foreignTenant = await evidenceError(
    app.evidence.attachEvidence(owner, evidenceInput(otherTenantId, workId, 'evidence-foreign-tenant')),
  );
  assert.equal(foreignTenant.code, 'TENANT_FORBIDDEN');
  const foreignAttempt = await evidenceError(
    app.evidence.attachEvidence(
      owner,
      evidenceInput(tenantId, otherWorkId, 'evidence-foreign-attempt', { workAttemptId: attemptId }),
    ),
  );
  assert.equal(foreignAttempt.code, 'ATTEMPT_NOT_FOUND');
  const verifyForeignWork = await evidenceError(
    app.evidence.verifyOutcome(owner, {
      tenantId,
      serviceWorkId: '00000000-0000-4000-8000-000000000000',
      contract: contractInput(['insurance_certificate_on_file']),
      idempotencyKey: 'verify-foreign-work',
    }),
  );
  assert.equal(verifyForeignWork.code, 'WORK_NOT_FOUND');
});

// ---------------------------------------------------------------------------
// Discrimination: malformed input and AI-shaped declarations fail closed
// ---------------------------------------------------------------------------

test('malformed evidence inputs fail closed with typed codes', async () => {
  const { app, owner, tenantId, workId } = await base();
  const cases: { input: AttachEvidenceInput; code: string }[] = [
    { input: evidenceInput(tenantId, workId, 'bad-1', { requirement: 'not a valid identifier!' }), code: 'INVALID_INPUT' },
    {
      input: evidenceInput(tenantId, workId, 'bad-2', {
        provenance: { kind: 'ai_model_claim' as never, source: 'llm', refs: [] },
      }),
      code: 'INVALID_INPUT',
    },
    {
      input: evidenceInput(tenantId, workId, 'bad-3', {
        provenance: { kind: 'external_record', source: '   ', refs: [] },
      }),
      code: 'INVALID_INPUT',
    },
    {
      input: evidenceInput(tenantId, workId, 'bad-4', {
        provenance: { kind: 'external_record', source: 'portal', refs: ['not a valid ref!'] },
      }),
      code: 'INVALID_INPUT',
    },
    { input: evidenceInput(tenantId, workId, 'bad-5', { payload: undefined }), code: 'INVALID_INPUT' },
    { input: evidenceInput(tenantId, workId, 'bad-6', { observedAt: undefined as unknown as Date }), code: 'INVALID_INPUT' },
    { input: evidenceInput(tenantId, workId, 'bad-7', { idempotencyKey: '' }), code: 'INVALID_INPUT' },
    { input: evidenceInput('not-a-uuid', workId, 'bad-8'), code: 'INVALID_INPUT' },
    { input: evidenceInput(tenantId, 'not-a-uuid', 'bad-9'), code: 'INVALID_INPUT' },
  ];
  for (const { input, code } of cases) {
    const error = await evidenceError(app.evidence.attachEvidence(owner, input));
    assert.equal(error.code, code);
  }
  // Nothing persisted.
  assert.equal((await app.evidence.listEvidence(owner, tenantId)).length, 0);
});

test('AI-shaped verification declarations fail closed (no AI evaluator surface)', async () => {
  const { app, owner, tenantId, workId } = await base();
  const aiMode = await evidenceError(
    app.evidence.verifyOutcome(owner, {
      tenantId,
      serviceWorkId: workId,
      contract: contractInput(['insurance_certificate_on_file'], { verification: 'ai_execution' as never }),
      idempotencyKey: 'verify-ai',
    }),
  );
  assert.equal(aiMode.code, 'AI_VERIFICATION_FORBIDDEN');
  const forbiddenKey = await evidenceError(
    app.evidence.verifyOutcome(owner, {
      tenantId,
      serviceWorkId: workId,
      contract: contractInput(['insurance_certificate_on_file'], {
        verification: 'deterministic',
        ...({ model: 'gpt-x' } as unknown as Record<string, never>),
      }),
      idempotencyKey: 'verify-ai-key',
    }),
  );
  assert.equal(forbiddenKey.code, 'AI_VERIFICATION_FORBIDDEN');
  const duplicateRequirements = await evidenceError(
    app.evidence.verifyOutcome(owner, {
      tenantId,
      serviceWorkId: workId,
      contract: contractInput(['insurance_certificate_on_file', 'insurance_certificate_on_file']),
      idempotencyKey: 'verify-dup',
    }),
  );
  assert.equal(duplicateRequirements.code, 'INVALID_INPUT');
  const emptyRequirements = await evidenceError(
    app.evidence.verifyOutcome(owner, {
      tenantId,
      serviceWorkId: workId,
      contract: contractInput([]),
      idempotencyKey: 'verify-empty-req',
    }),
  );
  assert.equal(emptyRequirements.code, 'INVALID_INPUT');
  // Nothing persisted.
  assert.equal((await app.evidence.listOutcomeVerifications(owner, tenantId)).length, 0);
});

// ---------------------------------------------------------------------------
// Discrimination: the contract shapes WORK-009 declares are compatible
// ---------------------------------------------------------------------------

test('the /services-compatible verification modes all evaluate deterministically', async () => {
  const { app, owner, tenantId, workId } = await base();
  await app.evidence.attachEvidence(owner, evidenceInput(tenantId, workId, 'evidence-1'));
  for (const verification of ['deterministic', 'human_approval', 'external_record'] as const) {
    const verified = await app.evidence.verifyOutcome(owner, {
      tenantId,
      serviceWorkId: workId,
      contract: contractInput(['insurance_certificate_on_file'], { verification }),
      idempotencyKey: `verify-${verification}`,
    });
    // Every mode maps through the SAME deterministic evidence rule —
    // the mode is business metadata, never an AI evaluation switch.
    assert.equal(verified.verification.verdict, 'satisfied');
    assert.equal(verified.verification.verificationMode, verification);
  }
});
