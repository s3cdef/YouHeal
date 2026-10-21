// In-memory token buckets keyed by client IP (AC-7 / SC-5). Single-process on-prem deployment;
// a shared store (Redis/pg) replaces this for multi-instance SaaS.

export class TokenBucket {
  constructor({ capacity, refillPerMin, maxKeys = 50_000, now = () => Date.now() }) {
    this.capacity = capacity;
    this.ratePerMs = refillPerMin / 60_000;
    this.maxKeys = maxKeys;
    this.now = now;
    this.buckets = new Map();
  }

  /** Consume `cost` tokens. Returns { ok, retryAfter (seconds) }. */
  take(key, cost = 1) {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.prune(true);
      b = { tokens: this.capacity, ts: t };
      this.buckets.set(key, b);
    } else {
      b.tokens = Math.min(this.capacity, b.tokens + (t - b.ts) * this.ratePerMs);
      b.ts = t;
    }
    if (b.tokens >= cost) { b.tokens -= cost; return { ok: true, retryAfter: 0 }; }
    return { ok: false, retryAfter: Math.max(1, Math.ceil((cost - b.tokens) / this.ratePerMs / 1000)) };
  }

  prune(force = false) {
    const t = this.now();
    for (const [k, b] of this.buckets) {
      if (b.tokens + (t - b.ts) * this.ratePerMs >= this.capacity) this.buckets.delete(k);
    }
    if (force && this.buckets.size >= this.maxKeys) this.buckets.clear();
  }
}
