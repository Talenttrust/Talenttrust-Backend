process.env.LOG_LEVEL = 'silent';
process.env.NODE_ENV = 'test';
// Never call Soroban RPC from tests: the pause guard only honours API_PAUSED here.
process.env.PAUSE_CHECK_CHAIN = 'false';
