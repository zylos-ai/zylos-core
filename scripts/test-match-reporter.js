import path from 'node:path';
import { tap } from 'node:test/reporters';

export default async function* report(source) {
  let matches = 0;
  async function* observed() {
    for await (const event of source) {
      if (event.type === 'test:pass' || event.type === 'test:fail') {
        const { file, name, line, column, nesting, skip, details } = event.data;
        // Node can report a successful file placeholder when no names match.
        const placeholder = file && nesting === 0 && line === 1 && column === 1
          && (name === file || name === path.relative(process.cwd(), file));
        // Node 20 reports unmatched tests as skips; explicit fixture gate skips
        // still represent selected cases and must retain their normal result.
        if (!placeholder && details.type !== 'suite' && skip !== 'test name does not match pattern') matches++;
      }
      yield event;
    }
  }
  yield* tap(observed());
  if (matches === 0) {
    process.exitCode = 1;
    yield '# No tests matched --test-name-pattern.\n';
  }
}
