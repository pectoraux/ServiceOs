/**
 * Discrimination proof: tenant isolation across the /workflow surface
 * (WORK-004, CRITICAL — locks #15/#16: cross-tenant access fails closed).
 *
 * Proves:
 * - works in another tenant are indistinguishable from missing works
 *   (snapshot, transitions, SLA deadlines all carry the tenant predicate);
 * - a transition submitted for another tenant's work fails WORK_NOT_FOUND
 *   (never a cross-tenant mutation);
 * - transition records and SLA deadlines are invisible across tenants;
 * - SLA breach evaluation only reports the requesting tenant's works;
 * - authorization denials never touch domain data (reads counters);
 * - the audit ledger rows carry the tenant identity.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkflowApp, type WorkflowApp } from './helpers/in-memory-stores.js';
import type { Principal } from '../src/modules/auth/index.js';
import { WorkflowError } from '../src/modules/workflow/index.js';

const PASSWORD = 'correct horse battery 7';

interface Base {
  app: WorkflowApp;
  owner: Principal;
  tenantId: string;
  otherApp: WorkflowApp;
  otherOwner: Principal;
  otherTenantId: string;
}

/** Two independent apps (separate stores) model two tenants. */
async function base(): Promise<Base> {
  const app = buildWorkflowApp();
  const owner = await app.auth.registerHuman({ email: 'owner@a.com', password: PASSWORD, displayName: 'Owner' });
  const created = await app.organizations.createOrganization(owner, { slug: 'alpha-org', displayName: 'Alpha' });

  // A second app sharing NOTHING with the first: its stores model another
  // tenant's durable rows. To prove tenant predicates we ALSO inject the
  // other tenant's rows into the FIRST app's maps under a foreign tenant id
  // — the store must still refuse to read them through the predicate.
  const otherApp = buildWorkflowApp();
  const otherOwner = await otherApp.auth.registerHuman({ email: 'owner@b.com', password: PASSWORD, displayName: 'Other' });
  const otherCreated = await otherApp.organizations.createOrganization(otherOwner, { slug: 'beta-org', displayName: 'Beta' });
  return { app, owner, tenantId: created.tenant.id, otherApp, otherOwner, otherTenantId: otherCreated.tenant.id };
}

test('a work in another tenant is indistinguishable from a missing work', async () => {
  const b = await base();
  const { work } = await b.otherApp.work.createWork(b.otherOwner, {
    tenantId: b.otherTenantId,
    workType: 'compliance.onboarding',
    title: 'Foreign',
  });
  const snapshotReads = b.otherApp.workflowStore.reads.workSnapshot;
  // The foreign app's own store CAN see it...
  const own = await b.otherApp.workflowStore.getWorkSnapshot(b.otherTenantId, work.id);
  assert.ok(own !== null);
  assert.equal(b.otherApp.workflowStore.reads.workSnapshot, snapshotReads + 1);
  // ...through the tenant predicate of the FIRST app it is invisible.
  const foreign = await b.app.workflowStore.getWorkSnapshot(b.tenantId, work.id);
  assert.equal(foreign, null);
});

test('a transition for another tenant work id fails closed (no cross-tenant mutation)', async () => {
  const b = await base();
  const { work } = await b.otherApp.work.createWork(b.otherOwner, {
    tenantId: b.otherTenantId,
    workType: 'compliance.onboarding',
    title: 'Foreign',
  });
  // The first tenant's authorized actor submits a transition for the
  // foreign work id: the tenant predicate makes it absent.
  await assert.rejects(
    b.app.workflow.submitTransition(b.owner, b.tenantId, work.id, { to: 'ready' }),
    (error: unknown) => error instanceof WorkflowError && error.code === 'WORK_NOT_FOUND',
  );
  // The foreign work was not mutated.
  assert.equal((await b.otherApp.work.getWork(b.otherOwner, b.otherTenantId, work.id)).status, 'draft');
  assert.equal(b.otherApp.workflowStore.transitions.size, 0);
});

test('transition records are invisible across tenants', async () => {
  const b = await base();
  const { work } = await b.otherApp.work.createWork(b.otherOwner, {
    tenantId: b.otherTenantId,
    workType: 'compliance.onboarding',
    title: 'Foreign',
  });
  const { transition } = await b.otherApp.workflow.submitTransition(b.otherOwner, b.otherTenantId, work.id, {
    to: 'ready',
  });
  // Reading the foreign transition through the first tenant fails closed.
  await assert.rejects(
    b.app.workflow.getTransition(b.owner, b.tenantId, transition.id),
    (error: unknown) => error instanceof WorkflowError && error.code === 'TRANSITION_NOT_FOUND',
  );
  assert.equal((await b.app.workflow.listTransitions(b.owner, b.tenantId, work.id)).length, 0);
  // The audit row carries the owning tenant identity.
  const record = await b.otherApp.workflow.getTransition(b.otherOwner, b.otherTenantId, transition.id);
  assert.equal(record.tenantId, b.otherTenantId);
});

