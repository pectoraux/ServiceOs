/**
 * ServiceOS /services SQL store (WORK-009, module internal).
 *
 * Authoritative persistence for versioned service definitions and
 * customer configurations, executed through the persistence boundary's
 * `TransactionalExecutor` (parameterized SQL only; this file never
 * imports `pg`). Load-bearing invariants:
 *
 * 1. MANDATORY TENANT PREDICATES on every query.
 *
 * 2. SERIALIZED VERSION SEQUENCING under transaction-scope advisory
 *    locks keyed on (tenant, service id) — separate lock namespaces for
 *    definitions and configurations. Caller-versioned definitions must
 *    be exactly max+1 (or duplicate-converge); store-allocated
 *    configuration versions never collide.
 *
 * 3. CONVERGENCE with `ON CONFLICT DO NOTHING` (any unique violation):
 *    a suppressed insert is re-read INSIDE the same healthy transaction
 *    (DO NEVER aborts it) and converges — content hash compared — or
 *    fails closed (`version-content-conflict` /
 *    `idempotency-input-conflict`).
 *
 * 4. FORWARD-ONLY, ONE-ACTIVE LIFECYCLE: activation locks the version
 *    row (`FOR UPDATE`), rejects retired versions (`version-retired`),
 *    converges on the already-active version, retires the prior active
 *    version of the same identity BEFORE activating this one (the
 *    one-active partial unique index is per-statement), and recomputes
 *    the record hash over the new row state atomically with the status
 *    write (the hash covers the CURRENT lifecycle state).
 *
 * 5. RECORD INTEGRITY: `mapDefinition`/`mapConfiguration` re-validate
 *    shapes defensively and recompute BOTH persisted hashes (content
 *    hash over the canonical content; record hash over the canonical
 *    record core including status and the persisted clock instants);
 *    any divergence fails closed (`service-record-tampered` /
 *    `configuration-record-tampered`).
 *
 * 6. CONTENT IS IMMUTABLE: the only UPDATEs are the lifecycle status
 *    writes (status/updated_at/record_hash); content columns are never
 *    rewritten.
 */
import type { SqlExecutor, TransactionalExecutor } from '../../platform/persistence/index.js';
import { StoreConflictError } from '../auth/index.js';
import type { ZeckCapabilityRequirement } from '../verticals/index.js';
import { validateZeckCapabilityRequirements } from '../verticals/index.js';
import {
  computeConfigurationContentHash,
  computeConfigurationRecordHash,
  computeDefinitionContentHash,
  computeDefinitionRecordHash,
} from './content.js';
import {
  ServicesStoreMissingError,
  ServicesStoreRuleError,
  type ApprovalAdjustment,
  type ApprovalRuleBinding,
  type EntityBinding,
  type MeteringRule,
  type OutcomeContract,
  type OutputFieldDefinition,
  type PolicyConfigurationDeclaration,
  type PolicyParameterValueSet,
  type PolicyParameterSchema,
  type PricingMetadata,
  type ActivateConfigurationInput,
  type ActivateDefinitionInput,
  type RegisterConfigurationInput,
  type RegisterDefinitionInput,
  type ServiceConfigurationRecord,
  type ServiceDefinitionRecord,
  type ServiceStatus,
  type ServicesStore,
  type SlaAdjustment,
  type SlaDefault,
  type WorkDefinitionBinding,
  type WorkflowStepBinding,
} from './store.js';

