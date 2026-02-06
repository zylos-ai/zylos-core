/**
 * Shared interactive prompt utilities
 */

import readline from 'node:readline';

/**
 * Ask the user a question and return the trimmed answer.
 * Returns empty string if stdin is not a TTY.
 *
 * @param {string} question - The question to display
 * @returns {Promise<string>}
 */
export function prompt(question) {
  if (!process.stdin.isTTY) return Promise.resolve('');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Ask a yes/no question.
 * Returns defaultYes if stdin is not a TTY or user presses Enter.
 *
 * @param {string} question - The question to display (include [Y/n] hint)
 * @param {boolean} [defaultYes=false]
 * @returns {Promise<boolean>}
 */
export function promptYesNo(question, defaultYes = false) {
  if (!process.stdin.isTTY) return Promise.resolve(defaultYes);
  return prompt(question).then((answer) => {
    if (!answer) return defaultYes;
    return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
  });
}

/**
 * Prompt for sensitive input (masks with *).
 * Returns empty string if stdin is not a TTY.
 *
 * @param {string} question - The question to display
 * @returns {Promise<string>}
 */
export function promptSecret(question) {
  if (!process.stdin.isTTY) return Promise.resolve('');

  return new Promise((resolve) => {
    process.stdout.write(question);

    // Enable raw mode to capture each keypress
    process.stdin.setRawMode(true);
    process.stdin.resume();

    let input = '';

    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.removeListener('data', onData);
      process.stdout.write('\n');
    };

    const onData = (key) => {
      const ch = key.toString();
      // Ctrl-C
      if (ch === '\u0003') {
        cleanup();
        resolve('');
        return;
      }
      // Enter
      if (ch === '\r' || ch === '\n') {
        cleanup();
        resolve(input);
        return;
      }
      // Backspace
      if (ch === '\u007F' || ch === '\b') {
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stdout.write('\b \b');
        }
        return;
      }
      // Printable character
      input += ch;
      process.stdout.write('*');
    };

    process.stdin.on('data', onData);
  });
}
