/**
 * ServiceOS module: /interactions.
 *
 * external communications and provider-neutral interaction ledger (architecture.md §6).
 *
 * Foundation placeholder (WORK-001): this file declares the module's public
 * interface and identity only. WORK-015 owns the module's business
 * implementation in a later Work Order; nothing here creates a second
 * authority or durable state.
 */
import { defineModule } from '../../platform/module-registry/index.js';

export default defineModule({
  name: 'interactions',
  version: '0.1.0',
  description: 'external communications and provider-neutral interaction ledger',
});
