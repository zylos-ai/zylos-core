import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { parseSkillMd } = await import('../skill.js');

describe('parseSkillMd', () => {
  it('parses check-context as hidden from user invocation', () => {
    const parsed = parseSkillMd('/home/cocoai/zylos/workspace/zylos-core/skills/check-context');

    assert.ok(parsed);
    assert.equal(parsed.frontmatter.name, 'check-context');
    assert.equal(parsed.frontmatter['user-invocable'], false);
  });
});
