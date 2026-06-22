// Global unit-test floor: the product is REAL-SEND-BY-DEFAULT, but a unit test
// must NEVER really send to a dealer. Brake real send for every test file unless
// a specific test explicitly opts into real (by setting AUTOBROKER_REAL_SEND in
// its own body, after this setup has run). This mirrors, at the vitest layer,
// the boot-time forceTestLaneInternal() floor for in-process server boots.
process.env.AUTOBROKER_REAL_SEND = "0";
