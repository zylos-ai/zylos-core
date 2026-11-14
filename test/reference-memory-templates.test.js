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
    tier: text.split('\n').find(line => line.startsWith('| **Reference** |')),
    state: between(text, '5. **state.md', '\n### Handoff Follow-up'),
    classification: between(text, '### Classification Rules for reference/ Files', '\n### On-Demand Memory Loading'),
    loading: between(text, '### On-Demand Memory Loading', '\n## Data Directories'),
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
  // Baseline fails: Reference uses *.md with no directory/INDEX/page guidance.
  test(`${runtime}: Reference tier describes per-project and per-topic directories`, () => {
    assert.match(blocks.tier, /`memory\/reference\/`/);
    assert.match(blocks.tier, /`projects\/` and `decisions\/`/);
    assert.match(blocks.tier, /each with an INDEX; one project or decision topic per page/);
    assert.match(blocks.tier, /`preferences\.md`, `ideas\.md`/);
    assert.match(blocks.tier, /`legacy\/` holds the intact, read-only old projects.md\/decisions.md/);
    assert.match(blocks.tier, /search it for old projects and decisions missing from the new directories/);
  });

  // Baseline fails: completed narratives/rationale route to the old files and
  // there is no dated-result limit or prohibition on copying state blocks.
  test(`${runtime}: state routes concise dated results and decision rationale to pages`, () => {
    assert.match(blocks.state, /completed work → 1–3 dated lines of results on the relevant project\s+page in `reference\/projects\/`/);
    assert.match(blocks.state, /decision rationale → the relevant topic page in\s+`reference\/decisions\/`/);
    assert.match(blocks.state, /Do not copy state\.md\s+status blocks verbatim into reference\//);
    assert.doesNotMatch(blocks.state, /reference\/(?:projects|decisions)\.md/);
  });

  // Baseline fails: classification names .md records, omits INDEX-first reads,
  // and does not declare legacy files read-only.
  test(`${runtime}: classification checks INDEX first and preserves read-only history`, () => {
    assert.match(blocks.classification, /\*\*decisions\/:\*\* deliberate choices[\s\S]*`reference\/decisions\/INDEX\.md` first, then the relevant topic page/);
    assert.match(blocks.classification, /\*\*projects\/:\*\* work efforts[\s\S]*`reference\/projects\/INDEX\.md` first, then the relevant project page/);
    assert.match(blocks.classification, /Old `reference\/projects\.md` and `reference\/decisions\.md`, if present, are\s+read-only history\./);
    assert.match(blocks.classification, /After one-time reorganization they are in `reference\/legacy\/`;\s+search there for old projects and decisions missing from the new directories/);
    assert.match(blocks.classification, /\*\*preferences\.md:\*\*/);
    assert.match(blocks.classification, /\*\*ideas\.md:\*\*/);
  });

  // Baseline fails: on-demand triggers load monolithic files directly, with no
  // relevant-page selection or skill-directed legacy fallback.
  test(`${runtime}: on-demand loading selects relevant pages through INDEX`, () => {
    assert.match(blocks.loading, /making a decision → `reference\/decisions\/INDEX\.md`/);
    assert.match(blocks.loading, /starting\/resuming work → `reference\/projects\/INDEX\.md`/);
    assert.match(blocks.loading, /read the corresponding\s+INDEX first and open only relevant pages/);
    assert.match(blocks.loading, /If the INDEX is missing or has no matching entry, follow the zylos-memory skill\s+to search the old files/);
    assert.doesNotMatch(blocks.loading, /`(?:reference\/)?(?:projects|decisions)\.md`/);
  });
}

test('Claude and Codex use identical text in all four reference-memory regions', () => {
  const [claude, codex] = systems.map(({ text }) => regions(text));
  for (const key of ['tier', 'state', 'classification', 'loading']) {
    assert.equal(claude[key], codex[key], key);
  }
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
  assert.match(blocks[0], /natural stopping point/);
  assert.match(blocks[0], /examples, not fixed triggers/);
  assert.match(blocks[0], /If you are uncertain[\s\S]*existing idle TTL/);
  assert.match(blocks[0], /No minimum idle period is\s+required/);
});

const releaseGuidance = [
  ...systems.map(({ runtime, text }) => ({
    name: runtime,
    text: between(text, '## Voluntary Session Release', '\n## Security'),
  })),
  {
    name: 'activity monitor',
    text: between(read('skills/activity-monitor/SKILL.md'), 'A multi-session agent may request release', '\nThe supervisor reads these settings'),
  },
];

for (const { name, text } of releaseGuidance) {
  test(`${name}: release requests register intent through the installed command and inherited identity`, () => {
    assert.match(text, /`node ~\/zylos\/\.claude\/skills\/activity-monitor\/scripts\/supervisor-request\.js request-release --json`/);
    assert.match(text, /installed absolute path/);
    assert.match(text, /expand `~\/zylos` to the actual installation\s+directory/);
    assert.match(text, /inheriting\s+`ZYLOS_SESSION_GROUP` and `ZYLOS_RUN_ID`/);
    assert.match(text, /never supply\s+another group's identity/);
    assert.match(text, /`ok:true` response registers[\s\S]*in-memory intent,[\s\S]*not a\s+completed release/);
    assert.match(text, /Finish the current turn; the supervisor uses the existing\s+CHECK → optional Sync → reclaim flow/);
    assert.match(text, /New delivered work before fencing cancels the intent/);
    assert.match(text, /Supervisor restart (?:loses|drops)[\s\S]*intent[\s\S]*idle TTL[\s\S]*fallback/);
    assert.match(text, /On rejection or an unknown\s+result, keep the current run; do not exit\s+or assume release succeeded/);
  });

  test(`${name}: release requests do not duplicate supervisor preparation`, () => {
    assert.doesNotMatch(text, /pending work|current records|handoff|scheduled tasks|wake-up|external.wait|Waiting for a person|reply, review or decision|Finish work you\s+started/i);
  });
}
