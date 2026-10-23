/** Opt-in missing-dependency fixture. Default tests always import the real P01. */
import { register } from 'node:module';
export function installParserFixture(groups) {
  if (process.env.P02_PARSER_FIXTURE === '1') {
    if (process.env.P02_REQUIRE_REAL_P01 === '1') throw new Error('Parser fixture forbidden in real P01 validation');
    register('./p02-parser-fixture-loader.js', import.meta.url, { data: { groups } });
  }
}
