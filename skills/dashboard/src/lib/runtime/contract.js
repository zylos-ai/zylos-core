import { loadCoreModule } from '../core-modules.js';

export const { UNSUPPORTED } = await loadCoreModule('runtime/contract.js');

export const DASHBOARD_CAPABILITIES = Object.freeze({
  collector: Object.freeze({ required: false, members: Object.freeze({
    create: 'required',
    taskName: 'required',
    logName: 'required',
    eventDriven: 'required',
    sourceHealth: 'required',
    discover: 'optional',
    onRegistered: 'optional',
    currentTranscript: 'optional',
    ownedFiles: 'required',
    discoverChildren: 'optional',
    flush: 'required',
    projectWeights: 'optional',
  }) }),
  history: Object.freeze({ required: false }),
  pricing: Object.freeze({ required: false, members: Object.freeze({
    id: 'required',
    defaultModelPrices: 'required',
    serviceTiers: 'optional',
    fastMode: 'optional',
    legacyKeys: 'optional',
  }) }),
  modelCatalog: Object.freeze({ required: false, members: Object.freeze({
    models: 'required',
    effortsFor: 'required',
    defaultEfforts: 'optional',
    strict: 'required',
  }) }),
  activityVocabulary: Object.freeze({ required: false, members: Object.freeze({
    toolEvents: 'required',
    stepLabel: 'required',
    opensStep: 'optional',
    subagentLaunchTools: 'required',
    resumesCells: 'required',
  }) }),
});
