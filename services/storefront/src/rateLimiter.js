// Token-bucket rate limiter + FIFO queue.
//
// This is the heart of the "how do you stay under 25 req/s across many
// registers?" answer. Instead of letting bursty checkout traffic slam the
// InventorySoft API and trip HTTP 429s, the storefront funnels every upstream
// call through this limiter. Requests beyond the sustained rate are *queued*
// (smoothed) rather than dropped. In production this role is played by SQS +
// a throttled consumer; here it is an in-process analog.

class RateLimiter {
  constructor({ ratePerSec = 20, burst = 20 } = {}) {
    this.ratePerSec = ratePerSec;
    this.capacity = burst;
    this.tokens = burst;
    this.queue = [];
    this.maxQueueDepth = 0;
    this.totalProcessed = 0;

    const refillMs = 100;
    setInterval(() => {
      this.tokens = Math.min(this.capacity, this.tokens + (this.ratePerSec * refillMs) / 1000);
      this._drain();
    }, refillMs);
  }

  // Returns a promise that resolves when a token is available, then runs fn.
  schedule(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.maxQueueDepth = Math.max(this.maxQueueDepth, this.queue.length);
      this._drain();
    });
  }

  _drain() {
    while (this.queue.length > 0 && this.tokens >= 1) {
      this.tokens -= 1;
      const { fn, resolve, reject } = this.queue.shift();
      this.totalProcessed++;
      Promise.resolve()
        .then(fn)
        .then(resolve)
        .catch(reject);
    }
  }

  stats() {
    return {
      ratePerSec: this.ratePerSec,
      queueDepth: this.queue.length,
      maxQueueDepth: this.maxQueueDepth,
      totalProcessed: this.totalProcessed,
      availableTokens: Math.floor(this.tokens),
    };
  }
}

module.exports = { RateLimiter };
