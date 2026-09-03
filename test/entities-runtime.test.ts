/**
 * WORK-010 runtime behavioral proofs: the /entities entity-instance
 * authority + the Construction Subcontractor Compliance flow.
 *
 * Proofs (the Work Order's behavioral verification requirements):
 * - the entity authority: package-validated creation, declared-type
 *   discipline, keyed convergence (and divergent fail-closed), tenant
 *   isolation, tamper detection, missing-package/type distinction;
 * - the Construction vertical package registers through /verticals'
 *   public surface (declaration validation end to end);
 * - HAPPY PATH: onboarding -> document collection -> deterministic
 *   validation -> verification -> completed + the auditable
 *   compliance package (AC-1..AC-7);
 * - MISSING DOCUMENT: evaluation without documents lists the missing
 *   requirements and reworks; governed chase follow-up work + ONE
 *   durable vendor contact (AC-4/AC-5);
 * - EXPIRED INSURANCE: the deterministic rule fires CERTIFICATE_EXPIRED
 *   (AC-3);
 * - NONCOMPLIANT LIMITS: below-minimum limits fire the limit findings
 *   and block completion (AC-3/AC-6);
 * - VENDOR CORRECTION/RETRY: a corrected certificate is a NEW entity
 *   instance + NEW evidence; re-evaluation with a new key converges to
 *   compliant — and the STALE attempt re-running its OLD key after the
 *   evidence changed fails closed (the newer decision stands) (AC-2/
 *   discrimination);
 * - ZECK DOCUMENT REASONING: the flow submits the intent through /zeck
 *   with the package-DECLARED capability requirement; the extracted
 *   facts enter as evidence citing the foreign execution; the
 *   deterministic rule still decides (AC-3/AC-6);
 * - EXCEPTION ESCALATION: the human approval request terminalizes;
 *   approve resumes, reject fails the work (AC-4).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildConstructionApp,
  prepareConstructionTenant,
  createConstructionProject,
  registerConstructionPackage,
  COMPLIANT_INSURANCE,
  type ConstructionApp,
  type ConstructionTenant,
} from './helpers/in-memory-stores.js';
import { createInMemoryZeckGateway } from '../src/modules/zeck/index.js';
import { EntitiesError, ConstructionError, constructionVerticalPackage } from '../src/modules/entities/index.js';
import { validateInsuranceCompliance, validateW9Compliance, validateLicenseCompliance } from '../src/modules/entities/index.js';

async function withTenant(run: (t: ConstructionTenant) => Promise<void>): Promise<void> {
  const app = buildConstructionApp();
  const tenant = await prepareConstructionTenant(app);
  await run(tenant);
}

function compliantW9(app: ConstructionApp, taxId: string): Record<string, unknown> {
  void app;
  return { taxId };
}

function compliantLicense(): Record<string, unknown> {
  return {
    licenseNumber: 'GC-90210',
    jurisdiction: 'CA',
    expiresAt: new Date('2027-03-31T00:00:00.000Z').toISOString(),
    active: true,
  };
}

/** Onboard a subcontractor and return the flow artifacts + the project. */
async function onboarded(t: ConstructionTenant, key = 'onboard-1') {
  const project = await createConstructionProject(t.app, t.owner, t.tenantId);
  const result = await t.app.construction.onboardSubcontractor(t.owner, {
    tenantId: t.tenantId,
    packageVersion: 1,
    projectInstanceId: project.id,
    subcontractor: { name: 'Acme Electrical', contactEmail: 'vendor@acme.com', taxId: '12-3456789', trade: 'electrical' },
    idempotencyKey: key,
  });
  return { ...result, project };
}

// ---------------------------------------------------------------------------
// The entity-instance authority
// ---------------------------------------------------------------------------

