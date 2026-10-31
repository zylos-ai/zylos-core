import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { SENSITIVE_KEY, isCredentialValue } from './keyname.js';
export class KnownValues {
  constructor(zylosDir) {
    this.dir = zylosDir;
    this.signature = '';
    this.values = [];
    this.revision = 0;
  }
  async refresh() {
    if (!this.dir) return this.values;
    const files = [path.join(this.dir, '.env')];
    try {
      for (const name of await readdir(path.join(this.dir, 'components')))
        files.push(path.join(this.dir, 'components', name, 'config.json'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const present = [];
    for (const file of files) {
      try {
        const s = await stat(file);
        if (s.isFile()) present.push([file, s.mtimeMs, s.ctimeMs, s.size]);
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      }
    }
    const signature = JSON.stringify(present);
    if (signature === this.signature) return this.values;
    const values = [];
    const add = (value, label) => {
      if (typeof value === 'string' && value.length >= 8 && isCredentialValue(value))
        values.push({
          value,
          label: label.replace(/read_api_key|read_session_token|zylos_(?:st|ak)_/gi, 'credential'),
        });
    };
    for (const [file] of present) {
      const raw = await readFile(file, 'utf8');
      if (file.endsWith('.env')) {
        for (const line of raw.split(/\r?\n/)) {
          const m = /^\s*(?:export\s+)?([\w]+)\s*=\s*(.*)$/.exec(line);
          if (!m || !SENSITIVE_KEY.test(m[1])) continue;
          let v = m[2].trim();
          if (/^['"]/.test(v)) v = v.slice(1, v.lastIndexOf(v[0]));
          else v = v.replace(/\s+#.*$/, '');
          add(v, `.env:${m[1]}`);
        }
      } else {
        const walk = (v, keys = []) => {
          if (v && typeof v === 'object')
            for (const [k, item] of Object.entries(v)) {
              if (typeof item === 'string' && SENSITIVE_KEY.test(k))
                add(item, `${path.basename(path.dirname(file))}:${k}`);
              else walk(item, [...keys, k]);
            }
        };
        walk(JSON.parse(raw));
      }
    }
    this.signature = signature;
    this.values = values;
    this.revision++;
    return values;
  }
}
