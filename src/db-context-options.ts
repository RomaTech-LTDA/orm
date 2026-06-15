import { IDbProvider } from './provider';

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
}
