import * as reader from '../../cli/lib/session-state-reader.js';
const { method, args } = JSON.parse(process.env.SESSION_READER_CALL);
try {
  const pending=reader[method](...args);
  const promise=pending instanceof Promise;
  const value=await pending;
  process.stdout.write(JSON.stringify({value,promise}));
} catch(error) {
  process.stdout.write(JSON.stringify({error:{code:error.code,cause:error.cause,message:error.message}}));
}
