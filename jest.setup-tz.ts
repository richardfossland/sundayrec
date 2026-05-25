/**
 * Pin the test process's timezone to Europe/Oslo BEFORE Node initializes its
 * Intl/Date subsystem. Setting `process.env.TZ` from inside a test file is
 * too late on Node 22+ and on some CI runners — the timezone gets cached at
 * startup. Using Jest's `setupFiles` (NOT `setupFilesAfterEach`) ensures this
 * runs before any test module is loaded.
 *
 * SundayRec's primary market is Norway; DST and midnight-crossing logic in
 * `src/main/scheduler.ts` is designed against Europe/Oslo. Tests that exercise
 * those paths would silently produce green results on a UTC-default CI runner.
 */
process.env.TZ = 'Europe/Oslo'
