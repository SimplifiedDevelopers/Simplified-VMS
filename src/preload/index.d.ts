import type { VmsBridge } from './index';

declare global {
  interface Window {
    vms: VmsBridge;
  }
}
