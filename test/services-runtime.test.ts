/**
 * Dynamic + discrimination proofs for the /services authority (WORK-009).
 *
 * Proves (in-memory store, faithful port implementation):
 * - AC-1: a service definition defines entities, work types, workflow and
 *   outcome requirements, bound to a pinned registered vertical package;
 * - the workflow-definition binding validates against the FROZEN canonical
 *   Service Work state machine (architecture-lock #31 discrimination): a
 *   binding using a non-canonical state fails closed
 *   (WORKFLOW_STATE_UNKNOWN) and a binding declaring an illegal
 *   transition fails closed (TRANSITION_ILLEGAL) — service data can
 *   never weaken the horizontal lifecycle authority;
 * - every referenced domain concept must be DECLARED by the vertical
 *   package (entities, work types, steps, policy keys + parameters,
 *   approval rules, evidence requirements, capability classes, AI
 *   capability requirements);
 * - vertical specialization floors: the service may only tighten SLA
 *   deadlines (SLA_WEAKENED) and strengthen approval thresholds
 *   (APPROVAL_WEAKENED);
 * - the policy configuration is a SCHEMA only (rule/effect keys are
 *   rejected — no duplicate policy engine);
 * - AC-4: AI capability requirements without selection fields; unknown
 *   vertical package versions fail closed;
 * - the outcome contract verification is a business-authority concept
 *   (AI verification rejected);
 * - the service-package lifecycle: draft -> active (forward-only,
 *   one-active, convergent re-activation, retired terminal);
 * - duplicate registration convergence, content conflicts, version
 *   sequencing;
 * - record integrity (tamper detection) and tenancy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServiceRuntimeApp, type ServiceRuntimeApp } from './helpers/in-memory-stores.js';
import type { Principal } from '../src/modules/auth/index.js';
import { ServicesError } from '../src/modules/services/index.js';

const PASSWORD = 'correct horse battery 7';

interface Base {
  app: ServiceRuntimeApp;
  owner: Principal;
  viewer: Principal;
  outsider: Principal;
  tenantId: string;
  otherTenantId: string;
}

async function base(): Promise<Base> {
  const app = buildServiceRuntimeApp();
  const owner = await app.auth.registerHuman({ email: 'owner@a.com', password: PASSWORD, displayName: 'Owner' });
  const viewer = await app.auth.registerHuman({ email: 'viewer@a.com', password: PASSWORD, displayName: 'Viewer' });
  const outsider = await app.auth.registerHuman({ email: 'out@b.com', password: PASSWORD, displayName: 'Outsider' });
  const created = await app.organizations.createOrganization(owner, { slug: 'alpha-org', displayName: 'Alpha' });
  await app.organizations.addMember(owner, 'alpha-org', { principalId: viewer.id, role: 'viewer' });
  const other = await app.organizations.createOrganization(outsider, { slug: 'beta-org', displayName: 'Beta' });
  const tenantId = created.tenant.id;
  // Register the construction vertical package v1 the services bind.
  await app.verticals.registerVerticalPackage(owner, {
    tenantId,
    packageId: 'construction',
    version: 1,
    name: 'Construction',
    description: 'Construction industry vertical package',
    terminology: { subcontractor: 'A company engaged to perform part of the works' },
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
    pricingRules: [{ id: 'per-sub-onboarding', model: 'per_work_item' as const, amount: '25.00', currency: 'USD' }],
    idempotencyKey: 'pkg-v1',
  });
  return { app, owner, viewer, outsider, tenantId, otherTenantId: other.tenant.id };
}

function complianceService(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: 'filled-by-test',
    serviceId: 'subcontractor-compliance',
    version: 1,
    name: 'Subcontractor Compliance Service',
    description: 'Compliance monitoring for subcontractors',
    vertical: { packageId: 'construction', version: 1 },
    entities: [
      { entity: 'Project', required: true },
      { entity: 'Subcontractor', required: true },
    ],
    workDefinitions: [
      { workType: 'OnboardSubcontractor', description: 'Onboard one subcontractor' },
      { workType: 'CollectComplianceDocument' },
    ],
    workflowBinding: [
      { step: 'collect', from: 'in_progress', to: 'verifying' },
      { step: 'validate', from: 'verifying', to: 'completed' },
    ],
    policyConfiguration: [
      {
        policyKey: 'construction.subcontractor.review-threshold',
        parameters: [
          { name: 'reviewThreshold', type: 'number' as const, required: false, min: 0, max: 100000, defaultValue: 5000 },
        ],
      },
    ],
    approvalRules: [{ id: 'sub-onboarding-approval', threshold: 2 }],
    slaDefaults: [
      { workType: 'OnboardSubcontractor', deadlineHours: 24 },
      { workType: 'CollectComplianceDocument', deadlineHours: 12 },
    ],
    outcomeContract: {
      outcomeId: 'subcontractor-compliant',
      outputSchema: [
        { name: 'compliancePackageRef', type: 'string' as const, required: true },
        { name: 'approvedAt', type: 'date' as const, required: false },
      ],
      evidenceRequirements: ['insurance-certificate'],
      verification: 'deterministic' as const,
    },
    requiredExternalCapabilities: ['email'],
    requiredAiCapabilities: [{ capability: 'document.reasoning', minQuality: 0.9 }],
    pricing: {
      model: 'per_work_item' as const,
      amount: '30.00',
      currency: 'USD',
      metering: [{ metric: 'onboarded-subcontractor', unit: 'count', unitPrice: '30.00' }],
    },
    ...overrides,
  };
}

async function registerService(
  app: ServiceRuntimeApp,
  actor: Principal,
  tenantId: string,
  overrides: Record<string, unknown> = {},
  idempotencyKey?: string,
) {
  const input = complianceService(overrides);
  return app.services.registerServiceDefinition(actor, {
    ...input,
    tenantId,
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
  });
}

function expectServiceError(code: string, fn: () => Promise<unknown>): Promise<ServicesError> {
  return (async () => {
    try {
      await fn();
    } catch (error) {
      assert.ok(error instanceof ServicesError, `expected ServicesError, got ${String(error)}`);
      assert.equal(error.code, code, `expected code ${code}, got ${error.code}: ${error.message}`);
      return error;
    }
    throw new Error(`expected ServicesError ${code}, but the call succeeded`);
  })();
}

// ---------------------------------------------------------------------------
// AC-1: the versioned service definition bound to a vertical package
// ---------------------------------------------------------------------------

test('a service definition registers, binds the pinned vertical package and round-trips (AC-1)', async () => {
  const { app, owner, tenantId } = await base();
  const { definition, converged } = await registerService(app, owner, tenantId, {}, 'svc-v1');
  assert.equal(converged, false);
  assert.equal(definition.serviceId, 'subcontractor-compliance');
  assert.equal(definition.version, 1);
  assert.equal(definition.status, 'draft');
  assert.equal(definition.verticalPackageId, 'construction');
  assert.equal(definition.verticalPackageVersion, 1);
  assert.equal(definition.entities.length, 2);
  assert.equal(definition.workDefinitions.length, 2);
  assert.equal(definition.workflowBinding.length, 2);
  assert.equal(definition.workflowBinding[0]?.from, 'in_progress');
  assert.equal(definition.workflowBinding[0]?.to, 'verifying');
  assert.equal(definition.policyConfiguration[0]?.parameters[0]?.max, 100000);
  assert.equal(definition.approvalRules[0]?.threshold, 2);
  assert.equal(definition.slaDefaults[0]?.deadlineHours, 24);
  assert.equal(definition.outcomeContract.verification, 'deterministic');
  assert.equal(definition.outcomeContract.outputSchema.length, 2);
  assert.equal(definition.requiredExternalCapabilities[0], 'email');
  assert.equal(definition.requiredAiCapabilities[0]?.capability, 'document.reasoning');
  assert.equal(definition.requiredAiCapabilities[0]?.minQuality, 0.9);
  assert.equal(definition.pricing.model, 'per_work_item');
  assert.equal(definition.pricing.metering[0]?.metric, 'onboarded-subcontractor');
  assert.match(definition.contentHash, /^[0-9a-f]{64}$/);
  assert.match(definition.recordHash, /^[0-9a-f]{64}$/);
});

test('binding an unknown vertical package version fails closed', async () => {
  const { app, owner, tenantId } = await base();
  await expectServiceError('VERTICAL_PACKAGE_NOT_FOUND', () =>
    registerService(app, owner, tenantId, { vertical: { packageId: 'construction', version: 7 } }),
  );
  await expectServiceError('VERTICAL_PACKAGE_NOT_FOUND', () =>
    registerService(app, owner, tenantId, { vertical: { packageId: 'healthcare', version: 1 } }),
  );
  assert.equal(app.servicesStore.definitions.size, 0);
});

// ---------------------------------------------------------------------------
// The frozen canonical machine (architecture-lock #31 discrimination)
// ---------------------------------------------------------------------------

test('a workflow binding using a non-canonical state fails closed (cannot redefine the machine)', async () => {
  const { app, owner, tenantId } = await base();
  await expectServiceError('WORKFLOW_STATE_UNKNOWN', () =>
    registerService(app, owner, tenantId, {
      workflowBinding: [{ step: 'collect', from: 'partially_done', to: 'verifying' }],
    }),
  );
  await expectServiceError('WORKFLOW_STATE_UNKNOWN', () =>
    registerService(app, owner, tenantId, {
      workflowBinding: [{ step: 'validate', from: 'verifying', to: 'done_final' }],
    }),
  );
  assert.equal(app.servicesStore.definitions.size, 0, 'nothing persisted');
});

test('a workflow binding declaring an ILLEGAL canonical transition fails closed', async () => {
  const { app, owner, tenantId } = await base();
  // completed is terminal: no transition out.
  await expectServiceError('TRANSITION_ILLEGAL', () =>
    registerService(app, owner, tenantId, {
      workflowBinding: [{ step: 'validate', from: 'completed', to: 'in_progress' }],
    }),
  );
  // draft -> completed skips the machine's required path.
  await expectServiceError('TRANSITION_ILLEGAL', () =>
    registerService(app, owner, tenantId, {
      workflowBinding: [{ step: 'collect', from: 'draft', to: 'completed' }],
    }),
  );
  assert.equal(app.servicesStore.definitions.size, 0);
});

// ---------------------------------------------------------------------------
// Declared-semantics binding (references must exist in the package)
// ---------------------------------------------------------------------------

test('references to concepts the vertical does not declare fail closed', async () => {
  const { app, owner, tenantId } = await base();
  await expectServiceError('ENTITY_UNKNOWN', () =>
    registerService(app, owner, tenantId, { entities: [{ entity: 'Inspector', required: true }] }),
  );
  await expectServiceError('WORK_TYPE_UNKNOWN', () =>
    registerService(app, owner, tenantId, { workDefinitions: [{ workType: 'FilePermit' }] }),
  );
  await expectServiceError('WORKFLOW_STEP_UNKNOWN', () =>
    registerService(app, owner, tenantId, { workflowBinding: [{ step: 'escalate', from: 'in_progress', to: 'blocked' }] }),
  );
  await expectServiceError('POLICY_KEY_UNKNOWN', () =>
    registerService(app, owner, tenantId, {
      policyConfiguration: [
        { policyKey: 'construction.license.expiry-lead', parameters: [{ name: 'days', type: 'number', required: false }] },
      ],
    }),
  );
  await expectServiceError('POLICY_PARAMETER_UNKNOWN', () =>
    registerService(app, owner, tenantId, {
      policyConfiguration: [
        {
          policyKey: 'construction.subcontractor.review-threshold',
          parameters: [{ name: 'unknownParameter', type: 'number', required: false }],
        },
      ],
    }),
  );
  await expectServiceError('APPROVAL_RULE_UNKNOWN', () =>
    registerService(app, owner, tenantId, { approvalRules: [{ id: 'permit-approval', threshold: 1 }] }),
  );
  await expectServiceError('EVIDENCE_UNKNOWN', () =>
    registerService(app, owner, tenantId, {
      outcomeContract: {
        outcomeId: 'subcontractor-compliant',
        outputSchema: [{ name: 'ref', type: 'string', required: true }],
        evidenceRequirements: ['license-copy'],
        verification: 'deterministic',
      },
    }),
  );
  await expectServiceError('CAPABILITY_NOT_DECLARED', () =>
    registerService(app, owner, tenantId, { requiredExternalCapabilities: ['sms'] }),
  );
  await expectServiceError('CAPABILITY_NOT_DECLARED', () =>
    registerService(app, owner, tenantId, { requiredAiCapabilities: [{ capability: 'image.generation' }] }),
  );
  assert.equal(app.servicesStore.definitions.size, 0);
});

// ---------------------------------------------------------------------------
// Vertical specialization floors (the service may only tighten/strengthen)
// ---------------------------------------------------------------------------

test('a service SLA deadline that weakens the vertical floor fails closed', async () => {
  const { app, owner, tenantId } = await base();
  // Vertical floor for OnboardSubcontractor is 48h; 72h weakens it.
  await expectServiceError('SLA_WEAKENED', () =>
    registerService(app, owner, tenantId, {
      slaDefaults: [{ workType: 'OnboardSubcontractor', deadlineHours: 72 }],
    }),
  );
  // 24h tightens it (valid), and a SLA for an undeclared work type fails.
  await expectServiceError('WORK_TYPE_UNKNOWN', () =>
    registerService(app, owner, tenantId, {
      slaDefaults: [{ workType: 'FilePermit', deadlineHours: 24 }],
    }),
  );
  assert.equal(app.servicesStore.definitions.size, 0);
});

test('a service approval threshold that weakens the vertical floor fails closed', async () => {
  const { app, owner, tenantId } = await base();
  // Vertical requires threshold 1; a service threshold of 1 is equal (valid),
  // but 0 is not a valid threshold and 1 is the floor... use a package rule
  // with threshold 2 for the weakening case: register a second package.
  await app.verticals.registerVerticalPackage(owner, {
    ...complianceService(),
    packageId: 'construction',
    version: 2,
    tenantId,
    name: 'Construction v2',
    terminology: { subcontractor: 'A company engaged to perform part of the works' },
    entities: [{ name: 'Project', fields: [{ name: 'projectNumber', type: 'string', required: true }] }],
    workTypes: [{ name: 'OnboardSubcontractor', defaultSlaHours: 48 }],
    workflowSteps: [{ step: 'collect' }],
    policyDefaults: [{ policyKey: 'k', parameters: [{ name: 'p', defaultValue: 1 }] }],
    approvalMatrix: [{ id: 'strict-approval', role: 'director', threshold: 3 }],
    evidenceRequirements: [{ name: 'insurance-certificate' }],
    integrationBindings: [{ capabilityClass: 'email' }],
    zeckCapabilityRequirements: [{ capability: 'document.reasoning' }],
    pricingRules: [{ id: 'r', model: 'per_work_item' }],
    idempotencyKey: 'pkg-v2',
  });
  await expectServiceError('APPROVAL_WEAKENED', () =>
    registerService(app, owner, tenantId, {
      vertical: { packageId: 'construction', version: 2 },
      entities: [{ entity: 'Project', required: true }],
      workDefinitions: [{ workType: 'OnboardSubcontractor' }],
      workflowBinding: [{ step: 'collect', from: 'in_progress', to: 'verifying' }],
      policyConfiguration: [{ policyKey: 'k', parameters: [{ name: 'p', type: 'number', required: false }] }],
      approvalRules: [{ id: 'strict-approval', threshold: 2 }],
      slaDefaults: [{ workType: 'OnboardSubcontractor', deadlineHours: 48 }],
      outcomeContract: {
        outcomeId: 'x',
        outputSchema: [{ name: 'ref', type: 'string', required: true }],
        evidenceRequirements: [],
        verification: 'deterministic',
      },
      requiredExternalCapabilities: [],
      requiredAiCapabilities: [],
      pricing: { model: 'per_work_item', metering: [] },
    }),
  );
});

// ---------------------------------------------------------------------------
// Declarative discipline (no duplicate engines, no AI surfaces)
// ---------------------------------------------------------------------------

test('policy configuration carrying rule content is rejected (schema only)', async () => {
  const { app, owner, tenantId } = await base();
  await expectServiceError('POLICY_RULES_FORBIDDEN', () =>
    registerService(app, owner, tenantId, {
      policyConfiguration: [
        {
          policyKey: 'construction.subcontractor.review-threshold',
          rules: [{ id: 'r1', effect: 'deny' }],
          parameters: [{ name: 'reviewThreshold', type: 'number', required: false }],
        },
      ],
    }),
  );
  await expectServiceError('POLICY_RULES_FORBIDDEN', () =>
    registerService(app, owner, tenantId, {
      policyConfiguration: [
        {
          policyKey: 'construction.subcontractor.review-threshold',
          parameters: [{ name: 'reviewThreshold', type: 'number', required: false, effect: 'allow' }],
        },
      ],
    }),
  );
});

test('an AI capability requirement with a selection field is rejected (AC-4)', async () => {
  const { app, owner, tenantId } = await base();
  await expectServiceError('AI_SELECTION_FORBIDDEN', () =>
    registerService(app, owner, tenantId, {
      requiredAiCapabilities: [{ capability: 'document.reasoning', model: 'claude-4' }],
    }),
  );
  await expectServiceError('AI_SELECTION_FORBIDDEN', () =>
    registerService(app, owner, tenantId, {
      requiredAiCapabilities: [{ capability: 'document.reasoning', provider: 'anthropic' }],
    }),
  );
  assert.equal(app.servicesStore.definitions.size, 0);
});

test('an outcome contract declaring AI verification fails closed (business authority only)', async () => {
  const { app, owner, tenantId } = await base();
  await expectServiceError('AI_VERIFICATION_FORBIDDEN', () =>
    registerService(app, owner, tenantId, {
      outcomeContract: {
        outcomeId: 'subcontractor-compliant',
        outputSchema: [{ name: 'ref', type: 'string', required: true }],
        evidenceRequirements: ['insurance-certificate'],
        verification: 'ai_verification' as unknown as 'deterministic',
      },
    }),
  );
  await expectServiceError('AI_VERIFICATION_FORBIDDEN', () =>
    registerService(app, owner, tenantId, {
      outcomeContract: {
        outcomeId: 'subcontractor-compliant',
        outputSchema: [{ name: 'ref', type: 'string', required: true }],
        evidenceRequirements: [],
        verification: 'deterministic',
        aiVerification: true,
      } as unknown as never,
    }),
  );
});

test('schema declarations are validated internally (bounds, enums, defaults)', async () => {
  const { app, owner, tenantId } = await base();
  await expectServiceError('INVALID_INPUT', () =>
    registerService(app, owner, tenantId, {
      policyConfiguration: [
        {
          policyKey: 'construction.subcontractor.review-threshold',
          parameters: [
            { name: 'reviewThreshold', type: 'number', required: false, min: 500, max: 100 },
          ],
        },
      ],
    }),
  );
  await expectServiceError('INVALID_INPUT', () =>
    registerService(app, owner, tenantId, {
      policyConfiguration: [
        {
          policyKey: 'construction.subcontractor.review-threshold',
          parameters: [
            { name: 'reviewThreshold', type: 'number', required: false, min: 0, max: 100000, defaultValue: 500000 },
          ],
        },
      ],
    }),
  );
  // The vertical default is a number; a boolean schema for the same parameter is inconsistent.
  await expectServiceError('INVALID_INPUT', () =>
    registerService(app, owner, tenantId, {
      policyConfiguration: [
        {
          policyKey: 'construction.subcontractor.review-threshold',
          parameters: [{ name: 'reviewThreshold', type: 'boolean', required: false }],
        },
      ],
    }),
  );
});

// ---------------------------------------------------------------------------
// Lifecycle: draft -> active, forward-only, one-active (the service-package
// lifecycle — contract versioning, not the Service Work state machine)
// ---------------------------------------------------------------------------

test('the service-package lifecycle moves forward-only with one active version', async () => {
  const { app, owner, tenantId } = await base();
  await registerService(app, owner, tenantId, {}, 'svc-v1');
  const activated = await app.services.activateServiceDefinition(owner, tenantId, 'subcontractor-compliance', 1);
  assert.equal(activated.definition.status, 'active');
  assert.equal(activated.converged, false);
  // Re-activation converges.
  const again = await app.services.activateServiceDefinition(owner, tenantId, 'subcontractor-compliance', 1);
  assert.equal(again.converged, true);
  // Resolve finds it.
  const active = await app.services.resolveActiveServiceDefinition(owner, tenantId, 'subcontractor-compliance');
  assert.equal(active?.version, 1);
  // A second version activates and retires the first.
  const v2 = await registerService(app, owner, tenantId, { version: 2, name: 'Subcontractor Compliance v2' }, 'svc-v2');
  await app.services.activateServiceDefinition(owner, tenantId, 'subcontractor-compliance', 2);
  const activeAfter = await app.services.resolveActiveServiceDefinition(owner, tenantId, 'subcontractor-compliance');
  assert.equal(activeAfter?.version, 2);
  // The retired v1 can never return.
  await expectServiceError('VERSION_RETIRED', () =>
    app.services.activateServiceDefinition(owner, tenantId, 'subcontractor-compliance', 1),
  );
  const statuses = await app.services.listServiceDefinitions(owner, tenantId, 'subcontractor-compliance');
  assert.deepEqual(
    statuses.map((definition) => [definition.version, definition.status]),
    [[1, 'retired'], [2, 'active']],
  );
  // v2 remains draft-free: exactly one active at rest.
  assert.equal(v2.definition.version, 2);
  const actives = await app.services.listServiceDefinitions(owner, tenantId, 'subcontractor-compliance', 'active');
  assert.equal(actives.length, 1);
});

// ---------------------------------------------------------------------------
// Registration convergence and sequencing
// ---------------------------------------------------------------------------

test('duplicate service registration converges on identical content and conflicts on divergence', async () => {
  const { app, owner, tenantId } = await base();
  const first = await registerService(app, owner, tenantId, {}, 'svc-v1');
  const retry = await registerService(app, owner, tenantId, {}, 'svc-v1');
  assert.equal(retry.converged, true);
  assert.equal(retry.definition.id, first.definition.id);
  const twin = await registerService(app, owner, tenantId, {}, 'svc-other-key');
  assert.equal(twin.converged, true);
  assert.equal(twin.definition.id, first.definition.id);
  await expectServiceError('VERSION_CONTENT_CONFLICT', () =>
    registerService(app, owner, tenantId, { name: 'Mutated Name' }, 'svc-mutated'),
  );
  await expectServiceError('IDEMPOTENCY_INPUT_CONFLICT', () =>
    registerService(app, owner, tenantId, { name: 'Mutated Name' }, 'svc-v1'),
  );
  assert.equal(app.servicesStore.definitions.size, 1);
});

test('service version sequencing fails closed on gaps and skips', async () => {
  const { app, owner, tenantId } = await base();
  await expectServiceError('VERSION_NOT_SEQUENTIAL', () =>
    registerService(app, owner, tenantId, { version: 3 }, 'svc-skip'),
  );
  await registerService(app, owner, tenantId, { version: 1 }, 'svc-v1');
  await registerService(app, owner, tenantId, { version: 2 }, 'svc-v2');
  await expectServiceError('VERSION_NOT_SEQUENTIAL', () =>
    registerService(app, owner, tenantId, { version: 5 }, 'svc-skip-again'),
  );
  assert.equal(app.servicesStore.definitions.size, 2);
});

// ---------------------------------------------------------------------------
// Record integrity + tenancy
// ---------------------------------------------------------------------------

test('after-the-fact mutation of a stored definition is detected on read', async () => {
  const { app, owner, tenantId } = await base();
  const { definition } = await registerService(app, owner, tenantId, {}, 'svc-v1');
  const stored = app.servicesStore.definitions.get(definition.id);
  assert.ok(stored !== undefined);
  stored.name = 'Tampered Service';
  await expectServiceError('SERVICE_RECORD_TAMPERED', () =>
    app.services.getServiceDefinition(owner, tenantId, 'subcontractor-compliance', 1),
  );
  stored.name = 'Subcontractor Compliance Service';
  stored.status = 'active';
  await expectServiceError('SERVICE_RECORD_TAMPERED', () =>
    app.services.listServiceDefinitions(owner, tenantId, 'subcontractor-compliance'),
  );
});

test('lifecycle transitions keep the persisted record hash truthful', async () => {
  const { app, owner, tenantId } = await base();
  await registerService(app, owner, tenantId, {}, 'svc-v1');
  await app.services.activateServiceDefinition(owner, tenantId, 'subcontractor-compliance', 1);
  // The active record reads back WITHOUT tamper errors (the activation
  // recomputed the record hash over the new state).
  const active = await app.services.getServiceDefinition(owner, tenantId, 'subcontractor-compliance', 1);
  assert.equal(active.status, 'active');
  await registerService(app, owner, tenantId, { version: 2, name: 'v2' }, 'svc-v2');
  await app.services.activateServiceDefinition(owner, tenantId, 'subcontractor-compliance', 2);
  const retired = await app.services.getServiceDefinition(owner, tenantId, 'subcontractor-compliance', 1);
  assert.equal(retired.status, 'retired');
});

test('authorization happens before data access; cross-tenant reads are null', async () => {
  const { app, owner, viewer, outsider, tenantId, otherTenantId } = await base();
  await registerService(app, owner, tenantId, {}, 'svc-v1');
  const readsBefore =
    app.servicesStore.reads.definitionByKey + app.servicesStore.reads.definitionsList + app.servicesStore.reads.activeDefinition;
  await expectServiceError('ROLE_FORBIDDEN', () => registerService(app, viewer, tenantId, {}, 'svc-v'));
  await expectServiceError('TENANT_FORBIDDEN', () => registerService(app, outsider, tenantId, {}, 'svc-o'));
  const readsAfter =
    app.servicesStore.reads.definitionByKey + app.servicesStore.reads.definitionsList + app.servicesStore.reads.activeDefinition;
  assert.equal(readsAfter, readsBefore, 'no domain data was read during denials');
  const foreign = await app.services.resolveActiveServiceDefinition(outsider, otherTenantId, 'subcontractor-compliance');
  assert.equal(foreign, null);
  await expectServiceError('SERVICE_NOT_FOUND', () =>
    app.services.getServiceDefinition(outsider, otherTenantId, 'subcontractor-compliance', 1),
  );
});

test('activating an unknown definition version is a typed error', async () => {
  const { app, owner, tenantId } = await base();
  await expectServiceError('SERVICE_NOT_FOUND', () =>
    app.services.activateServiceDefinition(owner, tenantId, 'subcontractor-compliance', 9),
  );
  // An unregistered vertical package surfaces the typed binding error.
  await expectServiceError('VERTICAL_PACKAGE_NOT_FOUND', () =>
    registerService(app, owner, tenantId, { vertical: { packageId: 'ghost', version: 1 } }),
  );
});
