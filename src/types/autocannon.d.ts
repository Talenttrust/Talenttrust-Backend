declare module 'autocannon' {
  const autocannon: (opts: Record<string, unknown>) => Promise<Record<string, unknown>>;
  export default autocannon;
}
