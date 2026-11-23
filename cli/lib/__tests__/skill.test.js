import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import path from 'node:path';

const {
  isModelInvocableSkill,
  isUserInvocableSkill,
  parseSkillMd,
} = await import('../skill.js');

describe('parseSkillMd', () => {

  it('defaults skills without invocation flags to user-visible and model-invocable', () => {
    const skillDir = path.join(import.meta.dirname, '..', '..', '..', 'skills', 'component-management');
    const parsed = parseSkillMd(skillDir);

    assert.ok(parsed);
    assert.equal(parsed.frontmatter.name, 'component-management');
    assert.equal(isUserInvocableSkill(parsed), true);
    assert.equal(isModelInvocableSkill(parsed), true);
  });
});
