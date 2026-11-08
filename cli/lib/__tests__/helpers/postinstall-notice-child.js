import { printInitializationNotice } from '../../postinstall-notice.js';

printInitializationNotice({ ttyPath: process.argv[2] });
