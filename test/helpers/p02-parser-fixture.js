/** Opt-in missing-dependency fixture. Default tests always import the real P01. */
import { register } from 'node:module';
export function installParserFixture(groups) {
  if (process.env.P02_PARSER_FIXTURE === '1') {
    register('./p02-parser-fixture-loader.js', import.meta.url, { data: { groups } });
  }
}
