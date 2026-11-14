function resolveIdleTimeout(env = process.env) {
    const raw = env.RELAY_IDLE_MS;
    if (raw === undefined || raw === '') return 120000;

    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
        throw new RangeError('RELAY_IDLE_MS must be a non-negative number');
    }
    return value;
}

module.exports = { resolveIdleTimeout };
