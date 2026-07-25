import { HikvisionAdapter } from './hikvision';
import type { VmsAdapter } from './vmsAdapter';
import type { VendorId } from '../../shared/types';

const adapters: Partial<Record<VendorId, VmsAdapter>> = {
  hikvision: new HikvisionAdapter(),
};

export function getAdapter(vendor: VendorId): VmsAdapter {
  const adapter = adapters[vendor];
  if (!adapter) {
    throw new Error(`No adapter registered for vendor: ${vendor}`);
  }
  return adapter;
}