interface DefinitionRow {
  id: string;
  tenant_id: string;
  service_id: string;
  version: number;
  status: string;
  name: string;
  description: string | null;
  vertical_package_id: string;
  vertical_package_version: number;
  entities: unknown;
  work_definitions: unknown;
  workflow_binding: unknown;
  policy_configuration: unknown;
  approval_rules: unknown;
  sla_defaults: unknown;
  outcome_contract: unknown;
  required_external_capabilities: unknown;
  required_ai_capabilities: unknown;
  pricing: unknown;
  content_hash: string;
  record_hash: string;
  created_by: string;
  idempotency_key: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ConfigurationRow {
  id: string;
  tenant_id: string;
  service_id: string;
  service_version: number;
  configuration_version: number;
  status: string;
  policy_parameters: unknown;
  sla_adjustments: unknown;
  approval_adjustments: unknown;
  content_hash: string;
  record_hash: string;
  created_by: string;
  idempotency_key: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const DEFINITION_COLUMNS =
  'id, tenant_id, service_id, version, status, name, description, vertical_package_id, vertical_package_version, entities, work_definitions, workflow_binding, policy_configuration, approval_rules, sla_defaults, outcome_contract, required_external_capabilities, required_ai_capabilities, pricing, content_hash, record_hash, created_by, idempotency_key, created_at, updated_at';
const CONFIGURATION_COLUMNS =
  'id, tenant_id, service_id, service_version, configuration_version, status, policy_parameters, sla_adjustments, approval_adjustments, content_hash, record_hash, created_by, idempotency_key, created_at, updated_at';

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function isServiceStatus(value: string): value is ServiceStatus {
  return value === 'draft' || value === 'active' || value === 'retired';
}

function failTampered(rule: 'service-record-tampered' | 'configuration-record-tampered', detail: string): never {
  throw new ServicesStoreRuleError(detail, rule);
}

function asArray(raw: unknown, column: string): readonly unknown[] {
  if (!Array.isArray(raw)) failTampered('service-record-tampered', `column "${column}" is not an array`);
  return raw;
}

function asRecord(raw: unknown, column: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    failTampered('service-record-tampered', `column "${column}" is not an object`);
  }
  return raw as Record<string, unknown>;
}

function optionalString(raw: unknown): string | undefined {
  return typeof raw === 'string' ? raw : undefined;
}

// ---------------------------------------------------------------------------
// Definition mapping (defensive re-validation + hash verification)
// ---------------------------------------------------------------------------

function mapEntityBindings(raw: unknown): readonly EntityBinding[] {
  return asArray(raw, 'entities').map((entry) => {
    const candidate = asRecord(entry, 'entities entry');
    const { entity, required } = candidate;
    if (typeof entity !== 'string' || typeof required !== 'boolean') {
      failTampered('service-record-tampered', 'entity binding has an invalid shape');
    }
    return { entity, required };
  });
}

function mapWorkDefinitions(raw: unknown): readonly WorkDefinitionBinding[] {
  return asArray(raw, 'work_definitions').map((entry) => {
    const candidate = asRecord(entry, 'work_definitions entry');
    const { workType, description } = candidate;
    if (typeof workType !== 'string') {
      failTampered('service-record-tampered', 'work definition binding has an invalid shape');
    }
    return {
      workType,
      ...(optionalString(description) !== undefined ? { description: description as string } : {}),
    };
  });
}

function mapWorkflowBinding(raw: unknown): readonly WorkflowStepBinding[] {
  return asArray(raw, 'workflow_binding').map((entry) => {
    const candidate = asRecord(entry, 'workflow_binding entry');
    const { step, from, to, description } = candidate;
    if (typeof step !== 'string' || typeof from !== 'string' || typeof to !== 'string') {
      failTampered('service-record-tampered', 'workflow step binding has an invalid shape');
    }
    return {
      step,
      from,
      to,
      ...(optionalString(description) !== undefined ? { description: description as string } : {}),
    };
  });
}

function mapPolicyConfiguration(raw: unknown): readonly PolicyConfigurationDeclaration[] {
  return asArray(raw, 'policy_configuration').map((entry) => {
    const candidate = asRecord(entry, 'policy_configuration entry');
    const { policyKey, parameters } = candidate;
    if (typeof policyKey !== 'string' || !Array.isArray(parameters)) {
      failTampered('service-record-tampered', 'policy configuration declaration has an invalid shape');
    }
    const mapped: PolicyParameterSchema[] = parameters.map((parameter) => {
      const p = asRecord(parameter, 'policy parameter schema');
      const { name, type, required, min, max, values, defaultValue } = p;
      if (typeof name !== 'string' || typeof required !== 'boolean') {
        failTampered('service-record-tampered', 'policy parameter schema has an invalid shape');
      }
      if (type !== 'number' && type !== 'string' && type !== 'boolean' && type !== 'enum') {
        failTampered('service-record-tampered', 'policy parameter schema type is out of enumeration');
      }
      return {
        name,
        type,
        required,
        ...(min !== undefined ? { min: min as number } : {}),
        ...(max !== undefined ? { max: max as number } : {}),
        ...(values !== undefined ? { values: values as readonly string[] } : {}),
        ...(defaultValue !== undefined ? { defaultValue: defaultValue as string | number | boolean } : {}),
      };
    });
    return { policyKey, parameters: mapped };
  });
}

function mapApprovalRules(raw: unknown): readonly ApprovalRuleBinding[] {
  return asArray(raw, 'approval_rules').map((entry) => {
    const candidate = asRecord(entry, 'approval_rules entry');
    const { id, threshold } = candidate;
    if (typeof id !== 'string' || typeof threshold !== 'number') {
      failTampered('service-record-tampered', 'approval rule binding has an invalid shape');
    }
    return { id, threshold };
  });
}

function mapSlaDefaults(raw: unknown): readonly SlaDefault[] {
  return asArray(raw, 'sla_defaults').map((entry) => {
    const candidate = asRecord(entry, 'sla_defaults entry');
    const { workType, deadlineHours } = candidate;
    if (typeof workType !== 'string' || typeof deadlineHours !== 'number') {
      failTampered('service-record-tampered', 'SLA default has an invalid shape');
    }
    return { workType, deadlineHours };
  });
}

function mapOutputFields(raw: unknown): readonly OutputFieldDefinition[] {
  return asArray(raw, 'output_schema').map((entry) => {
    const candidate = asRecord(entry, 'output schema field');
    const { name, type, required } = candidate;
    if (typeof name !== 'string' || typeof required !== 'boolean') {
      failTampered('service-record-tampered', 'output schema field has an invalid shape');
    }
    if (type !== 'string' && type !== 'number' && type !== 'boolean' && type !== 'date') {
      failTampered('service-record-tampered', 'output schema field type is out of enumeration');
    }
    return { name, type, required };
  });
}

function mapOutcomeContract(raw: unknown): OutcomeContract {
  const candidate = asRecord(raw, 'outcome_contract');
  const { outcomeId, description, outputSchema, evidenceRequirements, verification } = candidate;
  if (typeof outcomeId !== 'string' || !Array.isArray(outputSchema) || !Array.isArray(evidenceRequirements)) {
    failTampered('service-record-tampered', 'outcome contract has an invalid shape');
  }
  if (verification !== 'deterministic' && verification !== 'human_approval' && verification !== 'external_record') {
    failTampered('service-record-tampered', 'outcome contract verification mode is out of enumeration');
  }
  return {
    outcomeId,
    ...(optionalString(description) !== undefined ? { description: description as string } : {}),
    outputSchema: mapOutputFields(outputSchema),
    evidenceRequirements: evidenceRequirements.map((name) => {
      if (typeof name !== 'string') failTampered('service-record-tampered', 'outcome evidence requirement is not a string');
      return name;
    }),
    verification,
  };
}

function mapExternalCapabilities(raw: unknown): readonly string[] {
  return asArray(raw, 'required_external_capabilities').map((entry) => {
    if (typeof entry !== 'string') failTampered('service-record-tampered', 'required external capability is not a string');
    return entry;
  });
}

function mapAiCapabilities(raw: unknown): readonly ZeckCapabilityRequirement[] {
  // The shared /verticals declaration contract performs the defensive
  // re-validation (fail-closed on smuggled selection fields).
  return validateZeckCapabilityRequirements(asArray(raw, 'required_ai_capabilities'));
}

function mapMetering(raw: unknown): readonly MeteringRule[] {
  return asArray(raw, 'metering').map((entry) => {
    const candidate = asRecord(entry, 'metering entry');
    const { metric, unit, unitPrice } = candidate;
    if (typeof metric !== 'string' || typeof unit !== 'string') {
      failTampered('service-record-tampered', 'metering rule has an invalid shape');
    }
    return {
      metric,
      unit,
      ...(optionalString(unitPrice) !== undefined ? { unitPrice: unitPrice as string } : {}),
    };
  });
}

function mapPricing(raw: unknown): PricingMetadata {
  const candidate = asRecord(raw, 'pricing');
  const { model, amount, currency, metering } = candidate;
  if (
    model !== 'subscription' &&
    model !== 'per_work_item' &&
    model !== 'per_outcome' &&
    model !== 'usage_band' &&
    model !== 'hybrid'
  ) {
    failTampered('service-record-tampered', 'pricing model is out of enumeration');
  }
  return {
    model,
    ...(optionalString(amount) !== undefined ? { amount: amount as string } : {}),
    ...(optionalString(currency) !== undefined ? { currency: currency as string } : {}),
    metering: mapMetering(metering),
  };
}

function mapDefinition(row: DefinitionRow): ServiceDefinitionRecord {
  if (!isServiceStatus(row.status)) {
    failTampered('service-record-tampered', `service definition ${row.service_id} v${row.version} status is out of enumeration`);
  }
  const record: ServiceDefinitionRecord = {
    id: row.id,
    tenantId: row.tenant_id,
    serviceId: row.service_id,
    version: row.version,
    status: row.status,
    name: row.name,
    description: row.description,
    verticalPackageId: row.vertical_package_id,
    verticalPackageVersion: row.vertical_package_version,
    entities: mapEntityBindings(row.entities),
    workDefinitions: mapWorkDefinitions(row.work_definitions),
    workflowBinding: mapWorkflowBinding(row.workflow_binding),
    policyConfiguration: mapPolicyConfiguration(row.policy_configuration),
    approvalRules: mapApprovalRules(row.approval_rules),
    slaDefaults: mapSlaDefaults(row.sla_defaults),
    outcomeContract: mapOutcomeContract(row.outcome_contract),
    requiredExternalCapabilities: mapExternalCapabilities(row.required_external_capabilities),
    requiredAiCapabilities: mapAiCapabilities(row.required_ai_capabilities),
    pricing: mapPricing(row.pricing),
    contentHash: row.content_hash,
    recordHash: row.record_hash,
    createdBy: row.created_by,
    idempotencyKey: row.idempotency_key,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
  if (computeDefinitionContentHash(record) !== record.contentHash) {
    failTampered(
      'service-record-tampered',
      `service definition ${row.service_id} v${row.version} content no longer matches its recorded content hash`,
    );
  }
  if (computeDefinitionRecordHash(record) !== record.recordHash) {
    failTampered(
      'service-record-tampered',
      `service definition ${row.service_id} v${row.version} record no longer matches its recorded integrity hash`,
    );
  }
  return record;
}

// ---------------------------------------------------------------------------
// Configuration mapping
// ---------------------------------------------------------------------------

function mapPolicyParameters(raw: unknown): readonly PolicyParameterValueSet[] {
  return asArray(raw, 'policy_parameters').map((entry) => {
    const candidate = asRecord(entry, 'policy_parameters entry');
    const { policyKey, values } = candidate;
    if (typeof policyKey !== 'string' || typeof values !== 'object' || values === null || Array.isArray(values)) {
      failTampered('configuration-record-tampered', 'policy parameter set has an invalid shape');
    }
    const mapped: Record<string, string | number | boolean> = {};
    for (const [name, value] of Object.entries(values as Record<string, unknown>)) {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        failTampered('configuration-record-tampered', 'policy parameter value is not primitive');
      }
      mapped[name] = value;
    }
    return { policyKey, values: mapped };
  });
}

function mapSlaAdjustments(raw: unknown): readonly SlaAdjustment[] {
  return asArray(raw, 'sla_adjustments').map((entry) => {
    const candidate = asRecord(entry, 'sla_adjustments entry');
    const { workType, deadlineHours } = candidate;
    if (typeof workType !== 'string' || typeof deadlineHours !== 'number') {
      failTampered('configuration-record-tampered', 'SLA adjustment has an invalid shape');
    }
    return { workType, deadlineHours };
  });
}

function mapApprovalAdjustments(raw: unknown): readonly ApprovalAdjustment[] {
  return asArray(raw, 'approval_adjustments').map((entry) => {
    const candidate = asRecord(entry, 'approval_adjustments entry');
    const { id, threshold } = candidate;
    if (typeof id !== 'string' || typeof threshold !== 'number') {
      failTampered('configuration-record-tampered', 'approval adjustment has an invalid shape');
    }
    return { id, threshold };
  });
}

function mapConfiguration(row: ConfigurationRow): ServiceConfigurationRecord {
  if (!isServiceStatus(row.status)) {
    failTampered('configuration-record-tampered', 'service configuration status is out of enumeration');
  }
  const record: ServiceConfigurationRecord = {
    id: row.id,
    tenantId: row.tenant_id,
    serviceId: row.service_id,
    serviceVersion: row.service_version,
    configurationVersion: row.configuration_version,
    status: row.status,
    policyParameters: mapPolicyParameters(row.policy_parameters),
    slaAdjustments: mapSlaAdjustments(row.sla_adjustments),
    approvalAdjustments: mapApprovalAdjustments(row.approval_adjustments),
    contentHash: row.content_hash,
    recordHash: row.record_hash,
    createdBy: row.created_by,
    idempotencyKey: row.idempotency_key,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
  if (computeConfigurationContentHash(record) !== record.contentHash) {
    failTampered(
      'configuration-record-tampered',
      `service configuration ${row.service_id} #${row.configuration_version} content no longer matches its recorded content hash`,
    );
  }
  if (computeConfigurationRecordHash(record) !== record.recordHash) {
    failTampered(
      'configuration-record-tampered',
      `service configuration ${row.service_id} #${row.configuration_version} record no longer matches its recorded integrity hash`,
    );
  }
  return record;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export function createSqlServicesStore(executor: TransactionalExecutor): ServicesStore {
  async function findDefinitionRowByIdempotencyKey(
    exec: SqlExecutor,
    tenantId: string,
    idempotencyKey: string,
  ): Promise<DefinitionRow | null> {
    const result = await exec.query(
      `SELECT ${DEFINITION_COLUMNS} FROM services_definitions WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, idempotencyKey],
    );
    const row = result.rows[0] as unknown as DefinitionRow | undefined;
    return row === undefined ? null : row;
  }

  async function findConfigurationRowByIdempotencyKey(
    exec: SqlExecutor,
    tenantId: string,
    idempotencyKey: string,
  ): Promise<ConfigurationRow | null> {
    const result = await exec.query(
      `SELECT ${CONFIGURATION_COLUMNS} FROM services_configurations WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, idempotencyKey],
    );
    const row = result.rows[0] as unknown as ConfigurationRow | undefined;
    return row === undefined ? null : row;
  }

  return {
    async registerDefinition(input: RegisterDefinitionInput): Promise<{ definition: ServiceDefinitionRecord; converged: boolean }> {
      return executor.withTransaction(async (tx) => {
        // Converge on an existing logical registration first.
        if (input.idempotencyKey !== null) {
          const existing = await findDefinitionRowByIdempotencyKey(tx, input.tenantId, input.idempotencyKey);
          if (existing !== null) {
            if (existing.content_hash !== input.contentHash) {
              throw new ServicesStoreRuleError(
                `service definition idempotency key "${input.idempotencyKey}" was already bound to different content`,
                'idempotency-input-conflict',
              );
            }
            return { definition: mapDefinition(existing), converged: true };
          }
        }
        // Serialize version sequencing for this (tenant, service id).
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `services-definition:${input.tenantId}:${input.serviceId}`,
        ]);
        // POST-LOCK IDEMPOTENCY RE-CHECK (the authoritative one): the
        // pre-lock lookup above is only a fast path for registrations that
        // had ALREADY committed. A racing same-key registration may have
        // committed while this transaction waited for the advisory lock —
        // invisible to the pre-lock statement snapshot, decisive here
        // (READ COMMITTED takes a fresh snapshot per statement). Without
        // this re-check a same-key divergent loser would exit through the
        // version-sequence branch with `version-content-conflict`,
        // violating the store contract's `idempotency-input-conflict` for
        // same-key divergence inside the serialized critical section.
        if (input.idempotencyKey !== null) {
          const raced = await findDefinitionRowByIdempotencyKey(tx, input.tenantId, input.idempotencyKey);
          if (raced !== null) {
            if (raced.content_hash !== input.contentHash) {
              throw new ServicesStoreRuleError(
                `service definition idempotency key "${input.idempotencyKey}" was already bound to different content`,
                'idempotency-input-conflict',
              );
            }
            return { definition: mapDefinition(raced), converged: true };
          }
        }
        const sequence = await tx.query(
          `SELECT COALESCE(MAX(version), 0) AS max FROM services_definitions WHERE tenant_id = $1 AND service_id = $2`,
          [input.tenantId, input.serviceId],
        );
        const max = (sequence.rows[0] as { max: number }).max;
        if (input.version <= max) {
          const existing = await tx.query(
            `SELECT ${DEFINITION_COLUMNS} FROM services_definitions WHERE tenant_id = $1 AND service_id = $2 AND version = $3`,
            [input.tenantId, input.serviceId, input.version],
          );
          const row = existing.rows[0] as unknown as DefinitionRow | undefined;
          if (row === undefined) {
            throw new ServicesStoreRuleError(
              `service definition ${input.serviceId} version ${input.version} is behind the registered sequence (max ${max}) and missing; versions must be contiguous`,
              'version-not-sequential',
            );
          }
          if (row.content_hash !== input.contentHash) {
            throw new ServicesStoreRuleError(
              `service definition ${input.serviceId} version ${input.version} is already registered with different content`,
              'version-content-conflict',
            );
          }
          return { definition: mapDefinition(row), converged: true };
        }
        if (input.version !== max + 1) {
          throw new ServicesStoreRuleError(
            `service definition ${input.serviceId} version ${input.version} skips the sequence (next is ${max + 1})`,
            'version-not-sequential',
          );
        }
        // ON CONFLICT DO NOTHING (any unique violation): a concurrent
        // creator committed first; this transaction stays healthy for the
        // convergence re-read below.
        const inserted = await tx.query(
          `INSERT INTO services_definitions
             (tenant_id, service_id, version, status, name, description, vertical_package_id, vertical_package_version,
              entities, work_definitions, workflow_binding, policy_configuration, approval_rules, sla_defaults,
              outcome_contract, required_external_capabilities, required_ai_capabilities, pricing,
              content_hash, record_hash, created_by, idempotency_key, created_at, updated_at)
           VALUES ($1, $2, $3, 'draft', $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb,
                   $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb, $17::jsonb, $18, $19, $20, $21, $22, $22)
           ON CONFLICT DO NOTHING
           RETURNING ${DEFINITION_COLUMNS}`,
          [
            input.tenantId,
            input.serviceId,
            input.version,
            input.name,
            input.description,
            input.verticalPackageId,
            input.verticalPackageVersion,
            JSON.stringify(input.entities),
            JSON.stringify(input.workDefinitions),
            JSON.stringify(input.workflowBinding),
            JSON.stringify(input.policyConfiguration),
            JSON.stringify(input.approvalRules),
            JSON.stringify(input.slaDefaults),
            JSON.stringify(input.outcomeContract),
            JSON.stringify(input.requiredExternalCapabilities),
            JSON.stringify(input.requiredAiCapabilities),
            JSON.stringify(input.pricing),
            input.contentHash,
            input.recordHash,
            input.createdBy,
            input.idempotencyKey,
            input.now,
          ],
        );
        if (inserted.rows.length > 0) {
          return { definition: mapDefinition(inserted.rows[0] as unknown as DefinitionRow), converged: false };
        }
        if (input.idempotencyKey !== null) {
          const byKey = await findDefinitionRowByIdempotencyKey(tx, input.tenantId, input.idempotencyKey);
          if (byKey !== null) {
            if (byKey.content_hash !== input.contentHash) {
              throw new ServicesStoreRuleError(
                `service definition idempotency key "${input.idempotencyKey}" was already bound to different content`,
                'idempotency-input-conflict',
              );
            }
            return { definition: mapDefinition(byKey), converged: true };
          }
        }
        const byIdentity = await tx.query(
          `SELECT ${DEFINITION_COLUMNS} FROM services_definitions WHERE tenant_id = $1 AND service_id = $2 AND version = $3`,
          [input.tenantId, input.serviceId, input.version],
        );
        const twin = byIdentity.rows[0] as unknown as DefinitionRow | undefined;
        if (twin !== undefined) {
          if (twin.content_hash !== input.contentHash) {
            throw new ServicesStoreRuleError(
              `service definition ${input.serviceId} version ${input.version} is already registered with different content`,
              'version-content-conflict',
            );
          }
          return { definition: mapDefinition(twin), converged: true };
        }
        throw new StoreConflictError(
          'registerDefinition violated a uniqueness constraint',
          'services_definitions_identity',
        );
      });
    },

    async findDefinition(tenantId: string, serviceId: string, version: number): Promise<ServiceDefinitionRecord | null> {
      const result = await executor.query(
        `SELECT ${DEFINITION_COLUMNS} FROM services_definitions WHERE tenant_id = $1 AND service_id = $2 AND version = $3`,
        [tenantId, serviceId, version],
      );
      const row = result.rows[0] as unknown as DefinitionRow | undefined;
      return row === undefined ? null : mapDefinition(row);
    },

    async listDefinitions(tenantId: string, serviceId?: string, status?: ServiceStatus): Promise<ServiceDefinitionRecord[]> {
      const clauses = ['tenant_id = $1'];
      const params: unknown[] = [tenantId];
      if (serviceId !== undefined) {
        params.push(serviceId);
        clauses.push(`service_id = $${params.length}`);
      }
      if (status !== undefined) {
        params.push(status);
        clauses.push(`status = $${params.length}`);
      }
      const result = await executor.query(
        `SELECT ${DEFINITION_COLUMNS} FROM services_definitions WHERE ${clauses.join(' AND ')} ORDER BY service_id ASC, version ASC`,
        params,
      );
      return result.rows.map((row) => mapDefinition(row as unknown as DefinitionRow));
    },

    async findActiveDefinition(tenantId: string, serviceId: string): Promise<ServiceDefinitionRecord | null> {
      const result = await executor.query(
        `SELECT ${DEFINITION_COLUMNS} FROM services_definitions
         WHERE tenant_id = $1 AND service_id = $2 AND status = 'active'
         ORDER BY version DESC LIMIT 1`,
        [tenantId, serviceId],
      );
      const row = result.rows[0] as unknown as DefinitionRow | undefined;
      return row === undefined ? null : mapDefinition(row);
    },

    async activateDefinition(input: ActivateDefinitionInput): Promise<{ definition: ServiceDefinitionRecord; converged: boolean }> {
      return executor.withTransaction(async (tx) => {
        const rows = await tx.query(
          `SELECT ${DEFINITION_COLUMNS} FROM services_definitions WHERE tenant_id = $1 AND service_id = $2 AND version = $3 FOR UPDATE`,
          [input.tenantId, input.serviceId, input.version],
        );
        const row = rows.rows[0] as unknown as DefinitionRow | undefined;
        if (row === undefined) {
          throw new ServicesStoreMissingError('definition', `${input.serviceId} v${input.version}`);
        }
        if (row.status === 'active') {
          // Idempotent re-activation: already the active version.
          return { definition: mapDefinition(row), converged: true };
        }
        if (row.status === 'retired') {
          // Forward-only: a retired version can never return to active.
          throw new ServicesStoreRuleError(
            `service definition ${input.serviceId} version ${input.version} is retired and cannot be re-activated`,
            'version-retired',
          );
        }
        // Retire the currently active version of the same identity FIRST
        // (the one-active partial unique index is enforced per statement).
        // The retired row's record hash is recomputed over its NEW state
        // (status/updated_at participate in the hash): lifecycle writes
        // keep every stored hash truthful.
        const priorRows = await tx.query(
          `SELECT ${DEFINITION_COLUMNS} FROM services_definitions WHERE tenant_id = $1 AND service_id = $2 AND status = 'active' FOR UPDATE`,
          [input.tenantId, input.serviceId],
        );
        const prior = priorRows.rows[0] as unknown as DefinitionRow | undefined;
        if (prior !== undefined) {
          const priorRecord = mapDefinition(prior);
          const retiredRecord: ServiceDefinitionRecord = {
            ...priorRecord,
            status: 'retired',
            updatedAt: input.now,
          };
          await tx.query(
            `UPDATE services_definitions SET status = 'retired', updated_at = $1, record_hash = $2
             WHERE tenant_id = $3 AND service_id = $4 AND version = $5 AND status = 'active'`,
            [
              input.now,
              computeDefinitionRecordHash(retiredRecord),
              input.tenantId,
              input.serviceId,
              priorRecord.version,
            ],
          );
        }
        // Recompute the record hash over the NEW row state (status/updated_at
        // participate in the hash — lifecycle writes keep it truthful).
        const draft = mapDefinition(row);
        const nextRecord: ServiceDefinitionRecord = {
          ...draft,
          status: 'active',
          updatedAt: input.now,
        };
        const nextRecordHash = computeDefinitionRecordHash(nextRecord);
        const updated = await tx.query(
          `UPDATE services_definitions SET status = 'active', updated_at = $1, record_hash = $2
           WHERE tenant_id = $3 AND service_id = $4 AND version = $5 AND status = 'draft'
           RETURNING ${DEFINITION_COLUMNS}`,
          [input.now, nextRecordHash, input.tenantId, input.serviceId, input.version],
        );
        if (updated.rows.length === 0) {
          throw new StoreConflictError(
            'activateDefinition lost the row lock race',
            'services_definitions_one_active',
          );
        }
        return { definition: mapDefinition(updated.rows[0] as unknown as DefinitionRow), converged: false };
      });
    },

    async registerConfiguration(input: RegisterConfigurationInput): Promise<{ configuration: ServiceConfigurationRecord; converged: boolean }> {
      return executor.withTransaction(async (tx) => {
        // Converge on an existing logical registration first.
        if (input.idempotencyKey !== null) {
          const existing = await findConfigurationRowByIdempotencyKey(tx, input.tenantId, input.idempotencyKey);
          if (existing !== null) {
            if (existing.content_hash !== input.contentHash) {
              throw new ServicesStoreRuleError(
                `service configuration idempotency key "${input.idempotencyKey}" was already bound to different content`,
                'idempotency-input-conflict',
              );
            }
            return { configuration: mapConfiguration(existing), converged: true };
          }
        }
        // Serialize configuration version allocation for this (tenant, service id).
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `services-configuration:${input.tenantId}:${input.serviceId}`,
        ]);
        // POST-LOCK IDEMPOTENCY RE-CHECK: the insert-conflict convergence
        // path below would also yield the contract's typed outcomes for a
        // racing same-key registration, but only after allocating a dead
        // configuration version; re-checking by key under the lock keeps
        // the serialized critical section's semantics uniform with
        // registerDefinition/registerPackage (same key + same content
        // converges; same key + divergent content fails closed with
        // `idempotency-input-conflict`).
        if (input.idempotencyKey !== null) {
          const raced = await findConfigurationRowByIdempotencyKey(tx, input.tenantId, input.idempotencyKey);
          if (raced !== null) {
            if (raced.content_hash !== input.contentHash) {
              throw new ServicesStoreRuleError(
                `service configuration idempotency key "${input.idempotencyKey}" was already bound to different content`,
                'idempotency-input-conflict',
              );
            }
            return { configuration: mapConfiguration(raced), converged: true };
          }
        }
        const sequence = await tx.query(
          `SELECT COALESCE(MAX(configuration_version), 0) + 1 AS next FROM services_configurations WHERE tenant_id = $1 AND service_id = $2`,
          [input.tenantId, input.serviceId],
        );
        const configurationVersion = (sequence.rows[0] as { next: number }).next;
        // The record hash is computed HERE over the full allocated
        // identity: the store-owned configurationVersion participates in
        // the hash, so only its allocator can compute it (the module
        // supplies the content hash).
        const recordHash = computeConfigurationRecordHash({
          id: '',
          tenantId: input.tenantId,
          serviceId: input.serviceId,
          serviceVersion: input.serviceVersion,
          configurationVersion,
          status: 'draft',
          policyParameters: input.policyParameters,
          slaAdjustments: input.slaAdjustments,
          approvalAdjustments: input.approvalAdjustments,
          contentHash: input.contentHash,
          recordHash: '',
          createdBy: input.createdBy,
          idempotencyKey: input.idempotencyKey,
          createdAt: input.now,
          updatedAt: input.now,
        });
        // ON CONFLICT DO NOTHING (any unique violation): a concurrent
        // registration of the same logical identity committed first; this
        // transaction stays healthy for the convergence re-read below.
        const inserted = await tx.query(
          `INSERT INTO services_configurations
             (tenant_id, service_id, service_version, configuration_version, status, policy_parameters,
              sla_adjustments, approval_adjustments, content_hash, record_hash, created_by, idempotency_key, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'draft', $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12, $12)
           ON CONFLICT DO NOTHING
           RETURNING ${CONFIGURATION_COLUMNS}`,
          [
            input.tenantId,
            input.serviceId,
            input.serviceVersion,
            configurationVersion,
            JSON.stringify(input.policyParameters),
            JSON.stringify(input.slaAdjustments),
            JSON.stringify(input.approvalAdjustments),
            input.contentHash,
            recordHash,
            input.createdBy,
            input.idempotencyKey,
            input.now,
          ],
        );
        if (inserted.rows.length > 0) {
          return { configuration: mapConfiguration(inserted.rows[0] as unknown as ConfigurationRow), converged: false };
        }
        if (input.idempotencyKey !== null) {
          const byKey = await findConfigurationRowByIdempotencyKey(tx, input.tenantId, input.idempotencyKey);
          if (byKey !== null) {
            if (byKey.content_hash !== input.contentHash) {
              throw new ServicesStoreRuleError(
                `service configuration idempotency key "${input.idempotencyKey}" was already bound to different content`,
                'idempotency-input-conflict',
              );
            }
            return { configuration: mapConfiguration(byKey), converged: true };
          }
        }
        throw new StoreConflictError(
          'registerConfiguration violated a uniqueness constraint',
          'services_configurations_identity',
        );
      });
    },

    async findConfigurationById(tenantId: string, configurationId: string): Promise<ServiceConfigurationRecord | null> {
      const result = await executor.query(
        `SELECT ${CONFIGURATION_COLUMNS} FROM services_configurations WHERE tenant_id = $1 AND id = $2`,
        [tenantId, configurationId],
      );
      const row = result.rows[0] as unknown as ConfigurationRow | undefined;
      return row === undefined ? null : mapConfiguration(row);
    },

    async listConfigurations(tenantId: string, serviceId?: string): Promise<ServiceConfigurationRecord[]> {
      const result =
        serviceId === undefined
          ? await executor.query(
              `SELECT ${CONFIGURATION_COLUMNS} FROM services_configurations WHERE tenant_id = $1 ORDER BY service_id ASC, configuration_version ASC`,
              [tenantId],
            )
          : await executor.query(
              `SELECT ${CONFIGURATION_COLUMNS} FROM services_configurations WHERE tenant_id = $1 AND service_id = $2 ORDER BY configuration_version ASC`,
              [tenantId, serviceId],
            );
      return result.rows.map((row) => mapConfiguration(row as unknown as ConfigurationRow));
    },

    async activateConfiguration(input: ActivateConfigurationInput): Promise<{ configuration: ServiceConfigurationRecord; converged: boolean }> {
      return executor.withTransaction(async (tx) => {
        const rows = await tx.query(
          `SELECT ${CONFIGURATION_COLUMNS} FROM services_configurations WHERE tenant_id = $1 AND service_id = $2 AND configuration_version = $3 FOR UPDATE`,
          [input.tenantId, input.serviceId, input.configurationVersion],
        );
        const row = rows.rows[0] as unknown as ConfigurationRow | undefined;
        if (row === undefined) {
          throw new ServicesStoreMissingError('configuration', `${input.serviceId} #${input.configurationVersion}`);
        }
        if (row.status === 'active') {
          return { configuration: mapConfiguration(row), converged: true };
        }
        if (row.status === 'retired') {
          throw new ServicesStoreRuleError(
            `service configuration ${input.serviceId} #${input.configurationVersion} is retired and cannot be re-activated`,
            'version-retired',
          );
        }
        // Retire the currently active configuration FIRST (one-active
        // partial unique index is enforced per statement); its record hash
        // is recomputed over its NEW retired state.
        const priorRows = await tx.query(
          `SELECT ${CONFIGURATION_COLUMNS} FROM services_configurations WHERE tenant_id = $1 AND service_id = $2 AND status = 'active' FOR UPDATE`,
          [input.tenantId, input.serviceId],
        );
        const prior = priorRows.rows[0] as unknown as ConfigurationRow | undefined;
        if (prior !== undefined) {
          const priorRecord = mapConfiguration(prior);
          const retiredRecord: ServiceConfigurationRecord = {
            ...priorRecord,
            status: 'retired',
            updatedAt: input.now,
          };
          await tx.query(
            `UPDATE services_configurations SET status = 'retired', updated_at = $1, record_hash = $2
             WHERE tenant_id = $3 AND service_id = $4 AND configuration_version = $5 AND status = 'active'`,
            [
              input.now,
              computeConfigurationRecordHash(retiredRecord),
              input.tenantId,
              input.serviceId,
              priorRecord.configurationVersion,
            ],
          );
        }
        const draft = mapConfiguration(row);
        const nextRecord: ServiceConfigurationRecord = {
          ...draft,
          status: 'active',
          updatedAt: input.now,
        };
        const nextRecordHash = computeConfigurationRecordHash(nextRecord);
        const updated = await tx.query(
          `UPDATE services_configurations SET status = 'active', updated_at = $1, record_hash = $2
           WHERE tenant_id = $3 AND service_id = $4 AND configuration_version = $5 AND status = 'draft'
           RETURNING ${CONFIGURATION_COLUMNS}`,
          [input.now, nextRecordHash, input.tenantId, input.serviceId, input.configurationVersion],
        );
        if (updated.rows.length === 0) {
          throw new StoreConflictError(
            'activateConfiguration lost the row lock race',
            'services_configurations_one_active',
          );
        }
        return { configuration: mapConfiguration(updated.rows[0] as unknown as ConfigurationRow), converged: false };
      });
    },

    async findActiveConfiguration(tenantId: string, serviceId: string): Promise<ServiceConfigurationRecord | null> {
      const result = await executor.query(
        `SELECT ${CONFIGURATION_COLUMNS} FROM services_configurations
         WHERE tenant_id = $1 AND service_id = $2 AND status = 'active'
         ORDER BY configuration_version DESC LIMIT 1`,
        [tenantId, serviceId],
      );
      const row = result.rows[0] as unknown as ConfigurationRow | undefined;
      return row === undefined ? null : mapConfiguration(row);
    },
  };
}
