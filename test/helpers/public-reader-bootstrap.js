// Explicit opt-in bootstrap inherited via execArgv by the public reader Worker.
import { installParserFixture } from './p02-parser-fixture.js';
installParserFixture(['origin','telegram:test']);
