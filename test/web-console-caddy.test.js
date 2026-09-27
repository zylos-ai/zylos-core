import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { validateAndDeploy } from '../cli/lib/caddy.js';
import {
  analyzeWebConsoleRoute,
  ensureWebConsolePrefix,
  generateWebConsoleBlock,
  migrateStockBlock,
} from '../cli/lib/web-console-caddy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REAL_CADDY = path.join(os.homedir(), 'zylos', 'bin', 'caddy');
const hasCaddy = fs.existsSync(REAL_CADDY);

// Caddyfile as written by `zylos init` up to v0.8.1.
function stockCaddyfile({ consoleBlock } = {}) {
  const block = consoleBlock ?? `    # Web Console (core built-in)
    redir /console /console/ permanent
    handle /console/* {
        uri strip_prefix /console
        reverse_proxy localhost:3456
    }`;
  return `# Zylos Caddyfile — managed by zylos-core
# Domain: zylos.example.com
# Protocol: https

zylos.example.com {
    header >X-Robots-Tag "noindex, nofollow"

    root * /home/u/zylos/http/public

    file_server {
        hide .git .env *.db *.json
    }

    handle /health {
        respond "OK" 200
    }

${block}

    # BEGIN zylos-component:dashboard
    redir /dashboard /dashboard/ permanent
    handle /dashboard/* {
        uri strip_prefix /dashboard
        reverse_proxy localhost:3470 {
            header_up X-Forwarded-Prefix /dashboard
        }
    }
    # END zylos-component:dashboard
}
`;
}

function initTemplateLiteral() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'cli', 'commands', 'init.js'), 'utf8');
  const start = src.indexOf('`# Zylos Caddyfile');
  return src.slice(start + 1, src.indexOf('`;', start));
}

describe('analyzeWebConsoleRoute', () => {
  test('stock init block is recognised with its target', () => {
    const analysis = analyzeWebConsoleRoute(stockCaddyfile());
    expect(analysis).toMatchObject({ state: 'stock', target: 'localhost:3456' });
  });

  test('the current init template already forwards the prefix', () => {
    expect(analyzeWebConsoleRoute(initTemplateLiteral()).state).toBe('prefixed');
  });

  test('a hand-fixed route in any formatting counts as prefixed', () => {
    const content = stockCaddyfile({ consoleBlock: `    handle /console/* {
        reverse_proxy   127.0.0.1:4000 {
            header_up  X-Forwarded-Prefix "/console"
            header_up X-Other 1
        }
        uri strip_prefix /console
    }` });
    expect(analyzeWebConsoleRoute(content).state).toBe('prefixed');
  });

  test.each([
    ['missing route', ''],
    ['extra directive', `    handle /console/* {
        uri strip_prefix /console
        encode gzip
        reverse_proxy localhost:3456
    }`],
    ['duplicated route', `    handle /console/* {
        uri strip_prefix /console
        reverse_proxy localhost:3456
    }
    handle /console/* {
        uri strip_prefix /console
        reverse_proxy localhost:3456
    }`],
    ['commented-out route only', `    # handle /console/* {
    #     reverse_proxy localhost:3456
    # }`],
  ])('%s is unexpected', (_name, consoleBlock) => {
    expect(analyzeWebConsoleRoute(stockCaddyfile({ consoleBlock })).state).toBe('unexpected');
  });

  test('reports line numbers of the route it found', () => {
    const content = stockCaddyfile({ consoleBlock: `    handle /console/* {
        uri strip_prefix /console
        encode gzip
        reverse_proxy localhost:3456
    }` });
    const line = content.split('\n').findIndex((l) => l.includes('handle /console/*')) + 1;
    expect(analyzeWebConsoleRoute(content).handles).toEqual([{ startLine: line, endLine: line + 4 }]);
  });
});

describe('migrateStockBlock', () => {
  test('produces exactly the block the init template writes and touches nothing else', () => {
    const original = stockCaddyfile();
    const migrated = migrateStockBlock(original);
    expect(migrated).toBe(stockCaddyfile({ consoleBlock: generateWebConsoleBlock() }));
    expect(initTemplateLiteral()).toContain(generateWebConsoleBlock());
    expect(analyzeWebConsoleRoute(migrated).state).toBe('prefixed');
  });

  test('keeps a non-default target and indentation', () => {
    const migrated = migrateStockBlock(`site {
\thandle /console/* {
\t\turi strip_prefix /console
\t\treverse_proxy 127.0.0.1:4456
\t}
}
`);
    expect(migrated).toContain('\t    reverse_proxy 127.0.0.1:4456 {');
    expect(migrated).not.toContain('redir');
  });
});

