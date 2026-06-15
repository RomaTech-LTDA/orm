import { IDbProvider } from './provider';
import { QueryBuilder } from './query-builder';
import { QueryPredicate, QuerySelector } from './query-expression';

/** Generic constructor type for entity classes. */
type EntityConstructor<T extends object> = new (...args: any[]) => T;

/** Minimal interface so DbSet can trigger ensureConnected without a circular import. */
interface IDbContext {
    ensureConnected(): Promise<void>;
}

/**
 * Represents a typed collection of entities mapped to a database table.
 *
 * Provides both synchronous local tracking (add/remove/find) and
 * asynchronous querying (where/select/orderBy/toList).
 *
 * Changes are tracked locally and only sent to the database when
 * `DbContext.saveChanges()` is called.
 *
 * @typeParam T - The entity type this set contains.
 *
 * @example
 * ```ts
 * // Querying
 * const adults = await db.users
 *     .Where(u => u.age >= 18)
 *     .OrderBy(u => u.name)
 *     .ToList();
 *
 * // Mutating
 * db.users.add(newUser);
 * db.users.remove(oldUser);
 * await db.saveChanges();
 * ```
 */
export class DbSet<T extends object> {
    /** Locally tracked entities (in-memory working set). */
    private entities: T[] = [];

    /** Queue of provider operations to flush on saveChanges(). */
    private pendingChanges: Array<() => Promise<void>> = [];

