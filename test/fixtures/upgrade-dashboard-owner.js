// Deliberately small owner fixture: exercises real backup and migration orchestration.
import fs from 'node:fs';
export const dashboardSchemaOwner = {
  inspectSchema(db) {
    const currentVersion = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version;
    return { currentVersion, targetVersion: 21, needsMigration: currentVersion < 21 };
  },
  migrate(db) {
    const journals = fs.readdirSync(process.env.ZYLOS_DIR + '/.backup/self-upgrade');
    const journal = JSON.parse(fs.readFileSync(process.env.ZYLOS_DIR + '/.backup/self-upgrade/' + journals[0] + '/journal.json'));
    fs.appendFileSync(process.env.UPGRADE_EVENTS, JSON.stringify({ event:'rehearsal', phase:journal.phase, installationIntent:journal.installationIntent }) + '\n');
    if (process.env.UPGRADE_FAIL_MIGRATION === '1') throw Error('fixture migration refuses incompatible data');
    db.prepare('INSERT OR IGNORE INTO schema_migrations(version) VALUES (21)').run();
  },
};
