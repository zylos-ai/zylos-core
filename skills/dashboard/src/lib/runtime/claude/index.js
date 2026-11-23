import collector from './collector.js';
import history from './history.js';
import pricing from './pricing.js';
import modelCatalog from './model-catalog.js';
import activityVocabulary from './activity-vocabulary.js';

export default Object.freeze({
  id: 'claude', collector, history, pricing, modelCatalog, activityVocabulary,
});
