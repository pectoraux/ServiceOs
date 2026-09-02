/**
 * Dynamic + discrimination proofs for the /verticals authority (WORK-009).
 *
 * Proves (in-memory store, faithful port implementation):
 * - package registration/versioning (AC-2; Work Order behavioral
 *   requirement): v1 registers, records are immutable in content, and
 *   versions sequence contiguously;
 * - duplicate registration of the same version converges iff the content
 *   hash matches; different content fails closed (VERSION_CONTENT_
 *   CONFLICT); version gaps/skips fail closed (VERSION_NOT_SEQUENTIAL);
 * - idempotency-key registration converges; divergent content for the
 *   same key fails closed;
 * - the Zeck capability-requirement declaration contract (AC-4): valid
 *   declarations persist; a declaration carrying model/provider/agent/
 *   prompt selection fields is rejected fail-closed
 *   (AI_SELECTION_FORBIDDEN) — the declaration cannot select;
 * - declarative-only discipline: policy defaults carrying rule/effect
 *   keys are rejected (no duplicate policy engine by construction);
 * - cross-reference validation: steps referencing undeclared work
 *   types/entities are rejected;
 * - record integrity: after-the-fact mutation of a stored package is
 *   DETECTED on read (VERTICAL_RECORD_TAMPERED);
 * - tenancy: authorization happens before data access (reads counters),
 *   cross-tenant reads are null, denial reasons map to typed errors.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServiceRuntimeApp, type ServiceRuntimeApp } from './helpers/in-memory-stores.js';
import type { Principal } from '../src/modules/auth/index.js';
import { VerticalsError } from '../src/modules/verticals/index.js';

const PASSWORD = 'correct horse battery 7';

interface Base {
  app: ServiceRuntimeApp;
  owner: Principal;
  colleague: Principal;
  viewer: Principal;
  outsider: Principal;
  tenantId: string;
  otherTenantId: string;
}

async function base(): Promise<Base> {
  const app = buildServiceRuntimeApp();
  const owner = await app.auth.registerHuman({ email: 'owner@a.com', password: PASSWORD, displayName: 'Owner' });
  const colleague = await app.auth.registerHuman({ email: 'member@a.com', password: PASSWORD, displayName: 'Member' });
  const viewer = await app.auth.registerHuman({ email: 'viewer@a.com', password: PASSWORD, displayName: 'Viewer' });
  const outsider = await app.auth.registerHuman({ email: 'out@b.com', password: PASSWORD, displayName: 'Outsider' });
  const created = await app.organizations.createOrganization(owner, { slug: 'alpha-org', displayName: 'Alpha' });
  await app.organizations.addMember(owner, 'alpha-org', { principalId: colleague.id, role: 'member' });
  await app.organizations.addMember(owner, 'alpha-org', { principalId: viewer.id, role: 'viewer' });
  const other = await app.organizations.createOrganization(outsider, { slug: 'beta-org', displayName: 'Beta' });
  return {
    app,
    owner,
    colleague,
    viewer,
    outsider,
    tenantId: created.tenant.id,
    otherTenantId: other.tenant.id,
  };
}

function constructionPackage(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: 'filled-by-test',
    packageId: 'construction',
    version: 1,
    name: 'Construction',
    description: 'Construction industry vertical package',
    terminology: {
      subcontractor: 'A company engaged to perform part of the works',
      rfi: 'Request for information',
    },
    entities: [
      {
        name: 'Project',
        fields: [
          { name: 'projectNumber', type: 'string' as const, required: true },
          { name: 'budget', type: 'number' as const, required: false },
        ],
      },
      { name: 'Subcontractor', fields: [{ name: 'trade', type: 'string' as const, required: true }] },
    ],
    workTypes: [
      { name: 'OnboardSubcontractor', description: 'Onboard one subcontractor', defaultSlaHours: 48 },
      { name: 'CollectComplianceDocument', defaultSlaHours: 24 },
    ],
    workflowSteps: [
      { step: 'collect', workType: 'CollectComplianceDocument', entity: 'Subcontractor' },
      { step: 'validate', description: 'Validate collected documents' },
    ],
    policyDefaults: [
      {
        policyKey: 'construction.subcontractor.review-threshold',
        parameters: [{ name: 'reviewThreshold', defaultValue: 5000 }],
      },
    ],
    approvalMatrix: [
      { id: 'sub-onboarding-approval', workType: 'OnboardSubcontractor', role: 'project-manager', threshold: 1 },
    ],
    evidenceRequirements: [{ name: 'insurance-certificate', description: 'COI from an authorized insurer' }],
    integrationBindings: [{ capabilityClass: 'email', description: 'Document requests by email' }],
    zeckCapabilityRequirements: [
      { capability: 'document.reasoning', minQuality: 0.8, maxLatencyMs: 60000 },
    ],
    pricingRules: [
      { id: 'per-sub-onboarding', model: 'per_work_item' as const, amount: '25.00', currency: 'USD' },
    ],
    ...overrides,
  };
}

async function registerPackage(
  app: ServiceRuntimeApp,
  actor: Principal,
  tenantId: string,
  overrides: Record<string, unknown> = {},
  idempotencyKey?: string,
) {
  const input = constructionPackage(overrides);
  return app.verticals.registerVerticalPackage(actor, {
    ...input,
    tenantId,
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
  });
}

function expectVerticalsError(code: string, fn: () => Promise<unknown>): Promise<VerticalsError> {
  return (async () => {
    try {
      await fn();
    } catch (error) {
      assert.ok(error instanceof VerticalsError, `expected VerticalsError, got ${String(error)}`);
      assert.equal(error.code, code, `expected code ${code}, got ${error.code}: ${error.message}`);
      return error;
    }
    throw new Error(`expected VerticalsError ${code}, but the call succeeded`);
  })();
}

// ---------------------------------------------------------------------------
// Registration and versioning (AC-2, behavioral)
// ---------------------------------------------------------------------------

test('a vertical package version registers and round-trips its declared content', async () => {
  const { app, owner, tenantId } = await base();
  const { pkg, converged } = await registerPackage(app, owner, tenantId, {}, 'key-v1');
  assert.equal(converged, false);
  assert.equal(pkg.packageId, 'construction');
  assert.equal(pkg.version, 1);
  assert.equal(pkg.tenantId, tenantId);
  assert.equal(pkg.createdBy, owner.id);
  assert.equal(pkg.terminology.rfi, 'Request for information');
  assert.equal(pkg.entities.length, 2);
  assert.equal(pkg.entities[0]?.fields.length, 2);
  assert.equal(pkg.workTypes[0]?.defaultSlaHours, 48);
  assert.equal(pkg.workflowSteps[0]?.workType, 'CollectComplianceDocument');
  assert.equal(pkg.policyDefaults[0]?.parameters[0]?.defaultValue, 5000);
  assert.equal(pkg.approvalMatrix[0]?.threshold, 1);
  assert.equal(pkg.evidenceRequirements[0]?.name, 'insurance-certificate');
  assert.equal(pkg.integrationBindings[0]?.capabilityClass, 'email');
  assert.equal(pkg.zeckCapabilityRequirements[0]?.capability, 'document.reasoning');
  assert.equal(pkg.zeckCapabilityRequirements[0]?.minQuality, 0.8);
  assert.equal(pkg.pricingRules[0]?.model, 'per_work_item');
  // Content hash + record hash are pinned and verify on read.
  assert.match(pkg.contentHash, /^[0-9a-f]{64}$/);
  assert.match(pkg.recordHash, /^[0-9a-f]{64}$/);
});

test('vertical packages version sequentially and immutably (AC-2)', async () => {
  const { app, owner, tenantId } = await base();
  const v1 = await registerPackage(app, owner, tenantId, {}, 'key-v1');
  const v2 = await registerPackage(app, owner, tenantId, { version: 2, name: 'Construction v2' }, 'key-v2');
  assert.equal(v1.pkg.version, 1);
  assert.equal(v2.pkg.version, 2);
  assert.equal(v2.pkg.name, 'Construction v2');
  assert.equal(v1.pkg.name, 'Construction', 'v1 content is immutable after v2 registration');
  const versions = await app.verticals.listVerticalPackages(owner, tenantId, 'construction');
  assert.equal(versions.length, 2);
  assert.equal(versions[0]?.version, 1);
  assert.equal(versions[1]?.version, 2);
  const latest = await app.verticals.latestVerticalPackage(owner, tenantId, 'construction');
  assert.equal(latest?.version, 2);
});

test('duplicate package/version registration converges on identical content (concurrency requirement, single actor)', async () => {
  const { app, owner, tenantId } = await base();
  const first = await registerPackage(app, owner, tenantId, {}, 'key-v1');
  const second = await registerPackage(app, owner, tenantId, {}, 'key-again');
  assert.equal(second.converged, true);
  assert.equal(second.pkg.id, first.pkg.id);
  assert.equal(app.verticalsStore.packages.size, 1, 'exactly one durable row');
});

test('duplicate package/version registration with DIFFERENT content fails closed (deterministic rejection)', async () => {
  const { app, owner, tenantId } = await base();
  await registerPackage(app, owner, tenantId, {}, 'key-v1');
  await expectVerticalsError('VERSION_CONTENT_CONFLICT', () =>
    registerPackage(app, owner, tenantId, { name: 'Construction (mutated)' }, 'key-mutated'),
  );
  assert.equal(app.verticalsStore.packages.size, 1);
});

test('version gaps and skips fail closed', async () => {
  const { app, owner, tenantId } = await base();
  await expectVerticalsError('VERSION_NOT_SEQUENTIAL', () =>
    registerPackage(app, owner, tenantId, { version: 2 }, 'key-skip'),
  );
  await registerPackage(app, owner, tenantId, {}, 'key-v1');
  await registerPackage(app, owner, tenantId, { version: 2 }, 'key-v2');
  await expectVerticalsError('VERSION_NOT_SEQUENTIAL', () =>
    registerPackage(app, owner, tenantId, { version: 4 }, 'key-skip-again'),
  );
  // Re-registering an EXISTING behind-sequence version with different
  // content is the deterministic content conflict (not a sequencing issue).
  await expectVerticalsError('VERSION_CONTENT_CONFLICT', () =>
    app.verticals.registerVerticalPackage(owner, {
      ...constructionPackage({ name: 'Construction (other)' }),
      tenantId,
      version: 1,
    }),
  );
  assert.equal(app.verticalsStore.packages.size, 2);
});

test('idempotency-key registration converges; divergent content for the same key fails closed', async () => {
  const { app, owner, tenantId } = await base();
  const first = await registerPackage(app, owner, tenantId, {}, 'key-v1');
  const retry = await registerPackage(app, owner, tenantId, {}, 'key-v1');
  assert.equal(retry.converged, true);
  assert.equal(retry.pkg.id, first.pkg.id);
  await expectVerticalsError('IDEMPOTENCY_INPUT_CONFLICT', () =>
    registerPackage(app, owner, tenantId, { description: 'Different content, same key' }, 'key-v1'),
  );
  assert.equal(app.verticalsStore.packages.size, 1);
});

// ---------------------------------------------------------------------------
// AC-4: Zeck capability requirement declarations (discrimination)
// ---------------------------------------------------------------------------

test('a Zeck capability requirement carrying a model selection field is rejected (AC-4)', async () => {
  const { app, owner, tenantId } = await base();
  await expectVerticalsError('AI_SELECTION_FORBIDDEN', () =>
    registerPackage(app, owner, tenantId, {
      zeckCapabilityRequirements: [{ capability: 'document.reasoning', model: 'gpt-4' }],
    }),
  );
});

test('a Zeck capability requirement carrying a provider selection field is rejected (AC-4)', async () => {
  const { app, owner, tenantId } = await base();
  await expectVerticalsError('AI_SELECTION_FORBIDDEN', () =>
    registerPackage(app, owner, tenantId, {
      zeckCapabilityRequirements: [{ capability: 'document.reasoning', provider: 'openai' }],
    }),
  );
  await expectVerticalsError('AI_SELECTION_FORBIDDEN', () =>
    registerPackage(app, owner, tenantId, {
      zeckCapabilityRequirements: [{ capability: 'document.reasoning', agent: 'doc-reviewer-v2' }],
    }),
  );
  await expectVerticalsError('AI_SELECTION_FORBIDDEN', () =>
    registerPackage(app, owner, tenantId, {
      zeckCapabilityRequirements: [{ capability: 'document.reasoning', prompt: 'Review this COI' }],
    }),
  );
  assert.equal(app.verticalsStore.packages.size, 0, 'nothing persisted');
});

test('Zeck capability requirement bounds are validated fail-closed', async () => {
  const { app, owner, tenantId } = await base();
  await expectVerticalsError('INVALID_INPUT', () =>
    registerPackage(app, owner, tenantId, {
      zeckCapabilityRequirements: [{ capability: 'document.reasoning', minQuality: 1.5 }],
    }),
  );
  await expectVerticalsError('INVALID_INPUT', () =>
    registerPackage(app, owner, tenantId, {
      zeckCapabilityRequirements: [{ capability: 'document.reasoning', maxLatencyMs: 0 }],
    }),
  );
  await expectVerticalsError('INVALID_INPUT', () =>
    registerPackage(app, owner, tenantId, {
      zeckCapabilityRequirements: [
        { capability: 'document.reasoning' },
        { capability: 'document.reasoning' },
      ],
    }),
  );
});

// ---------------------------------------------------------------------------
// Declarative-only discipline (discrimination)
// ---------------------------------------------------------------------------

test('policy defaults carrying rule/effect content are rejected (no duplicate policy engine)', async () => {
  const { app, owner, tenantId } = await base();
  await expectVerticalsError('INVALID_INPUT', () =>
    registerPackage(app, owner, tenantId, {
      policyDefaults: [
        {
          policyKey: 'construction.subcontractor.review-threshold',
          rules: [{ id: 'rule-1', effect: 'allow' }],
          parameters: [{ name: 'reviewThreshold', defaultValue: 5000 }],
        },
      ],
    }),
  );
});

test('workflow steps referencing undeclared work types or entities are rejected', async () => {
  const { app, owner, tenantId } = await base();
  await expectVerticalsError('INVALID_INPUT', () =>
    registerPackage(app, owner, tenantId, {
      workflowSteps: [{ step: 'collect', workType: 'NoSuchWorkType' }],
    }),
  );
  await expectVerticalsError('INVALID_INPUT', () =>
    registerPackage(app, owner, tenantId, {
      workflowSteps: [{ step: 'collect', entity: 'NoSuchEntity' }],
    }),
  );
});

test('duplicate declarations and malformed shapes are rejected', async () => {
  const { app, owner, tenantId } = await base();
  await expectVerticalsError('INVALID_INPUT', () =>
    registerPackage(app, owner, tenantId, {
      entities: [
        { name: 'Project', fields: [] },
        { name: 'Project', fields: [] },
      ],
    }),
  );
  await expectVerticalsError('INVALID_INPUT', () =>
    registerPackage(app, owner, tenantId, {
      approvalMatrix: [{ id: 'rule-1', role: 'pm', threshold: 0 }],
    }),
  );
  await expectVerticalsError('INVALID_INPUT', () =>
    registerPackage(app, owner, tenantId, {
      pricingRules: [{ id: 'rule-1', model: 'per_work_item', amount: 'not-a-decimal' }],
    }),
  );
  await expectVerticalsError('INVALID_INPUT', () =>
    registerPackage(app, owner, tenantId, {
      integrationBindings: [{ capabilityClass: 'Email' }],
    }),
  );
  await expectVerticalsError('INVALID_INPUT', () =>
    registerPackage(app, owner, tenantId, { packageId: 'Bad Id' }),
  );
});

// ---------------------------------------------------------------------------
// Record integrity (tamper detection)
// ---------------------------------------------------------------------------

test('after-the-fact mutation of a stored package is detected on read', async () => {
  const { app, owner, tenantId } = await base();
  const { pkg } = await registerPackage(app, owner, tenantId, {}, 'key-v1');
  // Tamper: change the name without recomputing the hashes.
  const stored = app.verticalsStore.packages.get(pkg.id);
  assert.ok(stored !== undefined);
  stored.name = 'Tampered Name';
  await expectVerticalsError('VERTICAL_RECORD_TAMPERED', () =>
    app.verticals.getVerticalPackage(owner, tenantId, 'construction', 1),
  );
  // Restore and tamper the content hash instead (orphan hash).
  stored.name = 'Construction';
  stored.contentHash = '0'.repeat(64);
  await expectVerticalsError('VERTICAL_RECORD_TAMPERED', () =>
    app.verticals.listVerticalPackages(owner, tenantId, 'construction'),
  );
});

// ---------------------------------------------------------------------------
// Tenancy and authorization
// ---------------------------------------------------------------------------

test('authorization happens BEFORE any domain data access (denials never touch data)', async () => {
  const { app, viewer, outsider, tenantId } = await base();
  const readsBefore = app.verticalsStore.reads.byId + app.verticalsStore.reads.byKey + app.verticalsStore.reads.list;
  await expectVerticalsError('ROLE_FORBIDDEN', () => registerPackage(app, viewer, tenantId, {}, 'key-viewer'));
  await expectVerticalsError('TENANT_FORBIDDEN', () => registerPackage(app, outsider, tenantId, {}, 'key-out'));
  const readsAfter = app.verticalsStore.reads.byId + app.verticalsStore.reads.byKey + app.verticalsStore.reads.list;
  assert.equal(readsAfter, readsBefore, 'no domain data was read during denials');
});

test('cross-tenant reads are indistinguishable from missing packages', async () => {
  const { app, owner, outsider, tenantId, otherTenantId } = await base();
  await registerPackage(app, owner, tenantId, {}, 'key-v1');
  const foreign = await app.verticals.getVerticalPackage(outsider, otherTenantId, 'construction', 1);
  assert.equal(foreign, null);
  const foreignList = await app.verticals.listVerticalPackages(outsider, otherTenantId, 'construction');
  assert.deepEqual(foreignList, []);
  assert.equal(app.verticalsStore.reads.byKey > 0 || app.verticalsStore.reads.list > 0, true);
});

test('an unknown tenant is a typed error, not a silent empty result', async () => {
  const { app, owner } = await base();
  await expectVerticalsError('TENANT_NOT_FOUND', () =>
    registerPackage(app, owner, '00000000-0000-4000-8000-000000000000', {}, 'key-x'),
  );
});

test('a second tenant registers its own independent package copy', async () => {
  const { app, owner, outsider, tenantId, otherTenantId } = await base();
  const a = await registerPackage(app, owner, tenantId, {}, 'key-a');
  const b = await registerPackage(app, outsider, otherTenantId, {}, 'key-b');
  assert.notEqual(a.pkg.id, b.pkg.id);
  assert.equal(a.pkg.tenantId, tenantId);
  assert.equal(b.pkg.tenantId, otherTenantId);
  const inA = await app.verticals.listVerticalPackages(owner, tenantId);
  const inB = await app.verticals.listVerticalPackages(outsider, otherTenantId);
  assert.equal(inA.length, 1);
  assert.equal(inB.length, 1);
});
