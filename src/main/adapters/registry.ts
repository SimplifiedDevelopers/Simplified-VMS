import { DahuaAdapter } from './dahua';
import { HikvisionAdapter } from './hikvision';
import { TvtAdapter } from './tvt';
import { UniviewAdapter } from './uniview';
import type { VmsAdapter } from './vmsAdapter';
import type { VendorId } from '../../shared/types';

const adapters: Partial<Record<VendorId, VmsAdapter>> = {
  hikvision: new HikvisionAdapter(),
  uniview: new UniviewAdapter(),
  dahua: new DahuaAdapter(),
  tvt: new TvtAdapter(),
};

export function getAdapter(vendor: VendorId): VmsAdapter {
  const adapter = adapters[vendor];
  if (!adapter) {
    throw new Error(`No adapter registered for vendor: ${vendor}`);
  }
  return adapter;
}
