/**
 * Stellar / Soroban network defaults for local dev and tests.
 * Override with SOROBAN_RPC_URL and SOROBAN_NETWORK_PASSPHRASE.
 */
export const sorobanEnv = {
  sorobanRpcUrl: process.env.SOROBAN_RPC_URL ?? 'https://rpc-futurenet.stellar.org:443',
  sorobanNetworkPassphrase: process.env.SOROBAN_NETWORK_PASSPHRASE ?? 'Test SDF Future Network ; October 2022',
} as const;
