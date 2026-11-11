/**
 * @module compare-values
 * @internal Not re-exported from the package entry point.
 *
 * Null-safe comparison shared by the client-side sorters.
 */

/**
 * Compares two sort keys:
 * - `null` / `undefined` sort first;
 * - values that are neither smaller nor larger (equal numbers, strings,
 *   or two `Date` objects with the same time) compare as `0`, so the next
 *   ordering (`thenBy`) decides.
 */
export function compareValues(left: unknown, right: unknown): number {
    const leftMissing = left === undefined || left === null;
    const rightMissing = right === undefined || right === null;

    if (leftMissing || rightMissing) {
        return leftMissing === rightMissing ? 0 : leftMissing ? -1 : 1;
    }

    if ((left as any) < (right as any)) return -1;
    if ((left as any) > (right as any)) return 1;
    return 0;
}
