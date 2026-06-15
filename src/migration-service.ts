/**
 * @module migration-service
 *
 * Implements a code-first migration engine inspired by EF Core migrations.
 *
 * Migrations are stored as JSON files and describe schema changes (create table,
 * drop table, add column, remove column).  The service maintains a history table
 * inside the target database so it knows which migrations have already been applied.
 *
 * ## Workflow
 *
 * 1. Decorate your entities with `@Entity`, `@PrimaryKey`, `@Column`.
 * 2. Run `MigrationService.createMigration('AddUsersTable')` → generates a
 *    timestamped JSON migration file.
 * 3. Run `MigrationService.updateDatabase()` → applies all pending migrations.
 * 4. To revert, call `MigrationService.downgradeDatabase()`.
 *
 * @example
 * ```ts
 * const service = new MigrationService(provider, './migrations');
 * await service.createMigration('InitialCreate');
 * await service.updateDatabase();
 * ```
 */

import fs from 'fs/promises';
import path from 'path';
import { TableColumnInfo, IDbProvider } from './provider';
import { getColumns, getEntityMetadata, getPrimaryKey, getTableName } from './decorators';

// ─── Types ───────────────────────────────────────────────────────────────────────

/**
 * A single schema operation within a migration (either `up` or `down`).
 *
 * Operations are applied sequentially during migration.
 */
export type MigrationOperation =
    | { action: 'createTable'; table: string; columns: TableColumnInfo[] }
    | { action: 'dropTable'; table: string }
    | { action: 'addColumn'; table: string; column: TableColumnInfo }
    | { action: 'removeColumn'; table: string; columnName: string };

/**
 * The full contents of a migration file, including both the forward (`up`)
 * and reverse (`down`) operation sets.
 */
export interface MigrationFile {
    /** Unique name (includes timestamp prefix). */
    migrationName: string;

    /** Operations to apply when upgrading. */
    up: MigrationOperation[];

    /** Operations to apply when reverting (should undo everything in `up`). */
    down: MigrationOperation[];
}

// ─── Service ─────────────────────────────────────────────────────────────────────

/**
 * Manages the creation, application, and reversal of database migrations.
 *
 * Delegates all actual schema DDL to the configured {@link IDbProvider}, making
 * the migration logic fully database-agnostic.
 */
export class MigrationService {
    /**
     * @param provider - The database provider that will execute DDL operations.
     * @param migrationsPath - Filesystem path where migration JSON files are stored.
     */
    constructor(
        private provider: IDbProvider,
        private migrationsPath = './migrations'
    ) {}

    // ─── Create Migration ────────────────────────────────────────────────────────

    /**
     * Creates a new migration file.
     *
     * If no explicit operations are provided, the migration is auto-generated
     * from the current entity metadata (all decorated entities become
     * `createTable` operations).
     *
     * @param migrationName - Human-readable name (e.g. 'AddUsersTable').
     * @param operations - Optional explicit `up` and `down` operations.
     * @returns The full migration name (timestamp + sanitised name).
     *
     * @example
     * ```ts
     * const name = await service.createMigration('AddProductsTable');
     * // '20260605120000_AddProductsTable'
     * ```
     */
    async createMigration(
        migrationName: string,
        operations?: { up?: MigrationOperation[]; down?: MigrationOperation[] }
    ): Promise<string> {
        await fs.mkdir(this.migrationsPath, { recursive: true });

        const up = operations?.up ?? this.createInitialSchemaOperations();
        const down = operations?.down ?? this.createDefaultDownOperations(up);
        const fullName = `${this.createTimestamp()}_${this.toSafeMigrationName(migrationName)}`;

        const migration: MigrationFile = {
            migrationName: fullName,
            up,
            down
        };

        const filePath = path.join(this.migrationsPath, `${fullName}.migration.json`);
        await fs.writeFile(filePath, `${JSON.stringify(migration, null, 2)}\n`, 'utf-8');
        return fullName;
    }

    // ─── Update Database (Apply Migrations) ──────────────────────────────────────

    /**
     * Applies all pending (not yet applied) migrations, or up to a specified
     * target migration.
     *
     * Migrations are applied in alphabetical (timestamp) order. After each
     * migration's `up` operations execute successfully, the migration is
     * recorded in the provider's history table.
     *
     * @param targetMigration - Optional inclusive upper bound. If given, only
     *   migrations up to and including this name are applied.
     * @throws {Error} If the target migration name does not exist.
     *
     * @example
     * ```ts
     * await service.updateDatabase();
     * // or apply up to a specific migration:
     * await service.updateDatabase('20260101120000_AddUsersTable');
     * ```
     */
    async updateDatabase(targetMigration?: string): Promise<void> {
        const applied = new Set(await this.provider.getMigrationHistory());
        const allFiles = await fs.readdir(this.migrationsPath);

        const allMigrations = allFiles
            .filter(f => f.endsWith('.migration.json'))
            .map(f => f.replace('.migration.json', ''))
            .sort(); // Timestamp prefix ensures correct chronological order

        const pending = allMigrations.filter(m => !applied.has(m));

        let toApply: string[];

        if (targetMigration) {
            const targetIndex = allMigrations.indexOf(targetMigration);
            if (targetIndex === -1) throw new Error(`Target migration '${targetMigration}' not found.`);
            toApply = pending.filter(m => allMigrations.indexOf(m) <= targetIndex);
        } else {
            toApply = pending;
        }

        for (const name of toApply) {
            const migration = await this.readMigrationFile(name);
            for (const op of migration.up) {
                await this.applyOperation(op);
            }
            await this.provider.addMigration(name, JSON.stringify(migration));
        }
    }

    // ─── Downgrade Database (Revert Migrations) ──────────────────────────────────

