/**
 * ServiceOS module: /audit.
 *
 * append-only privileged ServiceOS event trail (architecture.md §6).
 *
 * Foundation placeholder (WORK-001): this file declares the module's public
 * interface and identity only. A later Work Order owns the module's business
 * implementation in a later Work Order; nothing here creates a second
 * authority or durable state.
 */
import { defineModule } from '../../platform/module-registry/index.js';

export default defineModule({
  name: 'audit',
  version: '0.1.0',
  description: 'append-only privileged ServiceOS event trail',
});
