import { IDbProvider } from './provider';
import { RetryPolicyOptions } from './retry-policy';

/**
 * Configuration object passed to a {@link DbContext} constructor.
 *
 * Use the fluent API to configure the provider and connection settings:
 *
 * ```ts
 * new DbContextOptions()
 *     .useProvider(new MsSqlProvider({ ... }))
 *     .withConnectionString('Server=localhost;...')
 * ```
 */
export class DbContextOptions {
    private _provider?: IDbProvider;
    private _connectionString?: string;
    private _autoConnect: boolean = true;
    private _retryPolicy?: RetryPolicyOptions;
    private _poolConfig?: PoolConfig;

    /**
     * Configuration for connection pooling.
     */
    public withPooling(config: PoolConfig): this {
        this._poolConfig = config;
        return this;
    }

    /**
     * Sets the database provider for this context.
     *
     * @param provider - An implementation of {@link IDbProvider}.
     * @param connectionString - Optional connection string that will be
     *   forwarded to `provider.connect()`.
     */
    public useProvider(provider: IDbProvider, connectionString?: string): this {
        this._provider = provider;
        if (connectionString) {
            this._connectionString = connectionString;
        }
        return this;
    }

    /**
     * Sets (or overrides) the connection string used when opening the connection.
     *
     * @param connectionString - Database connection string.
     */
    public withConnectionString(connectionString: string): this {
        this._connectionString = connectionString;
        return this;
    }

    /**
     * Disables automatic connection on first database operation.
     * When disabled, you must call `DbContext.connect()` manually.
     */
    public disableAutoConnect(): this {
        this._autoConnect = false;
        return this;
    }

    /**
     * Configures connection retry with exponential backoff.
     *
     * @example
     * ```ts
     * new DbContextOptions()
     *     .useProvider(provider)
     *     .withRetryPolicy({ maxRetries: 5, initialDelayMs: 2000 })
     * ```
     */
    public withRetryPolicy(options: RetryPolicyOptions): this {
        this._retryPolicy = options;
        return this;
    }

    /** Returns the configured provider. Throws if none was set. */
    public get provider(): IDbProvider {
        if (!this._provider) {
            throw new Error('DbProvider not configured. Use useProvider() to set a provider.');
        }
        return this._provider;
    }

    /** Returns the configured connection string, or undefined. */
    public get connectionString(): string | undefined {
        return this._connectionString;
    }

    /** Whether the context should automatically open the connection. Default: true. */
    public get autoConnect(): boolean {
        return this._autoConnect;
    }

    /** Returns the retry policy configuration, or undefined. */
    public get retryPolicy(): RetryPolicyOptions | undefined {
        return this._retryPolicy;
    }

    /** Returns the pool configuration, or undefined. */
    public get poolConfig(): PoolConfig | undefined {
        return this._poolConfig;
    }
}

/**
 * Connection pool configuration.
 * Providers that support pooling will use these settings.
 */
export interface PoolConfig {
    /** Minimum number of connections in the pool. Default: 2 */
    min?: number;
    /** Maximum number of connections in the pool. Default: 10 */
    max?: number;
    /** Time in ms a connection can be idle before being closed. Default: 30000 */
    idleTimeoutMs?: number;
    /** Time in ms to wait for a connection from the pool. Default: 5000 */
    acquireTimeoutMs?: number;
}
