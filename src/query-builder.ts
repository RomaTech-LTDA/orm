/**
 * @module query-builder
 * @description Implements the fluent, LINQ-style {@link QueryBuilder} that lets consumers
 * build type-safe database queries without writing SQL.
 *
 * Queries are lazily composed: calling methods like `where()`, `orderBy()`, or
 * `take()` only mutates internal state.  The actual database round-trip happens
 * when a terminal method (`toList()`, `first()`, `any()`, `count()`, …) is
 * awaited.
 *
 * Each method is exposed in two naming conventions:
 * - **camelCase** (`where`, `orderBy`, `toList`) — idiomatic TypeScript style.
 * - **PascalCase** (`Where`, `OrderBy`, `ToList`) — mirrors EF Core naming.
 */

import { IDbProvider } from './provider';
import {
    getSelectorField,
    parsePredicate,
    parseSelector,
    QueryExpression,
    QueryObject,
    QueryOrderDirection,
    QueryOrdering,
    QueryPredicate,
    QueryProjectionExpression,
    QuerySelector
} from './query-expression';

/**
 * A navigation property accessor used by `include()` to express eager-loading
 * paths. Accepts any arrow function that returns the navigation property.
 *
 * @template T - Entity type.
 */
type IncludePath<T> = (x: T) => any;

/**
 * Minimal interface so QueryBuilder can trigger the auto-connect mechanism
 * without pulling in the full {@link DbContext} class (avoids circular imports).
 */
interface IDbContext {
    /** Ensures the database connection is open. */
    ensureConnected(): Promise<void>;
}

// Re-export query expression types for convenience
export {
    QueryExpression,
    QueryObject,
    QueryOrderDirection,
    QueryPredicate,
    QueryProjectionExpression,
    QuerySelector
};

/**
 * A fluent, immutable-style query builder inspired by LINQ / EF Core.
 *
 * Each mutating method returns the **same** builder instance (`this`) for
 * chaining.  Terminal methods (`toList`, `first`, `count`, …) execute the query
 * against the provider and return a `Promise`.
 *
 * @template T       - Source entity type (the table rows).
 * @template TResult - Output type after projection (defaults to `T`).
 *
 * @example Basic usage
 * ```ts
 * const adults = await db.users
 *   .where(u => u.age >= 18)
 *   .orderBy(u => u.name)
 *   .skip(0)
 *   .take(10)
 *   .toList();
 * ```
 *
 * @example Projection
 * ```ts
 * const names = await db.users
 *   .where(u => u.isActive)
 *   .select(u => u.name)
 *   .toList(); // string[]
 * ```
 */
export class QueryBuilder<T, TResult = T> {
    /** Navigation properties to eager-load. */
    private includes: string[] = [];

    /** Raw predicate functions (always kept for client-side fallback). */
    private predicates: QueryPredicate<T>[] = [];

    /** Parsed expression trees derived from predicates (for server-side SQL). */
    private whereExpressions: QueryExpression[] = [];

    /** Original ordering descriptors (selectors + directions). */
    private orderings: QueryOrdering<T>[] = [];

    /** Parsed field + direction pairs for server-side ORDER BY. */
    private orderByExpressions: QueryObject<T>['orderByExpressions'] = [];

    /** Projection selector (set via `select()`). */
    private selector?: QuerySelector<T, TResult>;

    /** Parsed projection descriptor for server-side SELECT column lists. */
    private projection?: QueryProjectionExpression;

    /** Number of rows to skip. */
    private _skip?: number;

    /** Maximum number of rows to return. */
    private _take?: number;

    /**
     * Creates a new QueryBuilder bound to a specific entity type and provider.
     *
     * Most consumers should not instantiate this class directly — use
     * {@link DbSet.query} or the chainable methods on DbSet instead.
     *
     * @param entityType - Constructor of the entity class.
     * @param provider   - The database provider that will execute the query.
     * @param tableName  - Override for the table name (defaults to `entityType.name`).
     * @param context    - Optional context reference for auto-connect support.
     */
    constructor(
        private entityType: new (...args: any[]) => T,
        private provider: IDbProvider,
        private tableName: string = entityType.name,
        private context?: IDbContext
    ) {}

    // -------------------------------------------------------------------------
    // Eager-loading (Include / ThenInclude)
    // -------------------------------------------------------------------------

