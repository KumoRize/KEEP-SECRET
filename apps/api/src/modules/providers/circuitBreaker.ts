interface State {
  failures: number;
  openedAt: number | null;
}

/** Per-process breaker: after `threshold` consecutive failures a provider is skipped for `cooldownMs`. */
export class CircuitBreaker {
  private states = new Map<string, State>();

  constructor(
    private readonly threshold = 5,
    private readonly cooldownMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  isOpen(providerId: string): boolean {
    const s = this.states.get(providerId);
    if (s?.openedAt == null) return false;
    if (this.now() - s.openedAt >= this.cooldownMs) {
      // Half-open: allow traffic; one more failure re-opens immediately.
      s.openedAt = null;
      s.failures = this.threshold - 1;
      return false;
    }
    return true;
  }

  recordSuccess(providerId: string): void {
    this.states.set(providerId, { failures: 0, openedAt: null });
  }

  recordFailure(providerId: string, immediate = false): void {
    const s = this.states.get(providerId) ?? { failures: 0, openedAt: null };
    s.failures = immediate ? this.threshold : s.failures + 1;
    if (s.failures >= this.threshold) s.openedAt = this.now();
    this.states.set(providerId, s);
  }

  snapshot(): Record<string, { failures: number; open: boolean }> {
    return Object.fromEntries([...this.states].map(([id, s]) => [id, { failures: s.failures, open: this.isOpen(id) }]));
  }
}

export const breaker = new CircuitBreaker();
