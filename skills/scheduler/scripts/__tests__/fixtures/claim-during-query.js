// Reply-group query stand-in: claims the task as the daemon does, then answers
// with the overall group. The update that started the query is still unwritten.
import fs from 'node:fs';
const { database, taskId, driver } = JSON.parse(fs.readFileSync('claim.json', 'utf8'));
const { default: Database } = await import(driver);
const db = new Database(database);
db.prepare("UPDATE tasks SET status='running' WHERE id=? AND status='pending'").run(taskId);
db.close();
