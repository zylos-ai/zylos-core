// Preload for a bounded, test-owned CLI child. Date.now starts at C4_TEST_CLOCK_START_MS and
// advances 1 ms per read, so a start 1 ms before a whole second puts the first reading and every
// later one in different whole seconds. Product source is unchanged; only the clock is controlled.
const start = Number(process.env.C4_TEST_CLOCK_START_MS);
if (!Number.isSafeInteger(start) || start < 0) throw new Error('C4_TEST_CLOCK_START_MS must be nonnegative integer milliseconds');
let reads = 0;
Date.now = () => start + reads++;
