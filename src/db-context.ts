import { DbSet } from './dbset';
import { ConnectionState } from './connection-state-enum';
import { DbContextOptions } from './db-context-options';
import { IDbProvider } from './provider';
import { getTableName } from './decorators';

/** Generic constructor type for entity classes. */
type EntityConstructor<T extends object> = new (...args: any[]) => T;

/**
 * Base class for a database context — the main entry point for interacting
 * with the database in a Unit of Work pattern, inspired by EF Core's DbContext.
 *
 * Subclass this to declare your entity sets and configure the provider:
 *
 * ```ts
 * class AppDbContext extends DbContext {
 *     public users = this.set(User);
 *     public products = this.set(Product);
 *
 *     constructor() {
 *         super(new DbContextOptions().useProvider(new MemoryProvider()));
 *     }
 * }
 * ```
 *
 * The connection is opened automatically on the first database operation
 * (auto-connect). Call `disconnect()` when you're done to release resources.
 */
export abstract class DbContext {
    private _dbSets: Map<string, DbSet<any>> = new Map();
    private _connectionState: ConnectionState = ConnectionState.Disconnected;
    private _connectPromise: Promise<void> | null = null;

    /** The underlying database provider. */
    protected _provider!: IDbProvider;

    private _autoConnect: boolean;
    private _connectionString?: string;

    /**
     * Creates a new context instance.
     *
     * @param options - Context configuration (provider, connection string, etc.).
     */
    protected constructor(options: DbContextOptions) {
        this._provider = options.provider;
        this._autoConnect = options.autoConnect;
        this._connectionString = options.connectionString;
        this.initializeDbSets();
    }

    /**
     * Scans the instance and prototype for DbSet properties/getters
     * and registers them in the internal map.
     */
    private initializeDbSets() {
        // Instance properties (e.g. public users = this.set(User))
        const propertyNames = Object.getOwnPropertyNames(this);
        for (const key of propertyNames) {
            const value = (this as any)[key];
            if (value instanceof DbSet) {
                this._dbSets.set(key, value);
            }
        }

        // Getter accessors defined on the prototype
        const proto = Object.getPrototypeOf(this);
        for (const key of Object.getOwnPropertyNames(proto)) {
            const descriptor = Object.getOwnPropertyDescriptor(proto, key);
            if (descriptor && typeof descriptor.get === 'function') {
                try {
                    const value = (this as any)[key];
                    if (value instanceof DbSet) {
                        this._dbSets.set(key, value);
                    }
                } catch {
                    // Getter may throw before connection is established — ignore
                }
            }
        }
    }

    // ─── Connection Lifecycle ────────────────────────────────────────────────────

    /**
     * Opens the database connection.
     *
     * This is called automatically before any operation when auto-connect
     * is enabled (default). You only need to call it manually if you
     * disabled auto-connect via `DbContextOptions.disableAutoConnect()`.
     */
    public async connect(): Promise<void> {
        if (this._connectionState === ConnectionState.Connected) {
            return;
        }

        // Deduplicate concurrent connect calls
        if (this._connectPromise) {
            return this._connectPromise;
        }

        this._connectPromise = (async () => {
            this._connectionState = ConnectionState.Connecting;
            try {
                await this._provider.connect(this._connectionString ?? '');
                this._connectionState = ConnectionState.Connected;
            } catch (error) {
                this._connectionState = ConnectionState.Error;
                throw error;
            } finally {
                this._connectPromise = null;
            }
        })();

        return this._connectPromise;
    }

    /**
     * Closes the database connection and releases resources.
     */
    public async disconnect(): Promise<void> {
        if (this._connectionState === ConnectionState.Disconnected) {
            return;
        }
        this._connectionState = ConnectionState.Disconnecting;
        try {
            await this._provider.disconnect();
        } finally {
            this._connectionState = ConnectionState.Disconnected;
        }
    }

    /**
     * Ensures the connection is open before a database operation.
     * Called internally by DbSet and QueryBuilder.
     * @internal
     */
    async ensureConnected(): Promise<void> {
        if (this._autoConnect && this._connectionState !== ConnectionState.Connected) {
            await this.connect();
        }
    }

    // ─── DbSet Registration ──────────────────────────────────────────────────────

    /**
     * Registers and returns a DbSet for the given entity class.
     *
     * @param entityType - The entity constructor decorated with `@Entity()`.
     * @param tableName - Optional explicit table name (overrides the decorator).
     */
    protected set<T extends object>(entityType: EntityConstructor<T>, tableName?: string): DbSet<T>;

    /**
     * Returns an existing DbSet by its property name.
     *
     * @param propertyName - The property name used when registering the DbSet.
     */
    protected set<T extends object>(propertyName: string): DbSet<T>;

    protected set<T extends object>(entityOrProperty: EntityConstructor<T> | string, tableName?: string): DbSet<T> {
        if (typeof entityOrProperty === 'function') {
            const resolvedTableName = tableName || getTableName(entityOrProperty) || entityOrProperty.name;
            let dbSet = this._dbSets.get(resolvedTableName);
            if (!dbSet) {
                dbSet = new DbSet<T>(entityOrProperty, this._provider, resolvedTableName, this);
                this._dbSets.set(resolvedTableName, dbSet);
            }
            return dbSet as DbSet<T>;
        }

        const dbSet = this._dbSets.get(entityOrProperty);
        if (!dbSet) {
            throw new Error(`DbSet '${entityOrProperty}' not found.`);
        }
        return dbSet as unknown as DbSet<T>;
    }

    // ─── State ───────────────────────────────────────────────────────────────────

    /** Returns the current connection state. */
    public get connectionState(): ConnectionState {
        return this._connectionState;
    }

    /** Allows subclasses to override the connection state (advanced usage). */
    protected setConnectionState(state: ConnectionState) {
        this._connectionState = state;
    }

    // ─── Save Changes ────────────────────────────────────────────────────────────

    /**
     * Persists all pending changes (adds, updates, deletes) tracked by
     * all DbSets in this context.
     *
     * ```ts
     * db.users.add(newUser);
     * db.users.remove(oldUser);
     * await db.saveChanges(); // both operations are flushed here
     * ```
     */
    public async saveChanges(): Promise<void> {
        await this.ensureConnected();
        for (const dbSet of this._dbSets.values()) {
            await dbSet.flushChanges();
        }
        await this._provider.saveChanges();
    }

    // ─── Static Factory ──────────────────────────────────────────────────────────

    /**
     * Convenience static factory that builds a context with a configuration callback.
     *
     * @example
     * ```ts
     * const ctx = AppDbContext.build(
     *     () => new DbContextOptions(),
     *     opts => opts.useProvider(new MsSqlProvider({ ... }))
     * );
     * ```
     */
    public static build<T extends DbContext, O extends DbContextOptions>(
        this: new (options: O) => T,
        optionsFactory: () => O,
        configure: (options: O) => void
    ): T {
        const options = optionsFactory();
        configure(options);
        return new this(options);
    }
}
