// The instance time zone these tests set: one whose offset is a quarter past the hour, so its midnight and clock
// differ from every zone the tests are normally run under, and an expectation in the instance zone fails if the page
// falls back to the browser or process zone. Chatham (UTC+12:45/+13:45) by default; should the process itself run
// in Chatham, Eucla (UTC+8:45) keeps the two apart.
const processZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
export const INSTANCE_TEST_ZONE = processZone === 'Pacific/Chatham' ? 'Australia/Eucla' : 'Pacific/Chatham';
