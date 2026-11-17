import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repo = fileURLToPath(new URL('..', import.meta.url));
const read = file => fs.readFileSync(path.join(repo, file), 'utf8');
const systems = ['claude', 'codex'].map(runtime => ({
  runtime, text: read(`templates/${runtime}-system.md`),
}));

function between(text, start, end) {
  const from = text.indexOf(start);
  assert.notEqual(from, -1, `missing section: ${start}`);
  const to = text.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing section boundary: ${end}`);
  return text.slice(from, to);
}

function regions(text) {
  return {
    table: between(text, '### Memory Tiers and Loading', '\n### Custom Standing Directives'),
    state: between(text, '5. **state.md', '\n### Handoff Follow-up'),
  };
}

// Baseline fails: the two monolithic templates exist. Checking the entire tree
// also rejects empty INDEX/sample replacements, which upgrades would copy out.
test('new-install memory templates omit legacy records and replacement pages', () => {
  const reference = path.join(repo, 'templates/memory/reference');
  const files = fs.readdirSync(reference, { recursive: true }).map(String);
  assert.equal(files.some(file => /^(projects|decisions)(\.md|[\\/]|$)/.test(file)), false);
});

// Baseline fails: both navigation entries target the old monolithic files.
test('reference navigation points decisions and projects to their INDEX', () => {
  const text = read('templates/memory/references.md');
  assert.match(text, /- Decisions: `memory\/reference\/decisions\/INDEX\.md` — read before revisiting a deliberate choice\./);
  assert.match(text, /- Projects: `memory\/reference\/projects\/INDEX\.md` — read when starting or resuming project work\./);
  assert.doesNotMatch(text, /reference\/(?:projects|decisions)\.md/);
});

for (const { runtime, text } of systems) {
  const blocks = regions(text);
  test(`${runtime}: memory table routes projects and decisions through relevant INDEX pages`, () => {
    for (const [name, directory, purpose] of [
      ['Projects', 'projects', 'Scoped work with a lifecycle'],
      ['Decisions', 'decisions', 'Deliberate choices closing alternatives'],
    ]) {
      const row = blocks.table.split('\n').find(line => line.startsWith(`| ${name} |`));
      assert.ok(row.includes(`memory/reference/${directory}/`));
      assert.ok(row.includes(purpose));
      assert.match(row, /read INDEX\.md/);
      assert.match(row, /then only relevant topic pages/);
    }
    for (const location of ['preferences.md', 'ideas.md', 'memory/users/<id>/profile.md', 'memory/reference/legacy/']) {
      assert.ok(blocks.table.includes(location), location);
    }
    assert.match(blocks.table, /Intact, read-only old projects.md\/decisions.md/);
    assert.match(blocks.table, /old files at reference\/ are also read-only/);
    assert.match(blocks.table, /For missing INDEX\/matches, follow zylos-memory skill to search old files/);
  });

  test(`${runtime}: state routes dated results, rationale and superseded detail outside working state`, () => {
    assert.match(blocks.table, /Completed work → 1–3 dated result lines on its project page/);
    assert.match(blocks.table, /Decision rationale belongs here/);
    assert.match(blocks.table, /store superseded detail here/);
    assert.match(blocks.state, /only the scope's Memory Sync maintains current focus, genuinely pending work and blockers/);
    assert.match(blocks.state, /Route completed work\/decision rationale\/superseded detail per table/);
    assert.match(blocks.state, /never copy state status blocks verbatim into reference\//);
  });
}

test('Claude and Codex use identical consolidated reference-memory guidance', () => {
  const [claude, codex] = systems.map(({ text }) => regions(text));
  for (const key of ['table', 'state']) assert.equal(claude[key], codex[key], key);
});

// Baseline fails: task recommendations and the completion write both depend on
// projects.md; deleting that template must not break the first-project flow.
test('onboarding contains task suggestions and records first-project results via inbox', () => {
  const text = read('templates/onboarding.md');
  for (const task of ['Scheduled reminder / info push', 'Build a personal web page',
    'Daily info aggregator (news/weather)', 'Simple web app / dashboard',
    'Custom workflow automation']) assert.ok(text.includes(task), task);
  assert.match(text, /recommend ★★ difficulty tasks for beginners/);
  assert.match(text, /record the dated result with `memory-append\.js inbox --kind fact`, passing the content on stdin/);
  assert.match(text, /Memory Sync will create the project page in `memory\/reference\/projects\/`/);
  assert.doesNotMatch(text, /reference\/(?:projects|decisions)\.md/);
});

test('both runtimes give identical voluntary release guidance and channel-neutral examples', () => {
  const blocks = systems.map(({ text }) => between(text, '## Voluntary Session Release', '\n## Security'));
  assert.equal(blocks[0], blocks[1]);
  assert.match(blocks[0], /you may request release at a natural stopping point/);
  assert.match(blocks[0], /examples, not fixed triggers/);
  assert.match(blocks[0], /no minimum idle time applies/);
  assert.match(blocks[0], /If unsure, remain available for idle TTL/);
});

for (const { runtime, text: system } of systems) {
  const text = between(system, '## Voluntary Session Release', '\n## Security');
  test(`${runtime}: release requests inherit identity and leave stopping to the supervisor`, () => {
    assert.match(text, /`node ~\/zylos\/\.claude\/skills\/activity-monitor\/scripts\/supervisor-request\.js request-release --json`/);
    for (const rule of [
      'installed absolute path',
      'inheriting `ZYLOS_SESSION_GROUP` and `ZYLOS_RUN_ID`',
      "never supply another group's identity",
      '`ok:true` records only an in-memory intent: finish the turn',
      'Once idle with no subagent/Memory Sync running',
      'supervisor performs the idle-reclaim pre-check',
      'syncs unsummarized conversations, then reclaims',
      'Work delivered before fencing cancels intent; you may request again after finishing it',
      'Restart loses intent; idle TTL remains the fallback',
      'Rejection/unknown result: keep running; never exit or assume release',
      'Only the supervisor stops the session',
    ]) assert.ok(text.includes(rule), rule);
  });

  test(`${runtime}: release requests do not duplicate supervisor preparation`, () => {
    assert.doesNotMatch(text, /pending work|current records|handoff|scheduled tasks|wake-up|external.wait|Waiting for a person|reply, review or decision|Finish work you\s+started/i);
  });
}

const releaseGuidance = [{ name: 'activity monitor', text: between(read('skills/activity-monitor/SKILL.md'), 'A multi-session agent may request release', '\nThe supervisor reads these settings') }];

for (const { name, text } of releaseGuidance) {
  test(`${name}: release requests register intent through the installed command and inherited identity`, () => {
    assert.match(text, /`node ~\/zylos\/\.claude\/skills\/activity-monitor\/scripts\/supervisor-request\.js request-release --json`/);
    assert.match(text, /installed absolute path/);
    assert.match(text, /expand `~\/zylos` to the actual installation\s+directory/);
    assert.match(text, /inheriting\s+`ZYLOS_SESSION_GROUP` and `ZYLOS_RUN_ID`/);
    assert.match(text, /never supply\s+another group's identity/);
    assert.match(text, /`ok:true` response registers[\s\S]*in-memory intent,[\s\S]*not a\s+completed release/);
    assert.ok(text.replace(/\s+/g, ' ').includes('Finish the current turn. Once the session is idle and no subagent or memory sync is running, the supervisor follows the same steps as idle reclaim: it sends the pre-reclaim check prompt, runs a memory sync if there are unsummarized conversations, then reclaims the session.'));
    assert.match(text, /New delivered work before fencing cancels the intent/);
    assert.match(text, /Supervisor restart (?:loses|drops)[\s\S]*intent[\s\S]*idle TTL[\s\S]*fallback/);
    assert.match(text, /On rejection or an unknown\s+result, keep the current run; do not exit\s+or assume release succeeded/);
  });

  test(`${name}: release requests do not duplicate supervisor preparation`, () => {
    assert.doesNotMatch(text, /pending work|current records|handoff|scheduled tasks|wake-up|external.wait|Waiting for a person|reply, review or decision|Finish work you\s+started/i);
  });
}
