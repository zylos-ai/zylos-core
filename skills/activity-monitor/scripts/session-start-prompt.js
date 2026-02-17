#!/usr/bin/env node
/**
 * Session start hook: outputs the startup prompt that tells Claude
 * to resume work or reply to waiting partners.
 *
 * Previously this was sent as a C4 control message from the activity
 * monitor after starting tmux. Moving it to a session start hook
 * ensures it's always injected immediately as session context.
 */

const prompt = [
  'SessionStart:compact hook success:',
  'reply to your human partner if they are waiting your reply,',
  'and continue your work if you have ongoing task according to the previous conversations.'
].join(' ');

process.stdout.write(prompt);