test('entity instances validate against the registered package declaration (fail closed)', async () => {
  await withTenant(async (t) => {
    // A package that was never registered in THIS tenant is a typed
    // missing-package error (distinguishable from an empty result).
    await assert.rejects(
      t.app.entities.createEntityInstance(t.owner, {
        tenantId: t.tenantId,
        packageId: 'construction',
        packageVersion: 2,
        entityType: 'Project',
        fields: { name: 'X' },
      }),
      (error: unknown) => error instanceof EntitiesError && error.code === 'VERTICAL_PACKAGE_NOT_FOUND',
    );
    // An entity type the package does not declare.
    await assert.rejects(
      t.app.entities.createEntityInstance(t.owner, {
        tenantId: t.tenantId,
        packageId: 'construction',
        packageVersion: 1,
        entityType: 'Crane',
        fields: {},
      }),
      (error: unknown) => error instanceof EntitiesError && error.code === 'ENTITY_TYPE_NOT_DECLARED',
    );
    // A field the entity does not declare.
    await assert.rejects(
      t.app.entities.createEntityInstance(t.owner, {
        tenantId: t.tenantId,
        packageId: 'construction',
        packageVersion: 1,
        entityType: 'Project',
        fields: { name: 'X', craneTonnage: 20 },
        idempotencyKey: 'bad-field',
      }),
      (error: unknown) => error instanceof EntitiesError && error.code === 'FIELD_NOT_DECLARED',
    );
    // A required field missing.
    await assert.rejects(
      t.app.entities.createEntityInstance(t.owner, {
        tenantId: t.tenantId,
        packageId: 'construction',
        packageVersion: 1,
        entityType: 'Project',
        fields: { name: 'X' },
        idempotencyKey: 'missing-required',
      }),
      (error: unknown) => error instanceof EntitiesError && error.code === 'FIELD_REQUIRED',
    );
    // A type mismatch.
    await assert.rejects(
      t.app.entities.createEntityInstance(t.owner, {
        tenantId: t.tenantId,
        packageId: 'construction',
        packageVersion: 1,
        entityType: 'Project',
        fields: { name: 'X', minGlPerOccurrenceUsd: 'lots' },
        idempotencyKey: 'type-mismatch',
      }),
      (error: unknown) => error instanceof EntitiesError && error.code === 'FIELD_TYPE_MISMATCH',
    );
  });
});

test('entity instances converge by key, reject divergent content, normalize dates, and stay tenant-isolated', async () => {
  await withTenant(async (t) => {
    const fields = {
      name: 'Riverside Tower',
      minGlPerOccurrenceUsd: 1_000_000,
      minUmbrellaAggregateUsd: 2_000_000,
      expiryLeadDays: 30,
      projectNamedAdditionalInsured: true,
      requireW9: false,
      requireLicense: true,
    };
    const first = await t.app.entities.createEntityInstance(t.owner, {
      tenantId: t.tenantId,
      packageId: 'construction',
      packageVersion: 1,
      entityType: 'Project',
      fields,
      idempotencyKey: 'conv-1',
    });
    assert.equal(first.converged, false);
    // Identical re-submission converges on the SAME durable instance.
    const retry = await t.app.entities.createEntityInstance(t.owner, {
      tenantId: t.tenantId,
      packageId: 'construction',
      packageVersion: 1,
      entityType: 'Project',
      fields,
      idempotencyKey: 'conv-1',
    });
    assert.equal(retry.converged, true);
    assert.equal(retry.instance.id, first.instance.id);
    // Divergent content under the same key fails closed.
    await assert.rejects(
      t.app.entities.createEntityInstance(t.owner, {
        tenantId: t.tenantId,
        packageId: 'construction',
        packageVersion: 1,
        entityType: 'Project',
        fields: { ...fields, name: 'Different' },
        idempotencyKey: 'conv-1',
      }),
      (error: unknown) => error instanceof EntitiesError && error.code === 'ENTITY_INPUT_CONFLICT',
    );
    // Date fields normalize to canonical ISO form.
    const cert = await t.app.entities.createEntityInstance(t.owner, {
      tenantId: t.tenantId,
      packageId: 'construction',
      packageVersion: 1,
      entityType: 'InsuranceCertificate',
      fields: {
        glPerOccurrenceUsd: 1,
        umbrellaAggregateUsd: 2,
        expiresAt: '2027-06-30',
        certificateHolder: 'X',
      },
      idempotencyKey: 'date-normalization',
    });
    assert.equal(cert.instance.fields.expiresAt, new Date('2027-06-30T00:00:00.000Z').toISOString());
    // Cross-tenant reads fail closed (a foreign row is indistinguishable
    // from a missing one).
    await assert.rejects(
      t.app.entities.getEntityInstance(t.outsider, t.otherTenantId, first.instance.id),
      (error: unknown) => error instanceof EntitiesError && error.code === 'ENTITY_NOT_FOUND',
    );
    // A missing read is distinguishable from an empty list.
    const listed = await t.app.entities.listEntityInstances(t.owner, t.tenantId, { entityType: 'Project' });
    assert.equal(listed.length, 1);
    await assert.rejects(
      t.app.entities.getEntityInstance(t.owner, t.tenantId, '00000000-0000-4000-8000-000000000000'),
      (error: unknown) => error instanceof EntitiesError && error.code === 'ENTITY_NOT_FOUND',
    );
    // Tamper detection: mutating the stored record breaks the read.
    const stored = t.app.entitiesStore.instances.get(cert.instance.id);
    assert.ok(stored !== undefined);
    const original = (stored as { fields: Record<string, unknown> }).fields.certificateHolder;
    (stored as { fields: Record<string, unknown> }).fields.certificateHolder = 'tampered';
    await assert.rejects(
      t.app.entities.getEntityInstance(t.owner, t.tenantId, cert.instance.id),
      (error: unknown) => error instanceof EntitiesError && error.code === 'ENTITY_RECORD_TAMPERED',
    );
    (stored as { fields: Record<string, unknown> }).fields.certificateHolder = original;
  });
});