    /**
     * Specifies a navigation property to eager-load when the query executes.
     *
     * @param path - Arrow function selecting the navigation property on `T`.
     * @returns This builder for fluent chaining.
     *
     * @example
     * ```ts
     * const orders = await db.orders
     *   .include(o => o.customer)
     *   .toList();
     * ```
     */
    include(path: IncludePath<T>): QueryBuilder<T, TResult> {
        const prop = this.getPropName(path);
        this.includes.push(prop);
        return this;
    }

    /** @see {@link include} — PascalCase alias. */
    Include(path: IncludePath<T>): QueryBuilder<T, TResult> {
        return this.include(path);
    }

    /**
     * Extends the most recent `include()` with a nested navigation path.
     *
     * Must be called immediately after `include()` or another `thenInclude()`.
     *
     * @param path - Arrow function selecting the nested navigation property.
     * @returns This builder for fluent chaining.
     * @throws {Error} If called without a preceding `include()`.
     *
     * @example
     * ```ts
     * const orders = await db.orders
     *   .include(o => o.customer)
     *   .thenInclude(c => c.address)
     *   .toList();
     * ```
     */
    thenInclude<K>(path: IncludePath<K>): QueryBuilder<T, TResult> {
        if (this.includes.length === 0) {
            throw new Error('thenInclude must be called after include or another thenInclude');
        }
        // Append the nested property to the last include path using dot-notation
        const last = this.includes.pop()!;
        const sub = this.getPropName(path);
        this.includes.push(`${last}.${sub}`);
        return this;
    }

    /** @see {@link thenInclude} — PascalCase alias. */
    ThenInclude<K>(path: IncludePath<K>): QueryBuilder<T, TResult> {
        return this.thenInclude(path);
    }

    // -------------------------------------------------------------------------
    // Filtering
    // -------------------------------------------------------------------------

    /**
     * Adds a filter predicate. Multiple `where()` calls are combined with `AND`.
     *
     * The predicate is also parsed to a portable {@link QueryExpression} for
     * server-side evaluation.  If parsing fails (e.g. the predicate references
     * outer-scope variables), the entire WHERE is evaluated client-side after
     * fetching all rows.
     *
     * @param predicate - Arrow function that returns `true` for matching rows.
     * @returns This builder for fluent chaining.
     *
     * @example
     * ```ts
     * db.users
     *   .where(u => u.age >= 18)
     *   .where(u => u.isActive)
     *   .toList(); // both predicates must match
     * ```
     */
    where(predicate: QueryPredicate<T>): QueryBuilder<T, TResult> {
        this.predicates.push(predicate);
        const expression = parsePredicate(predicate);
        if (expression) {
            this.whereExpressions.push(expression);
        }
        return this;
    }

    /** @see {@link where} — PascalCase alias. */
    Where(predicate: QueryPredicate<T>): QueryBuilder<T, TResult> {
        return this.where(predicate);
    }

    // -------------------------------------------------------------------------
    // Projection
    // -------------------------------------------------------------------------

    /**
     * Projects each row to a different shape.
     *
     * Changes the builder's output type to `TNext`.  Only one projection can be
     * active; calling `select()` a second time replaces the previous one.
     *
     * @param selector - Arrow function mapping `T` to `TNext`.
     * @returns A re-typed builder that produces `TNext[]`.
     *
     * @example
     * ```ts
     * const emails = await db.users
     *   .select(u => u.email)
     *   .toList(); // string[]
     * ```
     */
    select<TNext>(selector: QuerySelector<T, TNext>): QueryBuilder<T, TNext> {
        const builder = this as unknown as QueryBuilder<T, TNext>;
        builder.selector = selector;
        builder.projection = parseSelector(selector);
        return builder;
    }

    /** @see {@link select} — PascalCase alias. */
    Select<TNext>(selector: QuerySelector<T, TNext>): QueryBuilder<T, TNext> {
        return this.select(selector);
    }

    // -------------------------------------------------------------------------
    // Ordering
    // -------------------------------------------------------------------------

    /**
     * Sorts results by the selected key in **ascending** order.
     *
     * @param selector - Arrow function selecting the sort key.
     * @returns This builder for fluent chaining.
     *
     * @example
     * ```ts
     * db.users.orderBy(u => u.name).toList();
     * ```
     */
    orderBy<K>(selector: QuerySelector<T, K>): QueryBuilder<T, TResult> {
        return this.addOrdering(selector, 'asc');
    }

    /** @see {@link orderBy} — PascalCase alias. */
    OrderBy<K>(selector: QuerySelector<T, K>): QueryBuilder<T, TResult> {
        return this.orderBy(selector);
    }

