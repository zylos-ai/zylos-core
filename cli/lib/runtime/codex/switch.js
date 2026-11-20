import { UNSUPPORTED } from '../contract.js';

export const sessionSwitch = Object.freeze({
  command: '/exit',
  exitsProcess: true,
  clearFiresSessionStart: UNSUPPORTED,
  clearSourceMarker: UNSUPPORTED,
});
