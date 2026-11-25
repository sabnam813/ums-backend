const store = new Map();
const stats = {
  hits: 0,
  misses: 0
};
function get(key) {
  const entry = store.get(key);
  if (!entry) {
    stats.misses++;
    return undefined;
  }
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    stats.misses++;
    return undefined;
  }
  stats.hits++;
  return entry.value;
}
function set(key, value, ttlMs = 30000) {
  store.set(key, {
    value,
    expiresAt: Date.now() + ttlMs
  });
}
function flush() {
  const count = store.size;
  store.clear();
  stats.hits = 0;
  stats.misses = 0;
  return count;
}
function getStats() {
  const total = stats.hits + stats.misses;
  return {
    keys: store.size,
    hits: stats.hits,
    misses: stats.misses,
    hitRate: total ? Math.round(stats.hits / total * 1000) / 10 : 0,
    entries: Array.from(store.entries()).map(([key, v]) => ({
      key,
      expiresInMs: Math.max(0, v.expiresAt - Date.now())
    }))
  };
}
async function cached(key, ttlMs, producer) {
  const existing = get(key);
  if (existing !== undefined) return existing;
  const value = await producer();
  set(key, value, ttlMs);
  return value;
}
module.exports = {
  get,
  set,
  flush,
  getStats,
  cached
};