    /**
     * Sorts results by the selected key in **descending** order.
     *
     * @param selector - Arrow function selecting the sort key.
     * @returns This builder for fluent chaining.
     *
     * @example
     * ```ts
     * db.users.orderByDescending(u => u.createdAt).toList();
     * ```
     */
    orderByDescending<K>(selector: QuerySelector<T, K>): QueryBuilder<T, TResult> {
        return this.addOrdering(selector, 'desc');
    }

    /** @see {@link orderByDescending} — PascalCase alias. */
    OrderByDescending<K>(selector: QuerySelector<T, K>): QueryBuilder<T, TResult> {
        return this.orderByDescending(selector);
    }

    /**
     * Adds a secondary ascending sort after the primary `orderBy()`.
     *
     * @param selector - Arrow function selecting the secondary sort key.
     * @returns This builder for fluent chaining.
     *
     * @example
     * ```ts
     * db.users.orderBy(u => u.lastName).thenBy(u => u.firstName).toList();
     * ```
     */
    thenBy<K>(selector: QuerySelector<T, K>): QueryBuilder<T, TResult> {
        return this.addOrdering(selector, 'asc');
    }

    /** @see {@link thenBy} — PascalCase alias. */
    ThenBy<K>(selector: QuerySelector<T, K>): QueryBuilder<T, TResult> {
        return this.thenBy(selector);
    }

    /**
     * Adds a secondary descending sort after the primary `orderBy()`.
     *
     * @param selector - Arrow function selecting the secondary sort key.
     * @returns This builder for fluent chaining.
     */
    thenByDescending<K>(selector: QuerySelector<T, K>): QueryBuilder<T, TResult> {
        return this.addOrdering(selector, 'desc');
    }

    /** @see {@link thenByDescending} — PascalCase alias. */
    ThenByDescending<K>(selector: QuerySelector<T, K>): QueryBuilder<T, TResult> {
        return this.thenByDescending(selector);
    }

    // -------------------------------------------------------------------------
    // Paging
    // -------------------------------------------------------------------------

    /**
     * Skips the first `count` rows (equivalent to SQL `OFFSET`).
     *
     * @param count - Number of rows to skip.
     * @returns This builder for fluent chaining.
     *
     * @example
     * ```ts
     * // Page 3, 20 rows per page
     * db.users.skip(40).take(20).toList();
     * ```
     */
    skip(count: number): QueryBuilder<T, TResult> {
        this._skip = count;
        return this;
    }

    /** @see {@link skip} — PascalCase alias. */
    Skip(count: number): QueryBuilder<T, TResult> {
        return this.skip(count);
    }

    /**
     * Limits the result set to at most `count` rows (equivalent to SQL `LIMIT`
     * / `TOP` / `FETCH NEXT`).
     *
     * @param count - Maximum number of rows to return.
     * @returns This builder for fluent chaining.
     *
     * @example
     * ```ts
     * db.users.take(5).toList(); // at most 5 users
     * ```
     */
    take(count: number): QueryBuilder<T, TResult> {
        this._take = count;
        return this;
    }

    /** @see {@link take} — PascalCase alias. */
    Take(count: number): QueryBuilder<T, TResult> {
        return this.take(count);
    }

    // -------------------------------------------------------------------------
    // Terminal methods (execute the query)
    // -------------------------------------------------------------------------

    /**
     * Executes the query and returns all matching rows as an array.
     *
     * This is the primary terminal method.  It triggers auto-connect (if
     * enabled) and delegates execution to the configured provider.
     *
     * @returns A Promise resolving to the projected result array.
     *
     * @example
     * ```ts
     * const users = await db.users.where(u => u.isActive).toList();
     * ```
     */
    async toList(): Promise<TResult[]> {
        await this.context?.ensureConnected();
        return this.provider.executeQuery<T, TResult>(this.tableName, this.toQueryObject());
    }

    /** @see {@link toList} — PascalCase alias. */
    ToList(): Promise<TResult[]> {
        return this.toList();
    }

    /**
     * Alias for {@link toList}. Returns results as an array.
     *
     * @returns A Promise resolving to the result array.
     */
    async toArray(): Promise<TResult[]> {
        return this.toList();
    }

    /** @see {@link toArray} — PascalCase alias. */
    ToArray(): Promise<TResult[]> {
        return this.toArray();
    }

