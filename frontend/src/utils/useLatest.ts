import { useEffect, useLayoutEffect, useRef } from 'react';

// Use useLayoutEffect on client for sync updates, fallback to useEffect for SSR.
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/**
 * useLatest Hook
 * ==============
 * 
 * A utility hook that ensures a ref always contains the latest value
 * without triggering re-renders or requiring explicit dependencies.
 * 
 * Problem it solves:
 * - Stale closures in async callbacks (timeouts, promises, events)
 * - Manual synchronization via useEffect (error-prone)
 * - Forgetting to add dependencies to useEffect
 * 
 * How it works:
 * - Takes any value as input
 * - Returns a ref that's automatically updated on every render
 * - The ref.current always has the most recent value
 * - No dependencies needed - the ref updates automatically
 * 
 * @template T The type of value to store
 * @param value The value to keep current
 * @returns A ref that always contains the latest value
 * 
 * @example
 * ```tsx
 * const sessionInfoRef = useLatest(sessionInfo);
 * 
 * // Inside any async callback:
 * const role = sessionInfoRef.current.role; // Always up-to-date!
 * ```
 */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  // Update ref on every render without causing re-renders.
  // This ensures ref.current always has the latest value.
  useIsomorphicLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}
