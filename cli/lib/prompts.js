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
      resolve(answer.replace(/[\r\n]/g, '').trim());
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
/**
 * Ask a numbered choice question.
 * Returns the 1-based index of the selected option, or defaultChoice on empty input.
 * Returns defaultChoice if stdin is not a TTY.
 *
 * @param {string} question - The question header to display
 * @param {string[]} options - Array of option labels
 * @param {number} [defaultChoice=1] - Default 1-based choice
 * @returns {Promise<number>}
 */
export async function promptChoice(question, options, defaultChoice = 1) {
  if (!process.stdin.isTTY) return defaultChoice;
  console.log(question);
  for (let i = 0; i < options.length; i++) {
    const marker = (i + 1 === defaultChoice) ? '>' : ' ';
    console.log(`  ${marker} ${i + 1}) ${options[i]}`);
  }
  const answer = await prompt(`  Choice [${defaultChoice}]: `);
  if (!answer) return defaultChoice;
  const num = parseInt(answer, 10);
  if (num >= 1 && num <= options.length) return num;
  return defaultChoice;
}

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
      process.stdin.pause();
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
        resolve(input.replace(/[\r\n]/g, '').trim());
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