    /**
     * Returns the first matching row, or throws if the sequence is empty.
     *
     * An optional predicate can be passed to combine a `where()` + `first()` in
     * a single call.
     *
     * @param predicate - Optional filter predicate.
     * @returns The first matching row.
     * @throws {Error} "Sequence contains no elements." when no row matches.
     *
     * @example
     * ```ts
     * const admin = await db.users.first(u => u.role === 'admin');
     * ```
     */
    async first(predicate?: QueryPredicate<T>): Promise<TResult> {
        const result = await this.firstOrDefault(predicate);
        if (result === undefined) {
            throw new Error('Sequence contains no elements.');
        }
        return result;
    }

    /** @see {@link first} — PascalCase alias. */
    First(predicate?: QueryPredicate<T>): Promise<TResult> {
        return this.first(predicate);
    }

    /**
     * Returns the first matching row, or `undefined` when the sequence is empty.
     *
     * @param predicate - Optional filter predicate.
     * @returns The first matching row, or `undefined`.
     *
     * @example
     * ```ts
     * const user = await db.users.firstOrDefault(u => u.email === 'a@b.com');
     * if (user) { ... }
     * ```
     */
    async firstOrDefault(predicate?: QueryPredicate<T>): Promise<TResult | undefined> {
        const query = predicate ? this.clone().where(predicate) : this.clone();
        const list = await query.take(1).toList();
        return list[0];
    }

    /** @see {@link firstOrDefault} — PascalCase alias. */
    FirstOrDefault(predicate?: QueryPredicate<T>): Promise<TResult | undefined> {
        return this.firstOrDefault(predicate);
    }

    /**
     * Returns the only matching element.  Throws if zero or more than one
     * element matches.
     *
     * @param predicate - Optional filter predicate.
     * @returns The single matching element.
     * @throws {Error} "Sequence contains no elements." — zero matches.
     * @throws {Error} "Sequence contains more than one element." — multiple matches.
     *
     * @example
     * ```ts
     * const user = await db.users.single(u => u.email === 'unique@x.com');
     * ```
     */
    async single(predicate?: QueryPredicate<T>): Promise<TResult> {
        const query = predicate ? this.clone().where(predicate) : this.clone();
        // Fetch at most 2 to detect duplicates
        const list = await query.take(2).toList();

        if (list.length !== 1) {
            throw new Error(list.length === 0 ? 'Sequence contains no elements.' : 'Sequence contains more than one element.');
        }

        return list[0];
    }

    /** @see {@link single} — PascalCase alias. */
    Single(predicate?: QueryPredicate<T>): Promise<TResult> {
        return this.single(predicate);
    }

    /**
     * Returns the only matching element, or `undefined` when no rows match.
     * Throws if more than one element matches.
     *
     * @param predicate - Optional filter predicate.
     * @returns The single matching element, or `undefined`.
     * @throws {Error} "Sequence contains more than one element." — multiple matches.
     *
     * @example
     * ```ts
     * const user = await db.users.singleOrDefault(u => u.id === 42);
     * ```
     */
    async singleOrDefault(predicate?: QueryPredicate<T>): Promise<TResult | undefined> {
        const query = predicate ? this.clone().where(predicate) : this.clone();
        const list = await query.take(2).toList();

        if (list.length > 1) {
            throw new Error('Sequence contains more than one element.');
        }

        return list[0];
    }

    /** @see {@link singleOrDefault} — PascalCase alias. */
    SingleOrDefault(predicate?: QueryPredicate<T>): Promise<TResult | undefined> {
        return this.singleOrDefault(predicate);
    }

    /**
     * Returns `true` if at least one element matches the optional predicate.
     *
     * @param predicate - Optional filter predicate.
     * @returns `true` if at least one row exists.
     *
     * @example
     * ```ts
     * const hasAdmins = await db.users.any(u => u.role === 'admin');
     * ```
     */
    async any(predicate?: QueryPredicate<T>): Promise<boolean> {
        return (await this.cloneForPredicate(predicate).take(1).toList()).length > 0;
    }

    /** @see {@link any} — PascalCase alias. */
    Any(predicate?: QueryPredicate<T>): Promise<boolean> {
        return this.any(predicate);
    }

    /**
     * Returns `true` only if **every** element satisfies the predicate.
     *
     * Note: this loads all rows into memory. For large datasets consider a
     * server-side alternative.
     *
     * @param predicate - Predicate that every row must satisfy.
     * @returns `true` when all rows pass, `false` otherwise.
     *
     * @example
     * ```ts
     * const allActive = await db.users.all(u => u.isActive);
     * ```
     */
    async all(predicate: QueryPredicate<T>): Promise<boolean> {
        const list = await this.toList();
        return (list as unknown as T[]).every(predicate);
    }