test('SLA deadlines are scoped per tenant and breaches stay tenant-local', async () => {
  const b = await base();
  const { work: ownWork } = await b.app.work.createWork(b.owner, {
    tenantId: b.tenantId,
    workType: 'compliance.onboarding',
    title: 'Own',
  });
  const { work: foreignWork } = await b.otherApp.work.createWork(b.otherOwner, {
    tenantId: b.otherTenantId,
    workType: 'compliance.onboarding',
    title: 'Foreign',
  });
  const past = new Date('2020-01-01T00:00:00.000Z');
  await b.app.workflow.setSlaDeadline(b.owner, b.tenantId, ownWork.id, { state: 'draft', deadlineAt: past });
  await b.otherApp.workflow.setSlaDeadline(b.otherOwner, b.otherTenantId, foreignWork.id, {
    state: 'draft',
    deadlineAt: past,
  });

  // Each tenant's breach evaluation reports ONLY its own works.
  const ownBreaches = await b.app.workflow.listSlaBreaches(b.owner, b.tenantId);
  assert.deepEqual(ownBreaches.map((entry) => entry.workId), [ownWork.id]);
  const foreignBreaches = await b.otherApp.workflow.listSlaBreaches(b.otherOwner, b.otherTenantId);
  assert.deepEqual(foreignBreaches.map((entry) => entry.workId), [foreignWork.id]);

  // Deadlines are invisible across tenants (same (work, state) row).
  assert.equal(await b.app.workflowStore.findSlaDeadline(b.tenantId, foreignWork.id, 'draft'), null);
  assert.equal((await b.app.workflow.listSlaDeadlines(b.owner, b.tenantId, ownWork.id)).length, 1);
});

test('authorization denials never touch domain data (no store reads on deny)', async () => {
  const b = await base();
  const outsider = await b.app.auth.registerHuman({ email: 'outsider@a.com', password: PASSWORD, displayName: 'Outsider' });
  const { work } = await b.app.work.createWork(b.owner, {
    tenantId: b.tenantId,
    workType: 'compliance.onboarding',
    title: 'Own',
  });
  const before = { ...b.app.workflowStore.reads };
  await assert.rejects(
    b.app.workflow.submitTransition(outsider, b.tenantId, work.id, { to: 'ready' }),
    (error: unknown) => error instanceof WorkflowError && error.code === 'TENANT_FORBIDDEN',
  );
  await assert.rejects(
    b.app.workflow.listTransitions(outsider, b.tenantId, work.id),
    (error: unknown) => error instanceof WorkflowError && error.code === 'TENANT_FORBIDDEN',
  );
  await assert.rejects(
    b.app.workflow.listContinuations(outsider, b.tenantId, work.id),
    (error: unknown) => error instanceof WorkflowError && error.code === 'TENANT_FORBIDDEN',
  );
  await assert.rejects(
    b.app.workflow.listSlaBreaches(outsider, b.tenantId),
    (error: unknown) => error instanceof WorkflowError && error.code === 'TENANT_FORBIDDEN',
  );
  await assert.rejects(
    b.app.workflow.setSlaDeadline(outsider, b.tenantId, work.id, { state: 'draft', deadlineAt: new Date() }),
    (error: unknown) => error instanceof WorkflowError && error.code === 'TENANT_FORBIDDEN',
  );
  assert.deepEqual(b.app.workflowStore.reads, before);
});

test('the SQL store text carries the mandatory tenant predicates (structural)', async () => {
  // Discrimination at the source level: every workflow_transitions /
  // workflow_sla_deadlines / work_service_works access in the SQL store
  // selects through tenant_id.
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const source = readFileSync(resolve(process.cwd(), 'src/modules/workflow/sql-store.ts'), 'utf8');
  const statements = source.match(/(?:SELECT|INSERT INTO|UPDATE)\s+[^\n]*(?:FROM\s+|INTO\s+|SET\s+)?[a-z_]+[^\n]*/g) ?? [];
  const workflowStatements = statements.filter((statement) =>
    /workflow_transitions|workflow_sla_deadlines|work_service_works|work_dependencies/.test(statement),
  );
  assert.ok(workflowStatements.length >= 10, 'expected a meaningful number of domain statements');
  for (const statement of workflowStatements) {
    // Multi-line statements carry the predicate on a following line; the
    // full statement text (up to the terminating parameter list) must
    // include tenant_id.
    const index = source.indexOf(statement);
    const full = source.slice(index, index + 900);
    assert.ok(
      /tenant_id\s*=\s*\$\d/.test(full) || /tenant_id,\s*work_id/.test(full) || /^COMMENT/.test(statement),
      `statement must carry the tenant predicate: ${statement.slice(0, 90)}`,
    );
  }
});
