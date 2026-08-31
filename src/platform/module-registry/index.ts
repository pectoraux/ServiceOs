/**
 * ServiceOS module registry (WORK-001 foundation).
 *
 * The modular monolith's business modules (architecture.md §6) each expose a
 * public interface — their `index.ts` — and nothing else. Cross-module access
 * goes through that public interface only; internal implementation imports are
 * forbidden and enforced structurally by the architecture checks.
 *
 * The registry is deliberately tiny: it validates manifests and keeps an
 * ordered, name-addressable view of the composed modules. It owns no domain
 * state and therefore creates no second authority.
 */

export interface ServiceModuleManifest {
  /** Kebab-case module name matching the architecture §6 module table. */
  readonly name: string;
  readonly version: string;
  readonly description: string;
}

export interface ServiceModule {
  readonly manifest: ServiceModuleManifest;
}

const MODULE_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

export class ModuleRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModuleRegistryError';
  }
}

/** Declare a business module. The manifest is frozen after validation. */
export function defineModule(manifest: ServiceModuleManifest): ServiceModule {
  if (typeof manifest.name !== 'string' || !MODULE_NAME_PATTERN.test(manifest.name)) {
    throw new ModuleRegistryError(
      `module name must be kebab-case (letters, digits, dashes) starting with a letter, received ${JSON.stringify(manifest.name)}`,
    );
  }
  if (typeof manifest.version !== 'string' || !VERSION_PATTERN.test(manifest.version)) {
    throw new ModuleRegistryError(
      `module ${manifest.name}: version must be semver X.Y.Z, received ${JSON.stringify(manifest.version)}`,
    );
  }
  if (typeof manifest.description !== 'string' || manifest.description.trim() === '') {
    throw new ModuleRegistryError(`module ${manifest.name}: description must be a non-empty string`);
  }
  return Object.freeze({ manifest: Object.freeze({ ...manifest }) });
}

export interface RegisteredModules {
  /** Modules in registration order. */
  readonly modules: readonly ServiceModule[];
  names(): string[];
  byName(): Map<string, ServiceModule>;
}

/** Compose modules into the registry, rejecting duplicates and unknown shapes. */
export function registerModules(modules: readonly ServiceModule[]): RegisteredModules {
  const seen = new Set<string>();
  for (const candidate of modules) {
    if (!candidate || typeof candidate !== 'object' || !candidate.manifest) {
      throw new ModuleRegistryError('registerModules expects ServiceModule objects with a manifest');
    }
    const { name } = candidate.manifest;
    if (!name) throw new ModuleRegistryError('module manifest is missing a name');
    if (seen.has(name)) {
      throw new ModuleRegistryError(`duplicate module registration for ${name}`);
    }
    seen.add(name);
  }
  const frozen = Object.freeze([...modules]);
  return {
    modules: frozen,
    names: () => frozen.map((m) => m.manifest.name),
    byName: () => new Map(frozen.map((m) => [m.manifest.name, m])),
  };
}
