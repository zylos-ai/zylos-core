import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const {
  parseSelfUninstallOptions,
  shouldRemoveSelfUninstallData,
} = await import('../../commands/self-uninstall.js');

describe('self uninstall options', () => {
  it('treats --force as prompt skipping only, not data purge', () => {
    const options = parseSelfUninstallOptions(['--self', '--force']);

    assert.equal(options.force, true);
    assert.equal(options.purge, false);
    assert.equal(shouldRemoveSelfUninstallData(options), false);
  });

  it('removes the data directory only when --purge is explicit and confirmed', () => {
    assert.equal(
      shouldRemoveSelfUninstallData({ force: false, purge: true, confirmed: false }),
      false
    );
    assert.equal(
      shouldRemoveSelfUninstallData({ force: false, purge: true, confirmed: true }),
      true
    );
  });

  it('allows --force --purge as an explicit non-interactive data purge', () => {
    const options = parseSelfUninstallOptions(['--self', '--force', '--purge']);

    assert.equal(options.force, true);
    assert.equal(options.purge, true);
    assert.equal(shouldRemoveSelfUninstallData(options), true);
  });
});