    /**
     * Reverts applied migrations.
     *
     * - Without a target: reverts only the last applied migration.
     * - With a target: reverts all migrations applied **after** the target
     *   (the target itself remains applied).
     *
     * @param targetMigration - Optional exclusive lower bound. Migrations after
     *   this name are reverted. Pass `undefined` to revert only the last one.
     * @throws {Error} If the target migration name does not exist.
     *
     * @example
     * ```ts
     * await service.downgradeDatabase(); // revert last
     * await service.downgradeDatabase('20260101120000_Initial'); // revert everything after Initial
     * ```
     */
    async downgradeDatabase(targetMigration?: string): Promise<void> {
        const applied = await this.provider.getMigrationHistory();
        const allFiles = await fs.readdir(this.migrationsPath);

        const allMigrations = allFiles
            .filter(f => f.endsWith('.migration.json'))
            .map(f => f.replace('.migration.json', ''))
            .sort();

        let toRevert: string[];

        if (targetMigration) {
            const targetIndex = allMigrations.indexOf(targetMigration);
            if (targetIndex === -1) throw new Error(`Target migration '${targetMigration}' not found.`);
            // Revert all applied migrations that come after the target (in reverse order)
            toRevert = applied.filter(m => allMigrations.indexOf(m) > targetIndex).reverse();
        } else {
            // Revert only the most recently applied migration
            toRevert = applied.length ? [applied[applied.length - 1]] : [];
        }

        for (const name of toRevert) {
            const migration = await this.readMigrationFile(name);
            // Execute down operations in reverse order
            for (const op of [...migration.down].reverse()) {
                await this.applyOperation(op);
            }
            await this.provider.removeMigration(name);
        }
    }

    // ─── Internal helpers ────────────────────────────────────────────────────────

    /**
     * Executes a single migration operation against the provider.
     * Delegates to the provider's DDL methods (createTable, dropTable, etc.).
     */
    private async applyOperation(op: MigrationOperation): Promise<void> {
        switch (op.action) {
            case 'createTable':
                await this.provider.createTable({
                    tableName: op.table,
                    columns: op.columns,
                    primaryKey: op.columns.find(c => c.primaryKey)?.name
                });
                break;

            case 'dropTable':
                await this.provider.dropTable(op.table);
                break;

            case 'addColumn':
                await this.provider.addColumn(op.table, op.column);
                break;

            case 'removeColumn':
                await this.provider.removeColumn(op.table, op.columnName);
                break;

            default:
                throw new Error(`Unknown migration operation: ${JSON.stringify(op)}`);
        }
    }

    /**
     * Reads and parses a migration JSON file from the filesystem.
     */
    private async readMigrationFile(name: string): Promise<MigrationFile> {
        const filePath = path.join(this.migrationsPath, `${name}.migration.json`);
        const content = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(content);
    }

    /**
     * Auto-generates `createTable` operations from all registered entity
     * metadata (i.e. all classes decorated with `@Entity()`).
     */
    private createInitialSchemaOperations(): MigrationOperation[] {
        return Array.from(getEntityMetadata().values()).map(entity => {
            const primaryKey = getPrimaryKey(entity);
            const columns = getColumns(entity).map(column => ({
                name: column.options.name || String(column.propertyKey),
                primaryKey: column.propertyKey === primaryKey,
                tsType: this.resolveTsType(entity, column.propertyKey, column.options.type)
            }));

            return {
                action: 'createTable',
                table: getTableName(entity) || entity.name,
                columns
            };
        });
    }

    /**
     * Generates inverse (down) operations from a set of `up` operations.
     *
     * - `createTable` → `dropTable`
     * - `addColumn` → `removeColumn`
     * - `dropTable` / `removeColumn` → no inverse (data loss is irreversible)
     */
    private createDefaultDownOperations(up: MigrationOperation[]): MigrationOperation[] {
        return up
            .map(operation => {
                switch (operation.action) {
                    case 'createTable':
                        return { action: 'dropTable', table: operation.table } as MigrationOperation;
                    case 'dropTable':
                        return undefined; // Cannot recreate without full schema info
                    case 'addColumn':
                        return { action: 'removeColumn', table: operation.table, columnName: operation.column.name } as MigrationOperation;
                    case 'removeColumn':
                        return undefined; // Cannot re-add without column info
                    default:
                        return undefined;
                }
            })
            .filter((operation): operation is MigrationOperation => operation !== undefined);
    }

    /**
     * Resolves the TypeScript type string for a column.
     *
     * Uses the explicit type from `@Column({ type: '...' })` if available,
     * otherwise falls back to `Reflect.getMetadata('design:type', …)` which
     * requires `emitDecoratorMetadata: true` in tsconfig.
     */
    private resolveTsType(entity: Function, propertyKey: string | symbol, explicitType?: string): string {
        if (explicitType) {
            return explicitType;
        }

        const reflectedType = Reflect.getMetadata('design:type', entity.prototype, propertyKey);

        switch (reflectedType) {
            case Number:
                return 'number';
            case Boolean:
                return 'boolean';
            case Date:
                return 'Date';
            case Array:
                return 'unknown[]';
            case Object:
                return 'unknown';
            case String:
            default:
                return 'string';
        }
    }

    /**
     * Generates a 14-digit timestamp string (YYYYMMDDHHmmss) used as a
     * migration name prefix to ensure correct chronological ordering.
     */
    private createTimestamp(): string {
        return new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    }

    /**
     * Sanitises a user-provided migration name into a filesystem-safe string.
     * Replaces non-alphanumeric characters with underscores.
     */
    private toSafeMigrationName(name: string): string {
        const safeName = name.trim().replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
        return safeName || 'Migration';
    }
}
