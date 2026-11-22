import { inspectDatabase, migrateDatabase } from './schema.js';

export const dashboardSchemaOwner = Object.freeze({
  inspectSchema(db) {
    return inspectDatabase(db);
  },
  migrate(db, options) {
    migrateDatabase(db, options);
    return inspectDatabase(db);
  },
});
