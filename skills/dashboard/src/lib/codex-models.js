// Maintained independently of client discovery caches and pricing tables.
const EXTENDED_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const MAX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_MODELS = [
  { id: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', efforts: EXTENDED_EFFORTS },
  { id: 'gpt-6-astra', display_name: 'GPT-6-Astra', efforts: EXTENDED_EFFORTS },
  { id: 'gpt-6-sol', display_name: 'GPT-6-Sol', efforts: EXTENDED_EFFORTS },
  { id: 'gpt-6-luna', display_name: 'GPT-6-Luna', efforts: MAX_EFFORTS },
  { id: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', efforts: EXTENDED_EFFORTS },
  { id: 'gpt-5.6-terra', display_name: 'GPT-5.6-Terra', efforts: MAX_EFFORTS },
  { id: 'gpt-5.6-luna', display_name: 'GPT-5.6-Luna', efforts: MAX_EFFORTS },
  { id: 'gpt-5.6', display_name: 'GPT-5.6 (Sol alias)', efforts: EXTENDED_EFFORTS },
];

export function getCodexModels() {
  return CODEX_MODELS.map(model => ({ ...model, efforts: [...model.efforts] }));
}

export function codexEffortsForModel(id) {
  return [...(CODEX_MODELS.find(model => model.id === id)?.efforts || [])];
}
