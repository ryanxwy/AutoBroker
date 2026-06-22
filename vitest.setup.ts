// Global unit-test floor: the product is BUYER-by-default (real send), but a unit
// test must NEVER really send to a dealer. Pin test mode for every test file unless
// a specific test explicitly opts into buyer mode (by setting AUTOBROKER_MODE in
// its own body, after this setup has run). This mirrors, at the vitest layer, the
// boot-time forceTestMode() floor for in-process server boots.
process.env.AUTOBROKER_MODE = "test";