test('the Construction vertical package registers through /verticals and converges on re-registration', async () => {
  await withTenant(async (t) => {
    const pkg = await registerConstructionPackage(t.app, t.owner, t.tenantId);
    assert.equal(pkg.packageId, 'construction');
    assert.equal(pkg.version, 1);
    assert.ok(pkg.entities.some((entity) => entity.name === 'Subcontractor'));
    assert.ok(pkg.workTypes.some((workType) => workType.name === 'construction.chase_missing_document'));
    assert.ok(pkg.evidenceRequirements.some((requirement) => requirement.name === 'construction.compliance_package'));
    assert.equal(pkg.zeckCapabilityRequirements[0]?.capability, 'document.reasoning');
    // The same content re-registers (converges) through /verticals' own
    // idempotency discipline.
    const again = await registerConstructionPackage(t.app, t.owner, t.tenantId);
    assert.equal(again.id, pkg.id);
    // The package content factory is pure data (deterministic content).
    const contentA = constructionVerticalPackage('tenant-a');
    const contentB = constructionVerticalPackage('tenant-b');
    assert.deepEqual(
      { ...contentA, tenantId: 'x' },
      { ...contentB, tenantId: 'x' },
    );
  });
});

// ---------------------------------------------------------------------------
// The flow: happy path (AC-1..AC-7)
// ---------------------------------------------------------------------------

