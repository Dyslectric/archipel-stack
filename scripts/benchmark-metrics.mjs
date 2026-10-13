// Fixed logarithmic buckets can be merged across generators without sampling bias.
export function histogram() { return { count: 0, sum: 0, max: 0, buckets: {} }; }
export function observe(h, ms) {
  const value = Math.max(0, ms);
  const bucket = Math.ceil(Math.log1p(value) / Math.log(1.05));
  h.count++; h.sum += value; h.max = Math.max(h.max, value);
  h.buckets[bucket] = (h.buckets[bucket] || 0) + 1;
}
export function mergeHistogram(a, b) {
  a.count += b.count; a.sum += b.sum; a.max = Math.max(a.max, b.max);
  for (const [key, n] of Object.entries(b.buckets)) a.buckets[key] = (a.buckets[key] || 0) + n;
  return a;
}
export function summarize(h) {
  const percentile = p => {
    if (!h.count) return null;
    let n = 0;
    for (const key of Object.keys(h.buckets).map(Number).sort((a, b) => a - b)) {
      n += h.buckets[key];
      if (n >= Math.ceil(h.count * p)) return Math.min(h.max, Math.expm1(key * Math.log(1.05)));
    }
    return h.max;
  };
  return { count: h.count, meanMs: h.count ? h.sum / h.count : null,
    p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99), maxMs: h.max };
}
