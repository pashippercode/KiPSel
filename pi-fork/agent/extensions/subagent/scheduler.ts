import { resolve } from "node:path";

export function normalizeScopes(scopes: readonly string[] | undefined): string[] {
  if (!scopes) return [];
  return Array.from(
    new Set(
      scopes
        .map((scope) => scope.trim())
        .filter(Boolean)
        .map((scope) => resolve(scope).replace(/\/+$/, "") || "/"),
    ),
  );
}

export function scopesOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.some((a) => right.some((b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)));
}

interface ActiveTask {
  index: number;
  scopes: string[];
  promise: Promise<void>;
}

/**
 * Run tasks concurrently only when their declared mutation scopes do not overlap.
 * Empty scopes are intentionally conflict-free; callers should use them only for
 * explicitly read-only work.
 */
export async function mapWithScopedConcurrency<TIn, TOut>(
  items: readonly TIn[],
  concurrency: number,
  getScopes: (item: TIn, index: number) => readonly string[] | undefined,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const pending = items.map((_item, index) => index);
  const results: TOut[] = new Array(items.length);
  const active: ActiveTask[] = [];

  while (pending.length > 0 || active.length > 0) {
    while (active.length < limit && pending.length > 0) {
      const pendingPosition = pending.findIndex((index) => {
        const scopes = normalizeScopes(getScopes(items[index], index));
        return !active.some((task) => scopesOverlap(scopes, task.scopes));
      });
      if (pendingPosition < 0) break;

      const [index] = pending.splice(pendingPosition, 1);
      const scopes = normalizeScopes(getScopes(items[index], index));
      const task: ActiveTask = { index, scopes, promise: Promise.resolve() };
      task.promise = fn(items[index], index)
        .then((value) => {
          results[index] = value;
        })
        .finally(() => {
          const position = active.indexOf(task);
          if (position >= 0) active.splice(position, 1);
        });
      active.push(task);
    }

    if (active.length === 0) continue;
    const running = active.map((task) => task.promise);
    try {
      await Promise.race(running);
    } catch (error) {
      await Promise.allSettled(running);
      throw error;
    }
  }

  return results;
}
