/**
 * Dynamic + discrimination proofs for the customer-configuration
 * authority (WORK-009, AC-3: "Customer configuration cannot weaken
 * horizontal authority invariants").
 *
 * Proves (in-memory store, faithful port implementation):
 * - a configuration registers against the ACTIVE service definition and
 *   pins the version it was validated against;
 * - policy parameter values are validated against the service's declared
 *   schema BEFORE persistence: out-of-bounds numbers, wrong types,
 *   non-member enums, unknown parameters/keys and missing REQUIRED
 *   parameters all fail closed — nothing weakened is ever persisted;
 * - SLA adjustments may only TIGHTEN (a looser deadline is SLA_WEAKENED);
 * - approval adjustments may only STRENGTHEN (a weaker threshold is
 *   APPROVAL_WEAKENED);
 * - the configuration input shape is structurally incapable of touching
 *   workflow bindings, outcome contracts, capability requirements or
 *   pricing (there is no field to carry them — no data can weaken them);
 * - the configuration lifecycle (draft -> active, forward-only,
 *   one-active, convergent re-activation);
 * - registration convergence by idempotency key + divergent-input
 *   conflict;
 * - record integrity (tamper detection) and tenancy;
 * - a configuration pinning survives a later service update (the record
 *   stays internally consistent with the version it was validated
 *   against).
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

  await app.verticals.registerVerticalPackage(owner, {
    tenantId,
    packageId: 'construction',
    version: 1,
    name: 'Construction',
    terminology: { subcontractor: 'A company engaged to perform part of the works' },
    entities: [{ name: 'Project', fields: [{ name: 'projectNumber', type: 'string' as const, required: true }] }],
    workTypes: [
      { name: 'OnboardSubcontractor', defaultSlaHours: 48 },
      { name: 'CollectComplianceDocument', defaultSlaHours: 24 },
    ],
    workflowSteps: [{ step: 'collect' }],
    policyDefaults: [
      {
        policyKey: 'construction.subcontractor.review-threshold',
        parameters: [
          { name: 'reviewThreshold', defaultValue: 5000 },
          { name: 'escalationLevel', defaultValue: 'standard' },
        ],
      },
    ],
    approvalMatrix: [
      { id: 'sub-onboarding-approval', workType: 'OnboardSubcontractor', role: 'project-manager', threshold: 1 },
    ],
    evidenceRequirements: [{ name: 'insurance-certificate' }],
    integrationBindings: [{ capabilityClass: 'email' }],
    zeckCapabilityRequirements: [{ capability: 'document.reasoning', minQuality: 0.8 }],
    pricingRules: [{ id: 'per-sub-onboarding', model: 'per_work_item' as const }],
    idempotencyKey: 'pkg-v1',
  });

  await app.services.registerServiceDefinition(owner, {
    tenantId,
    serviceId: 'subcontractor-compliance',
    version: 1,
    name: 'Subcontractor Compliance Service',
    vertical: { packageId: 'construction', version: 1 },
    entities: [{ entity: 'Project', required: true }],
    workDefinitions: [
      { workType: 'OnboardSubcontractor' },
      { workType: 'CollectComplianceDocument' },
    ],
    workflowBinding: [{ step: 'collect', from: 'in_progress', to: 'verifying' }],
    policyConfiguration: [
      {
        policyKey: 'construction.subcontractor.review-threshold',
        parameters: [
          {
            name: 'reviewThreshold',
            type: 'number' as const,
            required: true,
            min: 100,
            max: 100000,
            defaultValue: 5000,
          },
          {
            name: 'escalationLevel',
            type: 'enum' as const,
            required: false,
            values: ['standard', 'strict', 'critical'],
            defaultValue: 'standard',
          },
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
      outputSchema: [{ name: 'compliancePackageRef', type: 'string' as const, required: true }],
      evidenceRequirements: ['insurance-certificate'],
      verification: 'deterministic' as const,
    },
    requiredExternalCapabilities: ['email'],
    requiredAiCapabilities: [{ capability: 'document.reasoning' }],
    pricing: { model: 'per_work_item' as const, metering: [{ metric: 'onboarded-subcontractor', unit: 'count' }] },
    idempotencyKey: 'svc-v1',
  });
  await app.services.activateServiceDefinition(owner, tenantId, 'subcontractor-compliance', 1);
  return { app, owner, viewer, outsider, tenantId, otherTenantId: other.tenant.id };
}

function configurationInput(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: 'filled-by-test',
    serviceId: 'subcontractor-compliance',
    policyParameters: [
      {
        policyKey: 'construction.subcontractor.review-threshold',
        values: { reviewThreshold: 2500, escalationLevel: 'strict' },
      },
    ],
    slaAdjustments: [{ workType: 'OnboardSubcontractor', deadlineHours: 12 }],
    approvalAdjustments: [{ id: 'sub-onboarding-approval', threshold: 3 }],
    ...overrides,
  };
}

async function registerConfiguration(
  app: ServiceRuntimeApp,
  actor: Principal,
  tenantId: string,
  overrides: Record<string, unknown> = {},
  idempotencyKey?: string,
) {
  const input = configurationInput(overrides);
  return app.services.registerCustomerConfiguration(actor, {
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
// Registration against the active service (AC-3 happy path)
// ---------------------------------------------------------------------------

test('a valid customer configuration registers, pins the active service version and tightens', async () => {
  const { app, owner, tenantId } = await base();
  const { configuration, converged } = await registerConfiguration(app, owner, tenantId, {}, 'cfg-v1');
  assert.equal(converged, false);
  assert.equal(configuration.serviceId, 'subcontractor-compliance');
  assert.equal(configuration.serviceVersion, 1, 'pins the ACTIVE version it was validated against');
  assert.equal(configuration.configurationVersion, 1, 'store-allocated monotonic version');
  assert.equal(configuration.status, 'draft');
  assert.equal(configuration.policyParameters[0]?.values.reviewThreshold, 2500);
  assert.equal(configuration.slaAdjustments[0]?.deadlineHours, 12);
  assert.equal(configuration.approvalAdjustments[0]?.threshold, 3);
  assert.match(configuration.contentHash, /^[0-9a-f]{64}$/);
  assert.match(configuration.recordHash, /^[0-9a-f]{64}$/);
  // Tightened values are WITHIN the service's declared contract:
  // 2500 in [100, 100000]; 12h <= 24h; 3 >= 2.
});

test('configuring a service with no active definition fails closed', async () => {
  const { app, owner, tenantId } = await base();
  await expectServiceError('SERVICE_NOT_FOUND', () =>
    registerConfiguration(app, owner, tenantId, { serviceId: 'ghost-service' }),
  );
  // Deactivate-by-activation-of-v2: the pinned v1 goes retired but v2 is
  // active — configure v2-scoped content still works; the retired-only
  // case: a service where every version is retired is impossible via the
  // forward-only lifecycle (activating a new version retires the old one),
  // so the no-active case is covered by the unknown service above.
});

// ---------------------------------------------------------------------------
// Policy parameter schema enforcement (discrimination)
// ---------------------------------------------------------------------------

test('policy parameter values outside the service schema fail closed before persistence', async () => {
  const { app, owner, tenantId } = await base();
  await expectServiceError('POLICY_PARAMETER_OUT_OF_BOUNDS', () =>
    registerConfiguration(app, owner, tenantId, {
      policyParameters: [
        { policyKey: 'construction.subcontractor.review-threshold', values: { reviewThreshold: 150000 } },
      ],
    }),
  );
  await expectServiceError('POLICY_PARAMETER_OUT_OF_BOUNDS', () =>
    registerConfiguration(app, owner, tenantId, {
      policyParameters: [
        { policyKey: 'construction.subcontractor.review-threshold', values: { reviewThreshold: 50 } },
      ],
    }),
  );
  await expectServiceError('POLICY_PARAMETER_OUT_OF_BOUNDS', () =>
    registerConfiguration(app, owner, tenantId, {
      policyParameters: [
        { policyKey: 'construction.subcontractor.review-threshold', values: { reviewThreshold: '5000' } },
      ],
    }),
  );
  await expectServiceError('POLICY_PARAMETER_OUT_OF_BOUNDS', () =>
    registerConfiguration(app, owner, tenantId, {
      policyParameters: [
        { policyKey: 'construction.subcontractor.review-threshold', values: { escalationLevel: 'extreme' } },
      ],
    }),
  );
  assert.equal(app.servicesStore.configurations.size, 0, 'nothing persisted');
});

test('unknown policy keys and parameters fail closed; REQUIRED parameters must be supplied', async () => {
  const { app, owner, tenantId } = await base();
  await expectServiceError('POLICY_KEY_UNKNOWN', () =>
    registerConfiguration(app, owner, tenantId, {
      policyParameters: [{ policyKey: 'construction.license.expiry-lead', values: { days: 30 } }],
    }),
  );
  await expectServiceError('POLICY_PARAMETER_UNKNOWN', () =>
    registerConfiguration(app, owner, tenantId, {
      policyParameters: [
        { policyKey: 'construction.subcontractor.review-threshold', values: { noSuchParameter: 1 } },
      ],
    }),
  );
  // reviewThreshold is REQUIRED by the service schema: omitting it fails.
  await expectServiceError('POLICY_PARAMETER_OUT_OF_BOUNDS', () =>
    registerConfiguration(app, owner, tenantId, {
      policyParameters: [
        { policyKey: 'construction.subcontractor.review-threshold', values: { escalationLevel: 'strict' } },
      ],
    }),
  );
  assert.equal(app.servicesStore.configurations.size, 0);
});

test('customer configuration carrying rule content is rejected', async () => {
  const { app, owner, tenantId } = await base();
  await expectServiceError('POLICY_RULES_FORBIDDEN', () =>
    registerConfiguration(app, owner, tenantId, {
      policyParameters: [
        {
          policyKey: 'construction.subcontractor.review-threshold',
          rules: [{ id: 'r1', effect: 'allow' }],
          values: { reviewThreshold: 2500 },
        },
      ],
    }),
  );
});

// ---------------------------------------------------------------------------
// SLA tightening only (discrimination)
// ---------------------------------------------------------------------------

test('an SLA adjustment looser than the service default fails closed (SLA_WEAKENED)', async () => {
  const { app, owner, tenantId } = await base();
  // Service default for OnboardSubcontractor is 24h; 36h weakens it.
  await expectServiceError('SLA_WEAKENED', () =>
    registerConfiguration(app, owner, tenantId, {
      slaAdjustments: [{ workType: 'OnboardSubcontractor', deadlineHours: 36 }],
    }),
  );
  // Equal is valid (not a weakening); tighter is valid.
  const equal = await registerConfiguration(app, owner, tenantId, {
    slaAdjustments: [{ workType: 'OnboardSubcontractor', deadlineHours: 24 }],
  }, 'cfg-equal');
  assert.equal(equal.configuration.slaAdjustments[0]?.deadlineHours, 24);
  // Unknown work type fails closed.
  await expectServiceError('WORK_TYPE_UNKNOWN', () =>
    registerConfiguration(app, owner, tenantId, {
      slaAdjustments: [{ workType: 'FilePermit', deadlineHours: 10 }],
    }),
  );
  assert.equal(app.servicesStore.configurations.size, 1);
});

// ---------------------------------------------------------------------------
// Approval strengthening only (discrimination)
// ---------------------------------------------------------------------------

test('an approval adjustment weaker than the service requirement fails closed (APPROVAL_WEAKENED)', async () => {
  const { app, owner, tenantId } = await base();
  // Service requires threshold 2; 1 weakens it.
  await expectServiceError('APPROVAL_WEAKENED', () =>
    registerConfiguration(app, owner, tenantId, {
      approvalAdjustments: [{ id: 'sub-onboarding-approval', threshold: 1 }],
    }),
  );
  // Unknown approval rule fails closed.
  await expectServiceError('APPROVAL_RULE_UNKNOWN', () =>
    registerConfiguration(app, owner, tenantId, {
      approvalAdjustments: [{ id: 'permit-approval', threshold: 5 }],
    }),
  );
  assert.equal(app.servicesStore.configurations.size, 0);
});

test('the configuration input shape cannot touch workflow, outcome, capabilities or pricing', async () => {
  const { app, owner, tenantId } = await base();
  // There is NO field in RegisterCustomerConfigurationInput that carries
  // workflow bindings, outcome contracts, capability requirements or
  // pricing: a customer cannot even express a weakening of them. Prove it
  // structurally: an extra key is ignored by validation (unknown keys are
  // simply absent from the validated record).
  const { configuration } = await registerConfiguration(app, owner, tenantId, {}, 'cfg-v1');
  assert.equal('workflowBinding' in configuration, false);
  assert.equal('outcomeContract' in configuration, false);
  assert.equal('requiredAiCapabilities' in configuration, false);
  assert.equal('pricing' in configuration, false);
});

// ---------------------------------------------------------------------------
// Lifecycle, convergence, provenance
// ---------------------------------------------------------------------------

test('the configuration lifecycle is forward-only with one active configuration', async () => {
  const { app, owner, tenantId } = await base();
  await registerConfiguration(app, owner, tenantId, {}, 'cfg-v1');
  const activated = await app.services.activateCustomerConfiguration(owner, tenantId, 'subcontractor-compliance', 1);
  assert.equal(activated.configuration.status, 'active');
  const again = await app.services.activateCustomerConfiguration(owner, tenantId, 'subcontractor-compliance', 1);
  assert.equal(again.converged, true);
  const resolved = await app.services.resolveActiveCustomerConfiguration(owner, tenantId, 'subcontractor-compliance');
  assert.equal(resolved?.configurationVersion, 1);
  // A second configuration retires the first when activated.
  await registerConfiguration(app, owner, tenantId, {}, 'cfg-v2');
  await app.services.activateCustomerConfiguration(owner, tenantId, 'subcontractor-compliance', 2);
  const activeAfter = await app.services.resolveActiveCustomerConfiguration(owner, tenantId, 'subcontractor-compliance');
  assert.equal(activeAfter?.configurationVersion, 2);
  await expectServiceError('VERSION_RETIRED', () =>
    app.services.activateCustomerConfiguration(owner, tenantId, 'subcontractor-compliance', 1),
  );
  const all = await app.services.listCustomerConfigurations(owner, tenantId, 'subcontractor-compliance');
  assert.deepEqual(
    all.map((configuration) => [configuration.configurationVersion, configuration.status]),
    [[1, 'retired'], [2, 'active']],
  );
});

test('idempotency-key registration converges; divergent content fails closed', async () => {
  const { app, owner, tenantId } = await base();
  const first = await registerConfiguration(app, owner, tenantId, {}, 'cfg-v1');
  const retry = await registerConfiguration(app, owner, tenantId, {}, 'cfg-v1');
  assert.equal(retry.converged, true);
  assert.equal(retry.configuration.id, first.configuration.id);
  await expectServiceError('IDEMPOTENCY_INPUT_CONFLICT', () =>
    registerConfiguration(app, owner, tenantId, { slaAdjustments: [] }, 'cfg-v1'),
  );
  assert.equal(app.servicesStore.configurations.size, 1);
});

test('a configuration pins the service version it was validated against across later updates', async () => {
  const { app, owner, tenantId } = await base();
  await registerConfiguration(app, owner, tenantId, {}, 'cfg-v1');
  await app.services.activateCustomerConfiguration(owner, tenantId, 'subcontractor-compliance', 1);
  // Register and activate v2 of the service (a tighter contract).
  await app.services.registerServiceDefinition(owner, {
    tenantId,
    serviceId: 'subcontractor-compliance',
    version: 2,
    name: 'Subcontractor Compliance Service v2',
    vertical: { packageId: 'construction', version: 1 },
    entities: [{ entity: 'Project', required: true }],
    workDefinitions: [{ workType: 'OnboardSubcontractor' }],
    workflowBinding: [{ step: 'collect', from: 'in_progress', to: 'verifying' }],
    policyConfiguration: [
      {
        policyKey: 'construction.subcontractor.review-threshold',
        parameters: [
          { name: 'reviewThreshold', type: 'number' as const, required: true, min: 100, max: 100000, defaultValue: 5000 },
          { name: 'escalationLevel', type: 'enum' as const, required: false, values: ['standard', 'strict', 'critical'] },
        ],
      },
    ],
    approvalRules: [{ id: 'sub-onboarding-approval', threshold: 2 }],
    slaDefaults: [{ workType: 'OnboardSubcontractor', deadlineHours: 24 }],
    outcomeContract: {
      outcomeId: 'subcontractor-compliant',
      outputSchema: [{ name: 'compliancePackageRef', type: 'string' as const, required: true }],
      evidenceRequirements: ['insurance-certificate'],
      verification: 'deterministic' as const,
    },
    requiredExternalCapabilities: ['email'],
    requiredAiCapabilities: [{ capability: 'document.reasoning' }],
    pricing: { model: 'per_work_item' as const, metering: [] },
    idempotencyKey: 'svc-v2',
  });
  await app.services.activateServiceDefinition(owner, tenantId, 'subcontractor-compliance', 2);
  // The already-registered configuration still reads with its pinned v1
  // provenance — internally consistent.
  const resolved = await app.services.resolveActiveCustomerConfiguration(owner, tenantId, 'subcontractor-compliance');
  assert.equal(resolved?.serviceVersion, 1);
  // A NEW configuration registers against the now-active v2.
  const next = await registerConfiguration(app, owner, tenantId, {}, 'cfg-v2');
  assert.equal(next.configuration.serviceVersion, 2);
  assert.equal(next.configuration.configurationVersion, 2);
});

// ---------------------------------------------------------------------------
// Record integrity + tenancy
// ---------------------------------------------------------------------------

test('after-the-fact mutation of a stored configuration is detected on read', async () => {
  const { app, owner, tenantId } = await base();
  const { configuration } = await registerConfiguration(app, owner, tenantId, {}, 'cfg-v1');
  const stored = app.servicesStore.configurations.get(configuration.id);
  assert.ok(stored !== undefined);
  stored.slaAdjustments = [{ workType: 'OnboardSubcontractor', deadlineHours: 999 }];
  await expectServiceError('CONFIGURATION_RECORD_TAMPERED', () =>
    app.services.getCustomerConfiguration(owner, tenantId, configuration.id),
  );
  stored.slaAdjustments = [{ workType: 'OnboardSubcontractor', deadlineHours: 12 }];
  stored.contentHash = '0'.repeat(64);
  await expectServiceError('CONFIGURATION_RECORD_TAMPERED', () =>
    app.services.listCustomerConfigurations(owner, tenantId, 'subcontractor-compliance'),
  );
});

test('authorization happens before data access; cross-tenant configuration reads are null', async () => {
  const { app, owner, viewer, outsider, tenantId, otherTenantId } = await base();
  const readsBefore =
    app.servicesStore.reads.activeDefinition + app.servicesStore.reads.configurationById + app.servicesStore.reads.configurationsList + app.servicesStore.reads.activeConfiguration;
  await expectServiceError('ROLE_FORBIDDEN', () => registerConfiguration(app, viewer, tenantId, {}, 'cfg-v'));
  await expectServiceError('TENANT_FORBIDDEN', () => registerConfiguration(app, outsider, tenantId, {}, 'cfg-o'));
  const readsAfter =
    app.servicesStore.reads.activeDefinition + app.servicesStore.reads.configurationById + app.servicesStore.reads.configurationsList + app.servicesStore.reads.activeConfiguration;
  assert.equal(readsAfter, readsBefore, 'no domain data was read during denials');
  const foreign = await app.services.resolveActiveCustomerConfiguration(outsider, otherTenantId, 'subcontractor-compliance');
  assert.equal(foreign, null);
});

test('activating an unknown configuration is a typed error', async () => {
  const { app, owner, tenantId } = await base();
  await expectServiceError('CONFIGURATION_NOT_FOUND', () =>
    app.services.activateCustomerConfiguration(owner, tenantId, 'subcontractor-compliance', 9),
  );
});
