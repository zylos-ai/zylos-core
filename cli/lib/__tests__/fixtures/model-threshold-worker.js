import { setModelThreshold } from '../../model-rotation-thresholds.js';
const [zylosDir, model, value] = process.argv.slice(2);
await setModelThreshold({ zylosDir, runtime: 'claude', model, value: Number(value) });
