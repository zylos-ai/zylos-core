// Reply-group query stand-in: changes the task's status as delivery does (a claim,
// or a finished delivery), then answers with the overall group. The update that
// started the query is still unwritten.
import fs from 'node:fs';
const { database, taskId, driver, status } = JSON.parse(fs.readFileSync('claim.json', 'utf8'));
const { default: Database } = await import(driver);
const db = new Database(database);
db.prepare('UPDATE tasks SET status=? WHERE id=?').run(status, taskId);
db.close();
