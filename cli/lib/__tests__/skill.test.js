import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import path from 'node:path';

const { parseSkillMd } = await import('../skill.js');

describe('parseSkillMd', () => {
  it('parses check-context as hidden from user invocation while remaining model-invocable', () => {
    const skillDir = path.join(import.meta.dirname, '..', '..', '..', 'skills', 'check-context');
    const parsed = parseSkillMd(skillDir);

    assert.ok(parsed);
    assert.equal(parsed.frontmatter.name, 'check-context');
    assert.equal(parsed.frontmatter['user-invocable'], false);
    assert.equal(parsed.frontmatter['disable-model-invocation'], undefined);
  });
});
