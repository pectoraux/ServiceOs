/**
 * Concurrency proof: vertical-package and service-definition registration
 * convergence, lifecycle serialization and configuration convergence
 * under interleaving (WORK-009, required class `concurrency`).
 *
 * The in-memory stores' async hooks inject deterministic interleaving
 * points BEFORE each synchronous critical section (the exact semantics
 * of the advisory-locked SQL transactions), so these proofs exercise
 * real check-then-act races between INDEPENDENT actors:
 *
 * - two actors registering the same package version with the same
 *   content converge on ONE durable row (Work Order: "duplicate
 *   package/version registration converges");
 * - two actors registering the same package version with DIVERGENT
 *   content: exactly one wins, the loser fails closed with
 *   VERSION_CONTENT_CONFLICT (deterministic rejection);
 * - two actors racing the SAME idempotency key with divergent package or
 *   definition content: exactly one wins, the loser fails closed with
 *   IDEMPOTENCY_INPUT_CONFLICT (the serialized critical section's
 *   contract — the key is the logical identity; the SQL stores' post-lock
 *   re-check upholds the same code over real races);
 * - two actors racing to register the NEXT version of a package: one
 *   registers, the other converges (same content) or fails (divergent);
 * - two actors registering the same logical service definition
 *   (idempotency key) converge on one durable identity;
 * - concurrent activations of the SAME definition version converge (one
 *   activation observed, exactly one active at rest);
 * - concurrent activations of DIFFERENT versions leave exactly one
 *   active version — retirement-then-activation is atomic;
 * - concurrent registrations of the same customer configuration
 *   (idempotency key) converge on ONE durable record;
 * - concurrent same-key configuration registrations with DIVERGENT
 *   content: exactly one wins, the loser fails closed
 *   (IDEMPOTENCY_INPUT_CONFLICT — a customer configuration can never be
 *   silently re-pointed by a race);
 * - concurrent activations of two configuration versions leave exactly
 *   one active.
 *
 * The SQL-level equivalents of the same races run against live
 * PostgreSQL in test/service-vertical.integration.test.ts (CI).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServiceRuntimeApp, type ServiceRuntimeApp } from './helpers/in-memory-stores.js';
import type { Principal } from '../src/modules/auth/index.js';
import { VerticalsError } from '../src/modules/verticals/index.js';
import { ServicesError } from '../src/modules/services/index.js';

const PASSWORD = 'correct horse battery 7';

interface Base {
  app: ServiceRuntimeApp;
  owner: Principal;
  colleague: Principal;
  tenantId: string;
}

async function base(race?: () => Promise<void>): Promise<Base> {
  const app = buildServiceRuntimeApp({
    verticalStoreOptions: { beforeRegisterPackage: race },
    servicesStoreOptions: {
      beforeRegisterDefinition: race,
      beforeActivateDefinition: race,
      beforeRegisterConfiguration: race,
      beforeActivateConfiguration: race,
    },
  });
  const owner = await app.auth.registerHuman({ email: 'owner@a.com', password: PASSWORD, displayName: 'Owner' });
  const colleague = await app.auth.registerHuman({ email: 'member@a.com', password: PASSWORD, displayName: 'Member' });
  const created = await app.organizations.createOrganization(owner, { slug: 'alpha-org', displayName: 'Alpha' });
  await app.organizations.addMember(owner, 'alpha-org', { principalId: colleague.id, role: 'member' });
  return { app, owner, colleague, tenantId: created.tenant.id };
}

async function capture<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

function packageInput(tenantId: string, version: number, name = 'Construction', idempotencyKey?: string) {
  return {
    tenantId,
    packageId: 'construction',
    version,
    name,
    terminology: { subcontractor: 'A company engaged to perform part of the works' },
    entities: [{ name: 'Project', fields: [{ name: 'projectNumber', type: 'string' as const, required: true }] }],
    workTypes: [{ name: 'OnboardSubcontractor', defaultSlaHours: 48 }],
    workflowSteps: [{ step: 'collect' }],
    policyDefaults: [{ policyKey: 'k', parameters: [{ name: 'p', defaultValue: 1 }] }],
    approvalMatrix: [{ id: 'approval-1', role: 'pm', threshold: 1 }],
    evidenceRequirements: [{ name: 'insurance-certificate' }],
    integrationBindings: [{ capabilityClass: 'email' }],
    zeckCapabilityRequirements: [{ capability: 'document.reasoning' }],
    pricingRules: [{ id: 'r', model: 'per_work_item' as const }],
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
  };
}

function serviceDefinitionInput(tenantId: string, version: number, idempotencyKey: string) {
  return {
    tenantId,
    serviceId: 'subcontractor-compliance',
    version,
    name: 'Subcontractor Compliance Service',
    vertical: { packageId: 'construction', version: 1 },
    entities: [{ entity: 'Project', required: true }],
    workDefinitions: [{ workType: 'OnboardSubcontractor' }],
    workflowBinding: [{ step: 'collect', from: 'in_progress', to: 'verifying' }],
    policyConfiguration: [
      { policyKey: 'k', parameters: [{ name: 'p', type: 'number' as const, required: false, min: 0, max: 100000 }] },
    ],
    approvalRules: [{ id: 'approval-1', threshold: 1 }],
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
    idempotencyKey,
  };
}

async function registerService(
  app: ServiceRuntimeApp,
  actor: Principal,
  tenantId: string,
  version: number,
  idempotencyKey: string,
) {
  return app.services.registerServiceDefinition(actor, serviceDefinitionInput(tenantId, version, idempotencyKey));
}

// ---------------------------------------------------------------------------
// Package registration convergence (Work Order concurrency requirement)
// ---------------------------------------------------------------------------

test('two actors registering the same package version with the same content converge on one row', async () => {
  let release = 0;
  const race = async () => {
    if (release === 0) {
      release = 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const { app, owner, colleague, tenantId } = await base(race);
  const [a, b] = await Promise.all([
    app.verticals.registerVerticalPackage(owner, packageInput(tenantId, 1, 'Construction', 'key-a')),
    app.verticals.registerVerticalPackage(colleague, packageInput(tenantId, 1, 'Construction', 'key-b')),
  ]);
  assert.notEqual(a.converged, b.converged, 'exactly one insert and one convergence');
  assert.equal(a.pkg.id, b.pkg.id, 'ONE durable identity');
  assert.equal(app.verticalsStore.packages.size, 1);
});

test('two actors registering the same package version with divergent content: one wins, one fails deterministically', async () => {
  let release = 0;
  const race = async () => {
    if (release === 0) {
      release = 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const { app, owner, colleague, tenantId } = await base(race);
  const [a, b] = await Promise.all([
    capture(app.verticals.registerVerticalPackage(owner, packageInput(tenantId, 1, 'Construction', 'key-a'))),
    capture(app.verticals.registerVerticalPackage(colleague, packageInput(tenantId, 1, 'Construction v2', 'key-b'))),
  ]);
  const results = [a, b];
  const winners = results.filter((result) => result.ok);
  const losers = results.filter((result) => !result.ok);
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  const loser = losers[0];
  if (!loser.ok) {
    assert.ok(loser.error instanceof VerticalsError, `typed error, got ${String(loser.error)}`);
    assert.equal(loser.error.code, 'VERSION_CONTENT_CONFLICT');
  }
  assert.equal(app.verticalsStore.packages.size, 1, 'never two rows for one identity');
});

test('two actors racing the SAME idempotency key with divergent package content: the loser fails closed with IDEMPOTENCY_INPUT_CONFLICT', async () => {
  let release = 0;
  const race = async () => {
    if (release === 0) {
      release = 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const { app, owner, colleague, tenantId } = await base(race);
  const [a, b] = await Promise.all([
    capture(app.verticals.registerVerticalPackage(owner, packageInput(tenantId, 1, 'Construction', 'same-key'))),
    capture(app.verticals.registerVerticalPackage(colleague, packageInput(tenantId, 1, 'Construction v2', 'same-key'))),
  ]);
  const results = [a, b];
  assert.equal(results.filter((result) => result.ok).length, 1, 'exactly one winner');
  const losers = results.filter((result) => !result.ok);
  assert.equal(losers.length, 1, 'exactly one loser');
  const loser = losers[0];
  if (!loser.ok) {
    assert.ok(loser.error instanceof VerticalsError, `typed error, got ${String(loser.error)}`);
    // The store contract: same (tenant, idempotency key) + divergent
    // content fails closed with idempotency-input-conflict inside the
    // serialized critical section — the durable idempotency key is the
    // logical identity, NOT the (package, version) slot (the SQL store's
    // post-lock re-check upholds the same code under a true race).
    assert.equal(loser.error.code, 'IDEMPOTENCY_INPUT_CONFLICT');
  }
  assert.equal(app.verticalsStore.packages.size, 1, 'never two rows for one identity');
});

test('racing the NEXT package version: one registers, the other converges (identical content)', async () => {
  const { app, owner, colleague, tenantId } = await base();
  await app.verticals.registerVerticalPackage(owner, packageInput(tenantId, 1, 'Construction', 'key-v1'));
  let release = 0;
  const race = async () => {
    if (release === 0) {
      release = 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  app.verticalsStore.options.beforeRegisterPackage = race;
  const [a, b] = await Promise.all([
    app.verticals.registerVerticalPackage(owner, packageInput(tenantId, 2, 'Construction v2', 'key-v2-a')),
    app.verticals.registerVerticalPackage(colleague, packageInput(tenantId, 2, 'Construction v2', 'key-v2-b')),
  ]);
  assert.notEqual(a.converged, b.converged, 'exactly one insert and one convergence');
  assert.equal(a.pkg.id, b.pkg.id, 'ONE durable identity for v2');
  assert.equal(app.verticalsStore.packages.size, 2, 'v1 + ONE v2');
});

// ---------------------------------------------------------------------------
// Service definition convergence
// ---------------------------------------------------------------------------

test('two actors registering the same logical service definition converge on one durable identity', async () => {
  let release = 0;
  const race = async () => {
    if (release === 0) {
      release = 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const { app, owner, colleague, tenantId } = await base();
  await app.verticals.registerVerticalPackage(owner, packageInput(tenantId, 1, 'Construction', 'pkg-v1'));
  app.servicesStore.options.beforeRegisterDefinition = race;
  const [a, b] = await Promise.all([
    registerService(app, owner, tenantId, 1, 'svc-key'),
    registerService(app, colleague, tenantId, 1, 'svc-key'),
  ]);
  assert.notEqual(a.converged, b.converged, 'exactly one insert and one convergence');
  assert.equal(a.definition.id, b.definition.id);
  assert.equal(app.servicesStore.definitions.size, 1);
});

test('two actors racing the SAME idempotency key with divergent definition content: the loser fails closed with IDEMPOTENCY_INPUT_CONFLICT', async () => {
  let release = 0;
  const race = async () => {
    if (release === 0) {
      release = 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const { app, owner, colleague, tenantId } = await base(race);
  await app.verticals.registerVerticalPackage(owner, packageInput(tenantId, 1, 'Construction', 'pkg-v1'));
  const [a, b] = await Promise.all([
    capture(registerService(app, owner, tenantId, 1, 'svc-divergent')),
    capture(
      app.services.registerServiceDefinition(colleague, {
        ...serviceDefinitionInput(tenantId, 1, 'svc-divergent'),
        name: 'Divergent Service B',
      }),
    ),
  ]);
  const results = [a, b];
  assert.equal(results.filter((result) => result.ok).length, 1, 'exactly one winner');
  const losers = results.filter((result) => !result.ok);
  assert.equal(losers.length, 1, 'exactly one loser');
  const loser = losers[0];
  if (!loser.ok) {
    assert.ok(loser.error instanceof ServicesError, `typed error, got ${String(loser.error)}`);
    // The store contract: same (tenant, idempotency key) + divergent
    // content fails closed with idempotency-input-conflict inside the
    // serialized critical section (the SQL store's post-lock re-check
    // upholds the same code under a true race — the live proof pins it).
    assert.equal(loser.error.code, 'IDEMPOTENCY_INPUT_CONFLICT');
  }
  assert.equal(app.servicesStore.definitions.size, 1, 'never two rows for one identity');
});

test('concurrent activations of the SAME definition version converge (one active at rest)', async () => {
  let release = 0;
  const race = async () => {
    if (release === 0) {
      release = 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const { app, owner, colleague, tenantId } = await base();
  await app.verticals.registerVerticalPackage(owner, packageInput(tenantId, 1, 'Construction', 'pkg-v1'));
  await registerService(app, owner, tenantId, 1, 'svc-v1');
  app.servicesStore.options.beforeActivateDefinition = race;
  const [a, b] = await Promise.all([
    app.services.activateServiceDefinition(owner, tenantId, 'subcontractor-compliance', 1),
    app.services.activateServiceDefinition(colleague, tenantId, 'subcontractor-compliance', 1),
  ]);
  assert.equal([a.converged, b.converged].filter((converged) => converged).length, 1, 'exactly one activation');
  const actives = await app.services.listServiceDefinitions(owner, tenantId, 'subcontractor-compliance', 'active');
  assert.equal(actives.length, 1);
});

test('concurrent activations of DIFFERENT definition versions leave exactly one active', async () => {
  let release = 0;
  const race = async () => {
    if (release === 0) {
      release = 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const { app, owner, colleague, tenantId } = await base();
  await app.verticals.registerVerticalPackage(owner, packageInput(tenantId, 1, 'Construction', 'pkg-v1'));
  await registerService(app, owner, tenantId, 1, 'svc-v1');
  // Register v2 properly.
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
      { policyKey: 'k', parameters: [{ name: 'p', type: 'number' as const, required: false, min: 0, max: 100000 }] },
    ],
    approvalRules: [{ id: 'approval-1', threshold: 1 }],
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
  app.servicesStore.options.beforeActivateDefinition = race;
  const [a, b] = await Promise.all([
    capture(app.services.activateServiceDefinition(owner, tenantId, 'subcontractor-compliance', 1)),
    capture(app.services.activateServiceDefinition(colleague, tenantId, 'subcontractor-compliance', 2)),
  ]);
  // Both activations may succeed (1 activates, retires nothing; 2
  // activates, retires 1) — the invariant is ONE active at rest.
  assert.equal(a.ok || b.ok, true);
  const actives = await app.services.listServiceDefinitions(owner, tenantId, 'subcontractor-compliance', 'active');
  assert.equal(actives.length, 1, 'exactly one active version at rest');
  assert.ok(actives[0]?.version === 1 || actives[0]?.version === 2, 'the last-committed activation wins');
});

// ---------------------------------------------------------------------------
// Customer configuration convergence
// ---------------------------------------------------------------------------

async function configuredBase(race?: () => Promise<void>): Promise<Base> {
  const b = await base(race);
  await b.app.verticals.registerVerticalPackage(b.owner, packageInput(b.tenantId, 1, 'Construction', 'pkg-v1'));
  await registerService(b.app, b.owner, b.tenantId, 1, 'svc-v1');
  await b.app.services.activateServiceDefinition(b.owner, b.tenantId, 'subcontractor-compliance', 1);
  return b;
}

function configurationInput(tenantId: string, idempotencyKey?: string, reviewThreshold = 2500) {
  return {
    tenantId,
    serviceId: 'subcontractor-compliance',
    policyParameters: [
      { policyKey: 'k', values: { p: reviewThreshold } },
    ],
    slaAdjustments: [{ workType: 'OnboardSubcontractor', deadlineHours: 12 }],
    approvalAdjustments: [{ id: 'approval-1', threshold: 2 }],
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
  };
}

test('concurrent registrations of the same customer configuration converge on one record', async () => {
  let release = 0;
  const race = async () => {
    if (release === 0) {
      release = 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const { app, owner, colleague, tenantId } = await configuredBase(race);
  const [a, b] = await Promise.all([
    app.services.registerCustomerConfiguration(owner, configurationInput(tenantId, 'cfg-key')),
    app.services.registerCustomerConfiguration(colleague, configurationInput(tenantId, 'cfg-key')),
  ]);
  assert.notEqual(a.converged, b.converged, 'exactly one insert and one convergence');
  assert.equal(a.configuration.id, b.configuration.id);
  assert.equal(app.servicesStore.configurations.size, 1);
});

test('concurrent same-key configuration registrations with divergent input: one wins, one fails closed', async () => {
  let release = 0;
  const race = async () => {
    if (release === 0) {
      release = 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const { app, owner, colleague, tenantId } = await configuredBase(race);
  const [a, b] = await Promise.all([
    capture(app.services.registerCustomerConfiguration(owner, configurationInput(tenantId, 'cfg-key', 2500))),
    capture(app.services.registerCustomerConfiguration(colleague, configurationInput(tenantId, 'cfg-key', 9500))),
  ]);
  const winners = [a, b].filter((result) => result.ok);
  const losers = [a, b].filter((result) => !result.ok);
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  const loser = losers[0];
  if (!loser.ok) {
    assert.ok(loser.error instanceof ServicesError, `typed error, got ${String(loser.error)}`);
    assert.equal(loser.error.code, 'IDEMPOTENCY_INPUT_CONFLICT');
  }
  assert.equal(app.servicesStore.configurations.size, 1);
});

test('concurrent activations of two configuration versions leave exactly one active', async () => {
  const { app, owner, colleague, tenantId } = await configuredBase();
  await app.services.registerCustomerConfiguration(owner, configurationInput(tenantId, 'cfg-v1'));
  await app.services.registerCustomerConfiguration(owner, configurationInput(tenantId, 'cfg-v2', 3000));
  let release = 0;
  const race = async () => {
    if (release === 0) {
      release = 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  app.servicesStore.options.beforeActivateConfiguration = race;
  const [a, b] = await Promise.all([
    capture(app.services.activateCustomerConfiguration(owner, tenantId, 'subcontractor-compliance', 1)),
    capture(app.services.activateCustomerConfiguration(colleague, tenantId, 'subcontractor-compliance', 2)),
  ]);
  assert.equal(a.ok || b.ok, true);
  const active = await app.services.resolveActiveCustomerConfiguration(owner, tenantId, 'subcontractor-compliance');
  assert.ok(active !== null);
  assert.ok(
    active.configurationVersion === 1 || active.configurationVersion === 2,
    'the last-committed activation wins',
  );
  const all = await app.services.listCustomerConfigurations(owner, tenantId, 'subcontractor-compliance');
  assert.equal(all.filter((configuration) => configuration.status === 'active').length, 1);
});