    /** @see {@link all} — PascalCase alias. */
    All(predicate: QueryPredicate<T>): Promise<boolean> {
        return this.all(predicate);
    }

    /**
     * Counts the rows matching the optional predicate.
     *
     * Note: this fetches all matching rows and counts them in memory.
     *
     * @param predicate - Optional filter predicate.
     * @returns The number of matching rows.
     *
     * @example
     * ```ts
     * const total = await db.users.count();
     * const admins = await db.users.count(u => u.role === 'admin');
     * ```
     */
    async count(predicate?: QueryPredicate<T>): Promise<number> {
        return (await this.cloneForPredicate(predicate).toList()).length;
    }

    /** @see {@link count} — PascalCase alias. */
    Count(predicate?: QueryPredicate<T>): Promise<number> {
        return this.count(predicate);
    }

    // -------------------------------------------------------------------------
    // Serialisation
    // -------------------------------------------------------------------------

    /**
     * Serialises the builder state into a plain {@link QueryObject} that can be
     * passed directly to a provider's `executeQuery` method.
     *
     * This is used internally by {@link toList} and is exposed for providers
     * that need to inspect the query descriptor.
     *
     * @returns A snapshot of the current query state.
     */
    toQueryObject(): QueryObject<T, TResult> {
        return {
            includes: [...this.includes],
            predicates: [...this.predicates],
            whereExpressions: [...this.whereExpressions],
            orderings: [...this.orderings],
            orderByExpressions: [...this.orderByExpressions],
            selector: this.selector,
            projection: this.projection,
            skip: this._skip,
            take: this._take,
            // Legacy backward-compat fields
            where: this.predicates[0],
            orderBy: this.createComparer()
        };
    }

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    /**
     * Registers a new ordering entry (both the raw selector and the parsed
     * field + direction pair for server-side SQL generation).
     */
    private addOrdering<K>(selector: QuerySelector<T, K>, direction: QueryOrderDirection): QueryBuilder<T, TResult> {
        this.orderings.push({ selector, direction });
        const field = getSelectorField(selector);
        if (field) {
            this.orderByExpressions.push({ field, direction });
        }
        return this;
    }

    /**
     * Creates a clone with an optional predicate already applied.
     * Used by aggregate methods that accept an inline predicate argument.
     */
    private cloneForPredicate(predicate?: QueryPredicate<T>): QueryBuilder<T, TResult> {
        const query = this.clone();
        return predicate ? query.where(predicate) : query;
    }

    /**
     * Creates a shallow copy of this builder with independent arrays so that
     * subsequent mutations on the clone do not affect the original.
     */
    private clone(): QueryBuilder<T, TResult> {
        const builder = new QueryBuilder<T, TResult>(this.entityType, this.provider, this.tableName, this.context);
        builder.includes = [...this.includes];
        builder.predicates = [...this.predicates];
        builder.whereExpressions = [...this.whereExpressions];
        builder.orderings = [...this.orderings];
        builder.orderByExpressions = [...this.orderByExpressions];
        builder.selector = this.selector;
        builder.projection = this.projection;
        builder._skip = this._skip;
        builder._take = this._take;
        return builder;
    }

    /**
     * Builds a composite comparer function from all registered orderings.
     * Returned as a pre-built function in the {@link QueryObject} so providers
     * can skip building their own comparator for client-side sorting.
     */
    private createComparer(): ((a: T, b: T) => number) | undefined {
        if (!this.orderings.length) {
            return undefined;
        }

        return (a, b) => {
            for (const ordering of this.orderings) {
                const left = ordering.selector(a);
                const right = ordering.selector(b);

                if (left === right) {
                    continue;
                }

                const comparison = left < right ? -1 : 1;
                return ordering.direction === 'desc' ? -comparison : comparison;
            }

            return 0;
        };
    }

    /**
     * Extracts the property name from an arrow function used in `include()` /
     * `thenInclude()` by matching the common `x => x.prop` pattern in the
     * function's source text.
     *
     * @throws {Error} When the pattern cannot be matched.
     */
    private getPropName(path: Function): string {
        const fnStr = path.toString();
        const match = fnStr.match(/return\s+.*\.([a-zA-Z0-9_]+);?|\.\s*([a-zA-Z0-9_]+)/);
        if (match) {
            return match[1] || match[2];
        }
        throw new Error('Include path invalid');
    }
}
