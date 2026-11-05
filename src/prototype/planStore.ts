import { randomUUID } from 'crypto';

/**
 * Write plans awaiting approval. `take` hands a plan out exactly once, so a double click on
 * Apply cannot write the same change twice. Plans live in memory only and are dropped when the
 * prototype stops.
 */
export class PlanStore<T> {
  private readonly plans = new Map<string, T>();

  add(plan: T): string {
    const id = randomUUID();
    this.plans.set(id, plan);
    return id;
  }

  take(id: string): T | undefined {
    const plan = this.plans.get(id);
    this.plans.delete(id);
    return plan;
  }

  clear(): void {
    this.plans.clear();
  }
}
