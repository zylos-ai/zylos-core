import { checkAuth } from './auth.js';
import { prepare } from './launch.js';

export default Object.freeze({
  id: 'codex',
  auth: Object.freeze({ checkAuth }),
  launch: Object.freeze({ prepare }),
  input: Object.freeze({ bracketedPaste: false }),
});
