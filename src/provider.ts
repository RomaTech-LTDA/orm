import { QueryObject } from './query-expression';

/**
 * Describes a single column in a database table.
 *
 * Used by migrations and scaffold to create/alter schema.
 */
export interface TableColumnInfo {
    /** Column name in the database. */
    name: string;

    /** Whether this column is (part of) the primary key. */
    primaryKey?: boolean;

    /**
     * The TypeScript type that maps to this column.
     * Used by the migration engine to determine the database type.
     * Common values: 'string', 'number', 'boolean', 'Date', 'unknown'.
     */
    tsType: string;
}

/**
 * Contract that every database provider must implement.
 *
 * The ORM is provider-agnostic — all database interactions pass through
 * this interface. Implementations exist for SQL Server, MySQL, PostgreSQL,
 * Oracle, and in-memory (for testing).
 *
 * @example
 * ```ts
 * class MyProvider implements IDbProvider {
 *   // ...implement all methods
 * }
 * ```
 */
export interface IDbProvider {
    // ─── CRUD ────────────────────────────────────────────────────────────────────

    /** Inserts a single entity into the specified table. */
    add<T extends object>(entity: T, tableName: string): Promise<void>;

    /** Inserts multiple entities into the specified table. */
    addRange<T extends object>(entities: T[], tableName: string): Promise<void>;

    /** Updates an existing entity (identified by its primary key). */
    update<T extends object>(entity: T, tableName: string): Promise<void>;

    /** Deletes a single entity (identified by its primary key). */
    remove<T extends object>(entity: T, tableName: string): Promise<void>;

    /** Deletes multiple entities. */
    removeRange<T extends object>(entities: T[], tableName: string): Promise<void>;

    /** Finds a single entity by primary key. Returns undefined if not found. */
    find<T extends object>(entity: T, tableName: string): Promise<T | undefined>;

    /** Returns all rows from the specified table. */
    getAll<T>(tableName: string): Promise<T[]>;

    // ─── Unit of Work ────────────────────────────────────────────────────────────

    /** Flushes any batched changes to the database (provider-specific). */
    saveChanges(): Promise<void>;

    // ─── Migrations ──────────────────────────────────────────────────────────────

    /** Records a migration as applied in the history table. */
    addMigration(migrationName: string, migrationScript: string): Promise<void>;

    /** Removes a migration from the history table. */
    removeMigration(migrationName: string): Promise<void>;

    /** Applies all pending migrations (provider-level). */
    applyMigrations(): Promise<void>;

    /** Returns the names of all recorded (applied) migrations. */
    getMigrations(): Promise<string[]>;

    /** Returns the ordered list of applied migration names. */
    getMigrationHistory(): Promise<string[]>;

    /** Applies migrations up to an optional target. */
    updateDatabase(targetMigration?: string): Promise<void>;

    /** Reverts migrations down to an optional target. */
    downgradeDatabase(targetMigration?: string): Promise<void>;

    // ─── Schema Management ───────────────────────────────────────────────────────

    /** Creates a table with the given columns and primary key. */
    createTable(input: { tableName: string; columns: TableColumnInfo[]; primaryKey?: string }): Promise<void>;

    /** Drops an existing table. */
    dropTable(tableName: string): Promise<void>;

    /** Adds a column to an existing table. */
    addColumn(tableName: string, column: TableColumnInfo): Promise<void>;

    /** Removes a column from an existing table. */
    removeColumn(tableName: string, columnName: string): Promise<void>;

    // ─── Scaffold / Introspection ────────────────────────────────────────────────

    /** Scaffold entities from existing database (connection string variant). */
    scaffold(connectionString: string): Promise<void>;

    /** Returns a list of table names in the current database. */
    getTables(): Promise<string[]>;

    /** Returns column metadata for a specific table. */
    getColumnsForTable(table: string): Promise<TableColumnInfo[]>;

    // ─── Query Execution ─────────────────────────────────────────────────────────

    /**
     * Executes a raw SQL query and returns typed rows.
     *
     * @param query - SQL string.
     * @param params - Positional parameters.
     */
    executeQuery<T = any>(query: string, params?: any[]): Promise<T[]>;

    /**
     * Executes a structured query object (used internally by QueryBuilder).
     *
     * @param entityName - The table name to query.
     * @param query - A {@link QueryObject} describing predicates, ordering, projection, etc.
     */
    executeQuery<T, TResult = T>(entityName: string, query: QueryObject<T, TResult>): Promise<TResult[]>;

    // ─── Connection Lifecycle ────────────────────────────────────────────────────

    /** Opens the database connection. */
    connect(connectionString: string): Promise<void>;

    /** Closes the database connection. */
    disconnect(): Promise<void>;
}