    /**
     * @param entityType - Entity constructor (used for type resolution).
     * @param provider - The database provider used for persistence.
     * @param tableName - Database table name for this entity.
     * @param context - Parent DbContext (used to trigger auto-connect).
     * @param initialEntities - Optional initial data to seed the local set.
     */
    constructor(
        private entityType: EntityConstructor<T>,
        private provider?: IDbProvider,
        private tableName: string = entityType.name,
        private context?: IDbContext,
        initialEntities?: T[]
    ) {
        if (initialEntities) {
            this.entities = [...initialEntities];
        }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Synchronous / Unit-of-Work Methods (operate on local tracked collection)
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Marks an entity for insertion. The actual INSERT is deferred
     * until `saveChanges()` is called.
     */
    public add(entity: T): void {
        this.entities.push(entity);
        this.trackChange(provider => provider.add(entity, this.tableName));
    }

    /**
     * Marks multiple entities for insertion.
     */
    public addRange(entities: T[]): void {
        this.entities.push(...entities);
        this.trackChange(provider => provider.addRange(entities, this.tableName));
    }

    /**
     * Marks an entity for update. The actual UPDATE is deferred
     * until `saveChanges()` is called.
     */
    public update(entity: T): void {
        this.trackChange(provider => provider.update(entity, this.tableName));
    }

    /**
     * Marks an entity for deletion. Removes it from the local set immediately.
     */
    public remove(entity: T): void {
        this.entities = this.entities.filter(e => e !== entity);
        this.trackChange(provider => provider.remove(entity, this.tableName));
    }

    /**
     * Marks multiple entities for deletion.
     */
    public removeRange(entities: T[]): void {
        const toRemove = new Set(entities);
        this.entities = this.entities.filter(e => !toRemove.has(e));
        this.trackChange(provider => provider.removeRange(entities, this.tableName));
    }

    /**
     * Finds an entity by reference in the locally tracked set.
     * Does NOT query the database.
     */
    public find(entity: T): T | undefined {
        return this.entities.find(e => e === entity);
    }

    /**
     * Returns a shallow copy of the locally tracked entities.
     * Does NOT query the database — use `toList()` for that.
     */
    public toArray(): T[] {
        return [...this.entities];
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Query Methods (execute against the database via the provider)
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Returns a fresh QueryBuilder for building complex queries.
     */
    query(): QueryBuilder<T> {
        return new QueryBuilder<T>(this.entityType, this.getProvider(), this.tableName, this.context);
    }

    /**
     * Starts a query with an `include` (eager-load navigation property).
     * @param path - Lambda pointing to the navigation property.
     */
    include(path: (x: T) => any): QueryBuilder<T> {
        return this.query().include(path);
    }

    /** PascalCase alias for {@link include}. */
    Include(path: (x: T) => any): QueryBuilder<T> {
        return this.include(path);
    }

    /**
     * Starts a query with a `where` filter.
     * @param predicate - Filter function (parsed into SQL when possible).
     */
    where(predicate: QueryPredicate<T>): QueryBuilder<T> {
        return this.query().where(predicate);
    }

    /** PascalCase alias for {@link where}. */
    Where(predicate: QueryPredicate<T>): QueryBuilder<T> {
        return this.where(predicate);
    }

    /**
     * Starts a query with a projection.
     * @param selector - Mapping function for the result shape.
     */
    select<TResult>(selector: QuerySelector<T, TResult>): QueryBuilder<T, TResult> {
        return this.query().select(selector);
    }

    /** PascalCase alias for {@link select}. */
    Select<TResult>(selector: QuerySelector<T, TResult>): QueryBuilder<T, TResult> {
        return this.select(selector);
    }

    /**
     * Starts a query ordered ascending by the selected field.
     */
    orderBy<TResult>(selector: QuerySelector<T, TResult>): QueryBuilder<T> {
        return this.query().orderBy(selector);
    }

    /** PascalCase alias for {@link orderBy}. */
    OrderBy<TResult>(selector: QuerySelector<T, TResult>): QueryBuilder<T> {
        return this.orderBy(selector);
    }

    /**
     * Starts a query ordered descending by the selected field.
     */
    orderByDescending<TResult>(selector: QuerySelector<T, TResult>): QueryBuilder<T> {
        return this.query().orderByDescending(selector);
    }

    /** PascalCase alias for {@link orderByDescending}. */
    OrderByDescending<TResult>(selector: QuerySelector<T, TResult>): QueryBuilder<T> {
        return this.orderByDescending(selector);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Async Data Retrieval
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Fetches all rows from the database table.
     * If no provider is attached, returns the local tracked set.
     */
    public async toList(): Promise<T[]> {
        if (this.provider) {
            await this.context?.ensureConnected();
            return this.provider.getAll<T>(this.tableName);
        }
        return this.toArray();
    }

    /** PascalCase alias for {@link toList}. */
    public ToList(): Promise<T[]> {
        return this.toList();
    }

    /** Alias for {@link toList}. */
    public ToArray(): Promise<T[]> {
        return this.toList();
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Synchronous Aggregate Helpers (operate on local tracked set)
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Returns whether any locally tracked entity matches the predicate.
     * For async/database version, use the PascalCase `Any()`.
     */
    public any(predicate?: (entity: T) => boolean): boolean {
        return predicate ? this.entities.some(predicate) : this.entities.length > 0;
    }

    /**
     * Returns the count of locally tracked entities matching the predicate.
     * For async/database version, use the PascalCase `Count()`.
     */
    public count(predicate?: (entity: T) => boolean): number {
        return predicate ? this.entities.filter(predicate).length : this.entities.length;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Async Aggregate Helpers (query the database via QueryBuilder)
    // ─────────────────────────────────────────────────────────────────────────────

    /** Checks if any row exists matching the optional predicate (database query). */
    public Any(predicate?: QueryPredicate<T>): Promise<boolean> {
        return this.query().any(predicate);
    }

    /** Returns the count of rows matching the optional predicate (database query). */
    public Count(predicate?: QueryPredicate<T>): Promise<number> {
        return this.query().count(predicate);
    }

    /** Returns the first entity matching the predicate, or undefined (database query). */
    public FirstOrDefault(predicate?: QueryPredicate<T>): Promise<T | undefined> {
        return this.query().firstOrDefault(predicate);
    }

    /** Returns the first entity matching the predicate. Throws if none found (database query). */
    public First(predicate?: QueryPredicate<T>): Promise<T> {
        return this.query().first(predicate);
    }

    /** Removes all entities from the local tracked set (does NOT delete from DB). */
    public clear(): void {
        this.entities = [];
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Internal
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Flushes all pending changes (add/update/remove) to the provider.
     * Called by DbContext.saveChanges().
     * @internal
     */
    public async flushChanges(): Promise<void> {
        if (!this.provider || this.pendingChanges.length === 0) {
            return;
        }
        await this.context?.ensureConnected();
        const changes = [...this.pendingChanges];
        this.pendingChanges = [];
        for (const change of changes) {
            await change();
        }
    }

    /** Allows iteration over locally tracked entities with `for...of`. */
    [Symbol.iterator](): Iterator<T> {
        return this.entities[Symbol.iterator]();
    }

    /** Enqueues a provider operation to be flushed later. */
    private trackChange(change: (provider: IDbProvider) => Promise<void>): void {
        if (this.provider) {
            this.pendingChanges.push(() => change(this.provider!));
        }
    }

    /** Returns the provider or throws if not attached. */
    private getProvider(): IDbProvider {
        if (!this.provider) {
            throw new Error(`DbSet '${this.tableName}' is not attached to a provider.`);
        }
        return this.provider;
    }
}