describe('ensureWebConsolePrefix', () => {
  let dir;
  let caddyfile;
  let caddyBin;
  const config = { domain: 'zylos.example.com' };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-caddy-'));
    caddyfile = path.join(dir, 'Caddyfile');
    caddyBin = path.join(dir, 'caddy');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function run(extra = {}) {
    return ensureWebConsolePrefix({ caddyfile, caddyBin, getZylosConfig: () => config, ...extra });
  }

  test('no domain or no Caddy at all is silently not applicable', () => {
    expect(run({ getZylosConfig: () => ({}) })).toEqual({ status: 'skipped', message: 'Caddy not set up' });
    expect(run()).toEqual({ status: 'skipped', message: 'Caddy not set up' });
  });

  test('missing Caddyfile with Caddy installed tells the agent how to regenerate it', () => {
    fs.writeFileSync(caddyBin, '');
    const result = run();
    expect(result.status).toBe('warning');
    expect(result.message).toContain('zylos init');
  });

  test('stock block is migrated through validate/deploy', () => {
    fs.writeFileSync(caddyfile, stockCaddyfile());
    const calls = [];
    const result = run({ validateAndDeploy: (next, original) => { calls.push({ next, original }); fs.writeFileSync(caddyfile, next); return { success: true }; } });
    expect(result.status).toBe('done');
    expect(calls).toHaveLength(1);
    expect(calls[0].original).toBe(stockCaddyfile());
    expect(analyzeWebConsoleRoute(fs.readFileSync(caddyfile, 'utf8')).state).toBe('prefixed');

    // Second upgrade: silent, no deploy.
    expect(run({ validateAndDeploy: () => { throw new Error('must not deploy'); } }))
      .toEqual({ status: 'skipped', message: 'already forwards /console' });
  });

  test('modified block: byte-identical Caddyfile and agent-readable instructions', () => {
    const content = stockCaddyfile({ consoleBlock: `    handle /console/* {
        uri strip_prefix /console
        encode gzip
        reverse_proxy 127.0.0.1:4000
    }` });
    fs.writeFileSync(caddyfile, content);
    const result = run({ validateAndDeploy: () => { throw new Error('must not deploy'); } });
    expect(result.status).toBe('warning');
    expect(fs.readFileSync(caddyfile, 'utf8')).toBe(content);
    expect(result.message).toContain(caddyfile);
    expect(result.message).toMatch(/lines \d+-\d+/);
    expect(result.message).toContain('reverse_proxy 127.0.0.1:4000 {');
    expect(result.message).toContain('header_up X-Forwarded-Prefix /console');
    expect(result.message).toContain('Path=/console');
    expect(result.message).not.toMatch(/opt.?out|manual"|proxyPrefixMigration/i);

    // After the agent adds the header in its own formatting, the next run is silent.
    fs.writeFileSync(caddyfile, content.replace('reverse_proxy 127.0.0.1:4000', 'reverse_proxy 127.0.0.1:4000 {\n\t\t\theader_up X-Forwarded-Prefix /console\n\t\t}'));
    expect(run().status).toBe('skipped');
  });

  test('deploy failure leaves a warning and the original file', () => {
    fs.writeFileSync(caddyfile, stockCaddyfile());
    const result = run({ validateAndDeploy: () => ({ success: false, error: 'Caddy validation failed: boom' }) });
    expect(result.status).toBe('warning');
    expect(result.message).toContain('Caddy validation failed: boom');
    expect(fs.readFileSync(caddyfile, 'utf8')).toBe(stockCaddyfile());
  });

  (hasCaddy ? describe : describe.skip)('with the real caddy binary', () => {
    const noReload = (cmd, opts) => (cmd.startsWith('pm2 ') ? '' : execFileSync('sh', ['-c', cmd], opts));

    test('migrated Caddyfile passes caddy validate', () => {
      const migrated = migrateStockBlock(stockCaddyfile());
      fs.writeFileSync(caddyfile, stockCaddyfile());
      const result = validateAndDeploy(migrated, stockCaddyfile(), { caddyfile, caddyBin: REAL_CADDY, execSync: noReload });
      expect(result).toEqual({ success: true });
      expect(fs.readFileSync(caddyfile, 'utf8')).toBe(migrated);
    });

    test('reload failure rolls the Caddyfile back', () => {
      fs.writeFileSync(caddyfile, stockCaddyfile());
      const failReload = (cmd, opts) => {
        if (cmd === 'pm2 reload caddy' && fs.readFileSync(caddyfile, 'utf8') !== stockCaddyfile()) throw new Error('reload failed');
        return noReload(cmd, opts);
      };
      const result = ensureWebConsolePrefix({
        caddyfile,
        caddyBin: REAL_CADDY,
        getZylosConfig: () => config,
        validateAndDeploy: (next, original) => validateAndDeploy(next, original, { caddyfile, caddyBin: REAL_CADDY, execSync: failReload }),
      });
      expect(result.status).toBe('warning');
      expect(result.message).toContain('rolled back');
      expect(fs.readFileSync(caddyfile, 'utf8')).toBe(stockCaddyfile());
    });

    test('an invalid rewrite is rejected by caddy validate before touching the file', () => {
      fs.writeFileSync(caddyfile, stockCaddyfile());
      const result = validateAndDeploy(`${stockCaddyfile()}\n}}}`, stockCaddyfile(), { caddyfile, caddyBin: REAL_CADDY, execSync: noReload });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Caddy validation failed/);
      expect(fs.readFileSync(caddyfile, 'utf8')).toBe(stockCaddyfile());
    });
  });
});
