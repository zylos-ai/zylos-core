import { configCommand } from '../../../commands/config.js';

// JSON transport permits API values such as NUL that an OS argv cannot contain.
try {
  await configCommand(JSON.parse(process.argv[2]));
} catch (error) {
  console.error(error.code ?? error.message);
  process.exitCode = 1;
}
