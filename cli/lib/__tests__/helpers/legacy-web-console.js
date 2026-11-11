import fs from 'node:fs';
import path from 'node:path';

export function installLegacyWebConsoleSchema(skillsDir) {
  const target=path.join(skillsDir,'web-console');
  fs.mkdirSync(path.join(target,'scripts'),{recursive:true});
  fs.writeFileSync(path.join(target,'package.json'),'{"type":"module"}');
  const fixture=fs.readFileSync(new URL('../fixtures/legacy-web-console-schema.js',import.meta.url),'utf8');
  fs.writeFileSync(path.join(target,'scripts/schema.js'),fixture.replace("'../../../../skills/comm-bridge/scripts/sqlite-schema.js'","'../../comm-bridge/scripts/sqlite-schema.js'"));
  fs.copyFileSync(new URL('../fixtures/legacy-web-console-migrations.js',import.meta.url),path.join(target,'scripts/legacy-web-console-migrations.js'));
}
