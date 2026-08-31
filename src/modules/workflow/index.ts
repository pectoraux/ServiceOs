/**
 * ServiceOS module: /workflow.
 *
 * deterministic business workflow state machine and transitions (architecture.md §6).
 *
 * Foundation placeholder (WORK-001): this file declares the module's public
 * interface and identity only. WORK-004 owns the module's business
 * implementation in a later Work Order; nothing here creates a second
 * authority or durable state.
 */
import { defineModule } from '../../platform/module-registry/index.js';

export default defineModule({
  name: 'workflow',
  version: '0.1.0',
  description: 'deterministic business workflow state machine and transitions',
});
