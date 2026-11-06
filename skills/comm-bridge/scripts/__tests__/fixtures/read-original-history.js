import { getConversationsByRange, close } from '../../c4-db.js';
try { process.stdout.write(JSON.stringify(getConversationsByRange(Number(process.argv[2]), Number(process.argv[3])))); }
finally { close(); }
