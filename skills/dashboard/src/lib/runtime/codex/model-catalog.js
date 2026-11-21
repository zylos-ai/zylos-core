import { UNSUPPORTED } from '../contract.js';

// Maintained independently of client discovery caches and pricing tables.
const EXTENDED_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const MAX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_MODELS = [
  { id: 'gpt-6.2-sol', display_name: 'GPT-6.2-Sol', efforts: EXTENDED_EFFORTS },
  { id: 'gpt-6.2-astra', display_name: 'GPT-6.2-Astra', efforts: EXTENDED_EFFORTS },
  { id: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', efforts: EXTENDED_EFFORTS },
  { id: 'gpt-6.1-terra', display_name: 'GPT-6.1 Terra', efforts: EXTENDED_EFFORTS },
  { id: 'gpt-6-astra', display_name: 'GPT-6-Astra', efforts: EXTENDED_EFFORTS },
  { id: 'gpt-6-sol', display_name: 'GPT-6-Sol', efforts: EXTENDED_EFFORTS },
  { id: 'gpt-6-luna', display_name: 'GPT-6-Luna', efforts: MAX_EFFORTS },
  { id: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', efforts: EXTENDED_EFFORTS },
  { id: 'gpt-5.6-terra', display_name: 'GPT-5.6-Terra', efforts: MAX_EFFORTS },
  { id: 'gpt-5.6-luna', display_name: 'GPT-5.6-Luna', efforts: MAX_EFFORTS },
  { id: 'gpt-5.6', display_name: 'GPT-5.6 (Sol alias)', efforts: EXTENDED_EFFORTS },
];

export default Object.freeze({
  models() {
    return CODEX_MODELS.map(({ id, display_name }) => ({ id, display_name }));
  },
  effortsFor(id) {
    const entry = CODEX_MODELS.find(model => model.id === id);
    return entry ? [...entry.efforts] : null;
  },
  defaultEfforts: UNSUPPORTED,
  strict: true,
});