test('happy path: onboarding through verified-compliant and the auditable package', async () => {
  await withTenant(async (t) => {
    const onboarding = await onboarded(t);
    // AC-1: the subcontractor is onboarded into the project.
    assert.equal(onboarding.serviceWork.status, 'waiting_information');
    assert.equal(onboarding.subcontractor.entityType, 'Subcontractor');
    assert.equal(onboarding.requirements.length, 3);
    // AC-2: required documents were requested (durable interaction) and tracked.
    assert.equal(onboarding.collectionRequest.state, 'dispatched');
    assert.equal(onboarding.collectionRequest.correlation.serviceWorkId, onboarding.serviceWork.id);

    // AC-2: each required document arrives and is tracked as evidence.
    await t.app.construction.receiveVendorDocument(t.owner, {
      tenantId: t.tenantId,
      serviceWorkId: onboarding.serviceWork.id,
      kind: 'insurance_certificate',
      document: { ...COMPLIANT_INSURANCE },
      receivedAt: new Date('2026-09-03T09:00:00.000Z'),
      idempotencyKey: 'doc-ins-1',
    });
    await t.app.construction.receiveVendorDocument(t.owner, {
      tenantId: t.tenantId,
      serviceWorkId: onboarding.serviceWork.id,
      kind: 'w9',
      document: compliantW9(t.app, '12-3456789'),
      receivedAt: new Date('2026-09-03T09:05:00.000Z'),
      idempotencyKey: 'doc-w9-1',
    });
    await t.app.construction.receiveVendorDocument(t.owner, {
      tenantId: t.tenantId,
      serviceWorkId: onboarding.serviceWork.id,
      kind: 'license',
      document: compliantLicense(),
      receivedAt: new Date('2026-09-03T09:10:00.000Z'),
      idempotencyKey: 'doc-lic-1',
    });
    const resumed = await t.app.work.getWork(t.owner, t.tenantId, onboarding.serviceWork.id);
    assert.equal(resumed.status, 'in_progress');

    // AC-3/AC-6: deterministic validation + the ServiceOS business
    // verification decision.
    const evaluation = await t.app.construction.evaluateCompliance(t.owner, {
      tenantId: t.tenantId,
      serviceWorkId: onboarding.serviceWork.id,
      idempotencyKey: 'eval-1',
    });
    assert.equal(evaluation.verdict, 'satisfied');
    assert.equal(evaluation.compliant, true);
    assert.equal(evaluation.insuranceValidation?.compliant, true);
    assert.equal(evaluation.w9Validation?.compliant, true);
    assert.equal(evaluation.licenseValidation?.compliant, true);
    assert.equal(evaluation.serviceWork.status, 'completed');

    // AC-7: the auditable compliance package.
    const pack = await t.app.construction.assembleCompliancePackage(t.owner, {
      tenantId: t.tenantId,
      serviceWorkId: onboarding.serviceWork.id,
      idempotencyKey: 'package-1',
    });
    assert.equal(typeof pack.packageHash, 'string');
    assert.equal(pack.packageHash.length, 64);
    const document = pack.packageDocument as Record<string, unknown>;
    assert.equal(document.vertical, 'construction');
    assert.equal(document.workState, 'completed');
    const verification = document.verification as { verdict: string };
    assert.equal(verification.verdict, 'satisfied');
    // Package assembly is idempotent (keyed convergence on the evidence).
    const again = await t.app.construction.assembleCompliancePackage(t.owner, {
      tenantId: t.tenantId,
      serviceWorkId: onboarding.serviceWork.id,
      idempotencyKey: 'package-1',
    });
    assert.equal(again.packageHash, pack.packageHash);
    assert.equal(again.packageEvidence.id, pack.packageEvidence.id);

    // The derived status surface (no second state).
    const status = await t.app.construction.getComplianceStatus(t.owner, {
      tenantId: t.tenantId,
      serviceWorkId: onboarding.serviceWork.id,
    });
    assert.equal(status.serviceWork.status, 'completed');
    assert.equal(status.verification?.verdict, 'satisfied');
    assert.deepEqual(status.missing, []);

    // The whole onboarding is replay-safe: the same key converges on the
    // same artifacts (no duplicate contacts or entities).
    const replay = await t.app.construction.onboardSubcontractor(t.owner, {
      tenantId: t.tenantId,
      packageVersion: 1,
      projectInstanceId: onboarding.project.id,
      subcontractor: { name: 'Acme Electrical', contactEmail: 'vendor@acme.com', taxId: '12-3456789', trade: 'electrical' },
      idempotencyKey: 'onboard-1',
    });
    assert.equal(replay.serviceWork.id, onboarding.serviceWork.id);
    assert.equal(replay.subcontractor.id, onboarding.subcontractor.id);
    assert.equal(replay.collectionRequest.id, onboarding.collectionRequest.id);
    const interactions = await t.app.interactions.listInteractions(t.owner, t.tenantId, {
      correlation: { key: 'serviceWorkId', value: onboarding.serviceWork.id },
    });
    assert.equal(interactions.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Missing document + governed follow-up (AC-4/AC-5)
// ---------------------------------------------------------------------------

test('missing document: evaluation lists the gap, reworks, and the chase is governed follow-up work with ONE contact', async () => {
  await withTenant(async (t) => {
    const onboarding = await onboarded(t, 'onboard-missing');
    // No documents arrive.
    const evaluation = await t.app.construction.evaluateCompliance(t.owner, {
      tenantId: t.tenantId,
      serviceWorkId: onboarding.serviceWork.id,
      idempotencyKey: 'eval-missing-1',
    });
    assert.equal(evaluation.verdict, 'not_satisfied');
    assert.equal(evaluation.compliant, false);
    assert.ok(evaluation.missing.includes('construction.insurance_certificate'));
    assert.ok(evaluation.missing.includes('construction.w9'));
    assert.ok(evaluation.missing.includes('construction.license'));
    assert.equal(evaluation.serviceWork.status, 'in_progress');

    // The governed follow-up: REAL chase work + one durable contact.
    const chase = await t.app.construction.chaseMissingDocuments(t.owner, {
      tenantId: t.tenantId,
      serviceWorkId: onboarding.serviceWork.id,
      round: 1,
    });
    assert.equal(chase.followUpWork.workType, 'construction.chase_missing_document');
    assert.equal(chase.followUpWork.status, 'in_progress');
    assert.equal(chase.chase.state, 'dispatched');
    // The unsatisfied requirement set: the missing documents AND their
    // missing deterministic validations (insurance + w9 + license +
    // license_validation + insurance_validation).
    assert.equal(chase.missing.length, 5);
    // The follow-up contact correlates to the compliance work.
    assert.equal(chase.chase.correlation.serviceWorkId, onboarding.serviceWork.id);
    // Re-invoking the SAME round converges on the SAME contact (AC-5
    // replay-safety; the concurrency file proves the parallel case).
    const retry = await t.app.construction.chaseMissingDocuments(t.owner, {
      tenantId: t.tenantId,
      serviceWorkId: onboarding.serviceWork.id,
      round: 1,
    });
    assert.equal(retry.chase.id, chase.chase.id);
    assert.equal(retry.followUpWork.id, chase.followUpWork.id);
    // A new round is a NEW governed contact.
    const chase2 = await t.app.construction.chaseMissingDocuments(t.owner, {
      tenantId: t.tenantId,
      serviceWorkId: onboarding.serviceWork.id,
      round: 2,
    });
    assert.notEqual(chase2.chase.id, chase.chase.id);
  });
});

// ---------------------------------------------------------------------------
// Expired insurance / noncompliant limits (AC-3)
// ---------------------------------------------------------------------------

test('expired insurance fires the deterministic expiry finding and blocks compliance', async () => {
  await withTenant(async (t) => {
    const onboarding = await onboarded(t, 'onboard-expired');
    await t.app.construction.receiveVendorDocument(t.owner, {
      tenantId: t.tenantId,
      serviceWorkId: onboarding.serviceWork.id,
      kind: 'insurance_certificate',
      document: {
        ...COMPLIANT_INSURANCE,
        expiresAt: new Date('2026-08-01T00:00:00.000Z').toISOString(), // before the decision instant
      },
      receivedAt: new Date('2026-09-03T09:00:00.000Z'),
      idempotencyKey: 'doc-expired-1',
    });
    const evaluation = await t.app.construction.evaluateCompliance(t.owner, {
      tenantId: t.tenantId,
      serviceWorkId: onboarding.serviceWork.id,
      idempotencyKey: 'eval-expired-1',
    });
    assert.equal(evaluation.compliant, false);
    const codes = evaluation.insuranceValidation?.findings.map((finding) => finding.code) ?? [];
    assert.ok(codes.includes('CERTIFICATE_EXPIRED'));
    assert.equal(evaluation.serviceWork.status, 'in_progress');
    // The failure is durable attributable evidence (never hidden).
    const validationEvidence = await t.app.evidence.listEvidence(t.owner, t.tenantId, {
      serviceWorkId: onboarding.serviceWork.id,
      requirement: 'construction.insurance_validation',
    });
    assert.equal(validationEvidence.length, 1);
    assert.equal((validationEvidence[0]?.payload as Record<string, unknown>).compliant, false);
  });
});

test('noncompliant limits fire the below-minimum findings and block compliance', async () => {
  await withTenant(async (t) => {
    const onboarding = await onboarded(t, 'onboard-limits');
    await t.app.construction.receiveVendorDocument(t.owner, {
      tenantId: t.tenantId,
      serviceWorkId: onboarding.serviceWork.id,
      kind: 'insurance_certificate',
      document: {
        ...COMPLIANT_INSURANCE,
        glPerOccurrenceUsd: 500_000, // below the 1,000,000 minimum
        umbrellaAggregateUsd: 1_500_000, // below the 2,000,000 minimum
        additionalInsured: 'Somebody Else', // mismatched endorsement
      },
      receivedAt: new Date('2026-09-03T09:00:00.000Z'),
      idempotencyKey: 'doc-limits-1',
    });
    const evaluation = await t.app.construction.evaluateCompliance(t.owner, {
      tenantId: t.tenantId,
      serviceWorkId: onboarding.serviceWork.id,
      idempotencyKey: 'eval-limits-1',
    });
    assert.equal(evaluation.compliant, false);
    const codes = evaluation.insuranceValidation?.findings.map((finding) => finding.code) ?? [];
    assert.ok(codes.includes('GL_PER_OCCURRENCE_BELOW_MINIMUM'));
    assert.ok(codes.includes('UMBRELLA_AGGREGATE_BELOW_MINIMUM'));
    assert.ok(codes.includes('ADDITIONAL_INSURED_MISMATCH'));
    // The composed gate blocks completion: the insurance rule findings
    // are noncompliant even though the document is PRESENT (a present
    // but noncompliant document can never complete the work) (AC-6).
    assert.equal(evaluation.serviceWork.status, 'in_progress');
    // Package assembly stays gated.
    await assert.rejects(
      t.app.construction.assembleCompliancePackage(t.owner, {
        tenantId: t.tenantId,
        serviceWorkId: onboarding.serviceWork.id,
        idempotencyKey: 'package-limits-1',
      }),
      (error: unknown) => error instanceof ConstructionError && error.code === 'NOT_COMPLIANT',
    );
  });
});

// ---------------------------------------------------------------------------
// Vendor correction / retry + the stale-attempt discrimination
// ---------------------------------------------------------------------------

test('vendor correction: a corrected certificate is a NEW instance + NEW evidence and re-converges to compliant', async () => {
  await withTenant(async (t) => {
    const onboarding = await onboarded(t, 'onboard-correct');
    const clock = t.app.now;
    // First submission: noncompliant limits.
    await t.app.construction.receiveVendorDocument(t.owner, {
      tenantId: t.tenantId,
      serviceWorkId: onboarding.serviceWork.id,
      kind: 'insurance_certificate',
      document: { ...COMPLIANT_INSURANCE, glPerOccurrenceUsd: 500_000 },
      receivedAt: new Date('2026-09-03T09:00:00.000Z'),
      idempotencyKey: 'doc-correct-1',
    });
    clock.value = new Date('2026-09-03T12:00:00.000Z');
    const first = await t.app.construction.evaluateCompliance(t.owner, {
      tenantId: t.tenantId,
      serviceWorkId: onboarding.serviceWork.id,
      idempotencyKey: 'eval-correct-1',
    });
    assert.equal(first.compliant, false);
    assert.equal(first.serviceWork.status, 'in_progress');

    // The vendor corrects: NEW document identity + NEW evidence.
    const corrected = await t.app.construction.receiveVendorDocument(t.owner, {
      tenantId: t.tenantId,
      serviceWorkId: onboarding.serviceWork.id,
      kind: 'insurance_certificate',
      document: { ...COMPLIANT_INSURANCE },
      receivedAt: new Date('2026-09-04T09:00:00.000Z'),
      idempotencyKey: 'doc-correct-2',
    });
    assert.notEqual(corrected.documentInstance?.id, '');
    const evidence = await t.app.evidence.listEvidence(t.owner, t.tenantId, {
      serviceWorkId: onboarding.serviceWork.id,
      requirement: 'construction.insurance_certificate',
    });
    assert.equal(evidence.length, 2); // both submissions retained (audit trail)

    // STALE DISCRIMINATION: the first evaluator re-runs its OLD key over
    // the CHANGED evidence state — /evidence fails the keyed
    // re-verification closed; the newer decision authority stands.
    await assert.rejects(
      t.app.construction.evaluateCompliance(t.owner, {
        tenantId: t.tenantId,
        serviceWorkId: onboarding.serviceWork.id,
        idempotencyKey: 'eval-correct-1',
      }),
      (error: unknown) => {
        const code = (error as { code?: string }).code;
        return code === 'VERIFICATION_INPUT_CONFLICT' || code === 'EVIDENCE_INPUT_CONFLICT';
      },
    );

    // Re-evaluation with a NEW key composes over the corrected state.
    clock.value = new Date('2026-09-04T12:00:00.000Z');
    const second = await t.app.construction.evaluateCompliance(t.owner, {
      tenantId: t.tenantId,
      serviceWorkId: onboarding.serviceWork.id,
      idempotencyKey: 'eval-correct-2',
    });
    assert.equal(second.compliant, false, 'w9/license documents are still missing in this engagement');
    // Complete the remaining documents and re-evaluate.
    await t.app.construction.receiveVendorDocument(t.owner, {
      tenantId: t.tenantId,
      serviceWorkId: onboarding.serviceWork.id,
      kind: 'w9',
      document: compliantW9(t.app, '12-3456789'),
      receivedAt: new Date('2026-09-05T09:00:00.000Z'),
      idempotencyKey: 'doc-correct-w9',
    });
    await t.app.construction.receiveVendorDocument(t.owner, {
      tenantId: t.tenantId,
      serviceWorkId: onboarding.serviceWork.id,
      kind: 'license',
      document: compliantLicense(),
      receivedAt: new Date('2026-09-05T09:05:00.000Z'),
      idempotencyKey: 'doc-correct-lic',
    });
    clock.value = new Date('2026-09-05T12:00:00.000Z');
    const third = await t.app.construction.evaluateCompliance(t.owner, {
      tenantId: t.tenantId,
      serviceWorkId: onboarding.serviceWork.id,
      idempotencyKey: 'eval-correct-3',
    });
    assert.equal(third.compliant, true);
    assert.equal(third.serviceWork.status, 'completed');
    // The package assembles over the corrected state.
    const pack = await t.app.construction.assembleCompliancePackage(t.owner, {
      tenantId: t.tenantId,
      serviceWorkId: onboarding.serviceWork.id,
      idempotencyKey: 'package-correct-1',
    });
    assert.equal((pack.packageDocument as Record<string, unknown>).workState, 'completed');
  });
});

// ---------------------------------------------------------------------------
// Zeck-backed document reasoning (AC-3) + AI-claim discrimination (AC-6)
// ---------------------------------------------------------------------------

test('Zeck document reasoning: the intent flows through /zeck with the declared requirement; extracted facts are evidence, not outcomes', async () => {
  const gateway = createInMemoryZeckGateway();
  const app = buildConstructionApp({ gateway });
  const t = await prepareConstructionTenant(app);
  const onboarding = await onboarded(t, 'onboard-zeck');
  // The document must exist before reasoning is requested.
  await assert.rejects(
    app.construction.requestDocumentReasoning(t.owner, {
      tenantId: t.tenantId,
      serviceWorkId: onboarding.serviceWork.id,
      kind: 'insurance_certificate',
    }),
    (error: unknown) => error instanceof ConstructionError && error.code === 'REASONING_NOT_SUBMITTED',
  );
  // A scanned certificate arrives: the structured facts are unparsed
  // placeholders until reasoning extracts them.
  await app.construction.receiveVendorDocument(t.owner, {
    tenantId: t.tenantId,
    serviceWorkId: onboarding.serviceWork.id,
    kind: 'insurance_certificate',
    document: { ...COMPLIANT_INSURANCE, glPerOccurrenceUsd: 0, umbrellaAggregateUsd: 0 },
    receivedAt: new Date('2026-09-03T09:00:00.000Z'),
    idempotencyKey: 'doc-zeck-1',
  });
  // The reasoning request flows through /zeck (the package-declared
  // capability requirement; no model/provider selection anywhere).
  const reasoning = await app.construction.requestDocumentReasoning(t.owner, {
    tenantId: t.tenantId,
    serviceWorkId: onboarding.serviceWork.id,
    kind: 'insurance_certificate',
    idempotencyKey: 'reasoning-1',
  });
  assert.equal(reasoning.dispatched, true);
  assert.notEqual(reasoning.intent.zeckExecutionId, null);
  assert.equal(reasoning.intent.requiredCapabilities.length, 1);
  // The duplicate request converges on the SAME execution reference.
  const duplicate = await app.construction.requestDocumentReasoning(t.owner, {
    tenantId: t.tenantId,
    serviceWorkId: onboarding.serviceWork.id,
    kind: 'insurance_certificate',
    idempotencyKey: 'reasoning-1',
  });
  assert.equal(duplicate.dispatched, false);
  assert.equal(duplicate.intent.zeckExecutionId, reasoning.intent.zeckExecutionId);

  // The foreign execution's extracted facts enter as EVIDENCE citing the
  // foreign execution (a claim), and the deterministic rule decides.
  const reasoned = await app.construction.recordReasonedDocumentFacts(t.owner, {
    tenantId: t.tenantId,
    serviceWorkId: onboarding.serviceWork.id,
    kind: 'insurance_certificate',
    facts: { ...COMPLIANT_INSURANCE },
    provenanceRefs: [reasoning.intent.zeckExecutionId as string],
    observedAt: new Date('2026-09-03T10:00:00.000Z'),
    idempotencyKey: 'reasoned-facts-1',
  });
  assert.equal(reasoned.evidence.provenance.source, 'zeck-document-reasoning');
  assert.deepEqual(reasoned.evidence.provenance.refs, [reasoning.intent.zeckExecutionId]);
  // The evaluation consumes the RECORDED facts deterministically.
  const evaluation = await app.construction.evaluateCompliance(t.owner, {
    tenantId: t.tenantId,
    serviceWorkId: onboarding.serviceWork.id,
    idempotencyKey: 'eval-zeck-1',
  });
  assert.equal(evaluation.insuranceValidation?.compliant, true);
});

test('a fabricated AI claim cannot mark compliance: the composed gate requires the deterministic rule outcome', async () => {
  await withTenant(async (t) => {
    const onboarding = await onboarded(t, 'onboard-fabricated');
    // Only the document evidence exists; NO validation evidence was ever
    // attached (no evaluation ran). A fabricated "reasoning result" that
    // claims compliance is recorded as plain evidence with a foreign
    // provenance reference — nothing more.
    await t.app.construction.recordReasonedDocumentFacts(t.owner, {
      tenantId: t.tenantId,
      serviceWorkId: onboarding.serviceWork.id,
      kind: 'insurance_certificate',
      facts: { ...COMPLIANT_INSURANCE, glPerOccurrenceUsd: 100, umbrellaAggregateUsd: 100 },
      provenanceRefs: ['zeck-fabricated-execution'],
      observedAt: new Date('2026-09-03T10:00:00.000Z'),
      idempotencyKey: 'fabricated-1',
    });
    // The deterministic evaluation over those recorded facts fails the
    // limits — the foreign claim alone cannot compose compliance.
    const evaluation = await t.app.construction.evaluateCompliance(t.owner, {
      tenantId: t.tenantId,
      serviceWorkId: onboarding.serviceWork.id,
      idempotencyKey: 'eval-fabricated-1',
    });
    assert.equal(evaluation.insuranceValidation?.compliant, false);
    assert.equal(evaluation.compliant, false);
    assert.equal(evaluation.serviceWork.status, 'in_progress');
    await assert.rejects(
      t.app.construction.assembleCompliancePackage(t.owner, {
        tenantId: t.tenantId,
        serviceWorkId: onboarding.serviceWork.id,
        idempotencyKey: 'package-fabricated-1',
      }),
      (error: unknown) => error instanceof ConstructionError && error.code === 'NOT_COMPLIANT',
    );
  });
});

// ---------------------------------------------------------------------------
// Exception escalation (AC-4)
// ---------------------------------------------------------------------------

test('exception escalation: the human decision terminalizes; approve resumes, reject fails', async () => {
  await withTenant(async (t) => {
    // An allow policy version for the exception policy key (the operator
    // registers the base contract through /policies' public surface).
    const { contract } = await t.app.policies.createPolicyVersion(t.owner, {
      tenantId: t.tenantId,
      policyKey: 'construction.exception',
      scope: 'base',
      rules: [{ id: 'allow-all', when: { kind: 'always' }, effect: 'allow' }],
      defaultEffect: 'allow',
      idempotencyKey: 'exception-policy-1',
    });
    await t.app.policies.activatePolicyVersion(t.owner, t.tenantId, contract.id);

    const onboarding = await onboarded(t, 'onboard-escalate');
    const escalation = await t.app.construction.escalateException(t.owner, {
      tenantId: t.tenantId,
      serviceWorkId: onboarding.serviceWork.id,
      reason: 'vendor cannot obtain umbrella coverage before mobilization',
    });
    assert.equal(escalation.serviceWork.status, 'waiting_approval');
    assert.equal(escalation.escalationWork.workType, 'construction.escalate_exception');
    assert.equal(escalation.approvalRequest.status, 'pending');

    // Applying before the human decides fails closed.
    await assert.rejects(
      t.app.construction.applyExceptionDecision(t.owner, {
        tenantId: t.tenantId,
        serviceWorkId: onboarding.serviceWork.id,
      }),
      (error: unknown) => error instanceof ConstructionError && error.code === 'ESCALATION_NOT_DECIDED',
    );

    // The human approves through /approvals' explicit surface.
    const decision = await t.app.approvals.decideApproval(t.owner, {
      tenantId: t.tenantId,
      requestId: escalation.approvalRequest.id,
      decision: 'approve',
      idempotencyKey: 'decide-1',
    });
    assert.equal(decision.decision.decision, 'approve');
    const applied = await t.app.construction.applyExceptionDecision(t.owner, {
      tenantId: t.tenantId,
      serviceWorkId: onboarding.serviceWork.id,
    });
    assert.equal(applied.serviceWork.status, 'in_progress');
    // Idempotent re-apply converges (the work stays in_progress; terminal
    // transitions are never replayed).
    const reapplied = await t.app.construction.applyExceptionDecision(t.owner, {
      tenantId: t.tenantId,
      serviceWorkId: onboarding.serviceWork.id,
    });
    assert.equal(reapplied.serviceWork.status, 'in_progress');

    // A rejected escalation fails the work terminally.
    const second = await onboarded(t, 'onboard-escalate-reject');
    const escalation2 = await t.app.construction.escalateException(t.owner, {
      tenantId: t.tenantId,
      serviceWorkId: second.serviceWork.id,
      reason: 'coverage gap cannot be remediated',
      idempotencyKey: 'escalate-2',
    });
    await t.app.approvals.decideApproval(t.owner, {
      tenantId: t.tenantId,
      requestId: escalation2.approvalRequest.id,
      decision: 'reject',
      idempotencyKey: 'decide-2',
    });
    const applied2 = await t.app.construction.applyExceptionDecision(t.owner, {
      tenantId: t.tenantId,
      serviceWorkId: second.serviceWork.id,
    });
    assert.equal(applied2.serviceWork.status, 'failed');
  });
});

// ---------------------------------------------------------------------------
// The pure deterministic rules (unit-level determinism)
// ---------------------------------------------------------------------------

test('the deterministic rules are pure functions of (facts, requirement, instant)', () => {
  const requirement = {
    minGlPerOccurrenceUsd: 1_000_000,
    minUmbrellaAggregateUsd: 2_000_000,
    expiryLeadDays: 30,
    projectNamedAdditionalInsured: true,
    projectName: 'Riverside Tower',
  };
  const certificate = {
    glPerOccurrenceUsd: 2_000_000,
    umbrellaAggregateUsd: 4_000_000,
    expiresAt: new Date('2027-06-30T00:00:00.000Z').toISOString(),
    additionalInsured: 'Riverside Tower',
    certificateHolder: 'X',
  };
  const asOf = new Date('2026-09-02T10:00:00.000Z');
  const a = validateInsuranceCompliance(requirement, certificate, asOf);
  const b = validateInsuranceCompliance(requirement, certificate, asOf);
  assert.deepEqual(a, b);
  assert.equal(a.compliant, true);
  // The lead window: expiring inside the window is a finding.
  const expiring = validateInsuranceCompliance(
    requirement,
    { ...certificate, expiresAt: new Date('2026-09-20T00:00:00.000Z').toISOString() },
    asOf,
  );
  assert.equal(expiring.compliant, false);
  assert.ok(expiring.findings.some((finding) => finding.code === 'CERTIFICATE_EXPIRING_WITHIN_LEAD_DAYS'));
  // The W-9 identity rule.
  assert.equal(validateW9Compliance('12-3456789', '12-3456789').compliant, true);
  assert.equal(validateW9Compliance('12-3456789', '98-7654321').compliant, false);
  // The license rule.
  assert.equal(
    validateLicenseCompliance({ licenseNumber: 'GC-1', jurisdiction: 'CA', expiresAt: '2027-01-01T00:00:00.000Z', active: true }, asOf).compliant,
    true,
  );
  assert.equal(
    validateLicenseCompliance({ licenseNumber: 'GC-1', jurisdiction: 'CA', expiresAt: '2027-01-01T00:00:00.000Z', active: false }, asOf).compliant,
    false,
  );
});
