import * as reader from '../../cli/lib/session-state-reader.js';
const { method, args } = JSON.parse(process.env.P02_READER_CALL);
try {
  const value=reader[method](...args);
  process.stdout.write(JSON.stringify({value,promise:value instanceof Promise}));
} catch(error) {
  process.stdout.write(JSON.stringify({error:{code:error.code,cause:error.cause,message:error.message}}));
}
