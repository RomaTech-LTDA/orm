/**
 * @module sql-query-builder
 *
 * Translates {@link QueryObject} instances into dialect-specific SQL strings.
 *
 * The module exports:
 * - CRUD helpers: `buildInsertSql`, `buildUpdateSql`, `buildDeleteSql`, `buildFindSql`
 * - Query builder: `buildSelectSql`, `buildSelectAllSql`
 * - Client-side fallback: `applyClientSideQuery`
 *
 * All SQL generation is dialect-agnostic through the {@link SqlDialect} interface —
 * each provider supplies its own quoting and parameter conventions.
 *
 * @example
 * ```ts
 * import { buildSelectSql, SqlDialect } from '@romatech/orm';
 *
 * const mssqlDialect: SqlDialect = {
 *     quoteIdentifier: id => `[${id}]`,
 *     parameter: i => `@param${i}`
 * };
 *
 * const cmd = buildSelectSql('Users', queryObject, mssqlDialect);
 * // cmd.sql  = 'SELECT * FROM [Users] WHERE [age] >= @param0'
 * // cmd.params = [18]
 * ```
 */

import {
    QueryComparisonOperator,
    QueryExpression,
    QueryObject,
    QueryOrderExpression
} from './query-expression';

// ─── Dialect Interface ───────────────────────────────────────────────────────────

/**
 * Defines how SQL identifiers and parameters are rendered for a specific
 * database engine.
 *
 * Each provider exports its own dialect. For example:
 * - SQL Server: `[identifier]`, `@param0`
 * - PostgreSQL: `"identifier"`, `$1`
 * - MySQL:      `` `identifier` ``, `?`
 * - Oracle:     `"identifier"`, `:1`
 */
export interface SqlDialect {
    /**
     * Wraps a table or column name in the dialect's quoting characters.
     * Must also escape any special characters inside the identifier.
     *
     * @param identifier - Raw column/table name.
     * @returns Quoted identifier string.
     */
    quoteIdentifier(identifier: string): string;

    /**
     * Returns the placeholder string for a positional parameter.
     *
     * @param index - Zero-based parameter index.
     * @returns The parameter placeholder (e.g. `$1`, `?`, `@param0`).
     */
    parameter(index: number): string;
}

// ─── SQL Command Result ──────────────────────────────────────────────────────────

/**
 * The result of an SQL generation function — a parameterised SQL string
 * together with its bound values.
 */
export interface SqlCommand {
    /** Parameterised SQL string ready for execution. */
    sql: string;
    /** Ordered array of parameter values that correspond to placeholders in `sql`. */
    params: unknown[];
}

// ─── SELECT ──────────────────────────────────────────────────────────────────────

/**
 * Builds a `SELECT * FROM table [WHERE …] [ORDER BY …]` statement from a
 * {@link QueryObject}.
 *
 * Only generates the `WHERE` clause when all predicates were successfully
 * parsed into expressions (i.e. they can be fully translated to SQL).
 * Otherwise, the caller must use {@link applyClientSideQuery} as a fallback.
 *
 * Similarly, `ORDER BY` is only generated when all orderings have matching
 * expression metadata.
 *
 * @param tableName - Target table.
 * @param query - Query descriptor built by QueryBuilder.
 * @param dialect - SQL dialect for quoting and parameters.
 * @returns Parameterised SQL command.
 */
export function buildSelectSql<T>(tableName: string, query: QueryObject<T>, dialect: SqlDialect): SqlCommand {
    const params: unknown[] = [];

    // Only push WHERE to the database when every predicate was parsed
    const whereSql = canUseServerWhere(query)
        ? query.whereExpressions.map(expression => compileExpression(expression, dialect, params)).join(' AND ')
        : '';

    // Only push ORDER BY to the database when every ordering was parsed
    const orderSql = canUseServerOrder(query)
        ? compileOrderExpressions(query.orderByExpressions, dialect)
        : '';

    const sql = [
        `SELECT * FROM ${dialect.quoteIdentifier(tableName)}`,
        whereSql ? `WHERE ${whereSql}` : '',
        orderSql ? `ORDER BY ${orderSql}` : ''
    ].filter(Boolean).join(' ');

    return { sql, params };
}

/**
 * Builds a simple `SELECT * FROM table` statement with no filtering.
 *
 * @param tableName - Target table.
 * @param dialect - SQL dialect for quoting.
 * @returns Raw SQL string (no parameters).
 */
export function buildSelectAllSql(tableName: string, dialect: SqlDialect): string {
    return `SELECT * FROM ${dialect.quoteIdentifier(tableName)}`;
}

// ─── INSERT ──────────────────────────────────────────────────────────────────────

/**
 * Builds an `INSERT INTO table (cols…) VALUES (params…)` statement.
 *
 * Only includes properties that are not `undefined` on the entity object.
 *
 * @param tableName - Target table.
 * @param entity - Object with column values to insert.
 * @param dialect - SQL dialect.
 * @returns Parameterised SQL command.
 */
export function buildInsertSql<T extends object>(tableName: string, entity: T, dialect: SqlDialect): SqlCommand {
    const entries = Object.entries(entity).filter(([, value]) => value !== undefined);
    const columns = entries.map(([key]) => dialect.quoteIdentifier(key)).join(', ');
    const placeholders = entries.map((_, index) => dialect.parameter(index)).join(', ');

    return {
        sql: `INSERT INTO ${dialect.quoteIdentifier(tableName)} (${columns}) VALUES (${placeholders})`,
        params: entries.map(([, value]) => value)
    };
}

// ─── UPDATE ──────────────────────────────────────────────────────────────────────

/**
 * Builds an `UPDATE table SET col=val, … WHERE pk=val` statement.
 *
 * Excludes the primary key from the SET clause.
 *
 * @param tableName - Target table.
 * @param entity - Object with updated column values.
 * @param primaryKey - Name of the primary key column.
 * @param dialect - SQL dialect.
 * @returns Parameterised SQL command.
 */
export function buildUpdateSql<T extends object>(
    tableName: string,
    entity: T,
    primaryKey: string,
    dialect: SqlDialect
): SqlCommand {
    const entries = Object.entries(entity).filter(([key, value]) => key !== primaryKey && value !== undefined);
    const primaryKeyValue = (entity as Record<string, unknown>)[primaryKey];
    const assignments = entries
        .map(([key], index) => `${dialect.quoteIdentifier(key)} = ${dialect.parameter(index)}`)
        .join(', ');

    return {
        sql: `UPDATE ${dialect.quoteIdentifier(tableName)} SET ${assignments} WHERE ${dialect.quoteIdentifier(primaryKey)} = ${dialect.parameter(entries.length)}`,
        params: [...entries.map(([, value]) => value), primaryKeyValue]
    };
}

// ─── DELETE ──────────────────────────────────────────────────────────────────────

/**
 * Builds a `DELETE FROM table WHERE pk=val` statement.
 *
 * @param tableName - Target table.
 * @param entity - The entity being deleted (must contain the PK value).
 * @param primaryKey - Name of the primary key column.
 * @param dialect - SQL dialect.
 * @returns Parameterised SQL command.
 */
export function buildDeleteSql<T extends object>(
    tableName: string,
    entity: T,
    primaryKey: string,
    dialect: SqlDialect
): SqlCommand {
    return {
        sql: `DELETE FROM ${dialect.quoteIdentifier(tableName)} WHERE ${dialect.quoteIdentifier(primaryKey)} = ${dialect.parameter(0)}`,
        params: [(entity as Record<string, unknown>)[primaryKey]]
    };
}

// ─── FIND ────────────────────────────────────────────────────────────────────────

/**
 * Builds a `SELECT * FROM table WHERE pk=val` statement (single-row lookup).
 *
 * @param tableName - Target table.
 * @param entity - Must contain the primary key value.
 * @param primaryKey - Name of the primary key column.
 * @param dialect - SQL dialect.
 * @returns Parameterised SQL command.
 */
export function buildFindSql<T extends object>(
    tableName: string,
    entity: T,
    primaryKey: string,
    dialect: SqlDialect
): SqlCommand {
    return {
        sql: `SELECT * FROM ${dialect.quoteIdentifier(tableName)} WHERE ${dialect.quoteIdentifier(primaryKey)} = ${dialect.parameter(0)}`,
        params: [(entity as Record<string, unknown>)[primaryKey]]
    };
}

// ─── Client-Side Fallback ────────────────────────────────────────────────────────

/**
 * Applies filtering, sorting, pagination, and projection on an in-memory
 * row array.
 *
 * Used by providers after fetching data from the database when the query
 * contained parts that could not be translated to SQL (e.g. predicates
 * referencing outer-scope variables).
 *
 * The execution order mirrors the SQL semantics:
 * 1. `WHERE` (predicates)
 * 2. `ORDER BY` (orderings / comparer)
 * 3. `OFFSET` (skip)
 * 4. `LIMIT` (take)
 * 5. `SELECT` (selector / projection)
 *
 * @param rows - Raw rows as fetched from the database.
 * @param query - The query object describing the desired transformation.
 * @returns Transformed result array.
 */
export function applyClientSideQuery<T, TResult = T>(rows: T[], query: QueryObject<T, TResult>): TResult[] {
    let result = [...rows];

    // Collect all predicates, including the backward-compatible `where` property
    const predicates = [...query.predicates];
    if (query.where && !predicates.includes(query.where)) {
        predicates.push(query.where);
    }

    // 1. Filter
    for (const predicate of predicates) {
        result = result.filter(predicate);
    }

    // 2. Sort — prefer the pre-built comparer, fall back to building one
    const comparer = query.orderBy || createComparer(query.orderings);
    if (comparer) {
        result = [...result].sort(comparer);
    }

    // 3. Skip
    if (query.skip !== undefined) {
        result = result.slice(query.skip);
    }

    // 4. Take
    if (query.take !== undefined) {
        result = result.slice(0, query.take);
    }

    // 5. Project
    return query.selector
        ? result.map(query.selector)
        : result as unknown as TResult[];
}

// ─── Internal helpers ────────────────────────────────────────────────────────────

/**
 * Determines whether all predicates were successfully parsed, meaning the
 * WHERE clause can be generated entirely on the server side.
 */
function canUseServerWhere<T>(query: QueryObject<T>): boolean {
    return query.predicates.length > 0 && query.predicates.length === query.whereExpressions.length;
}

/**
 * Determines whether all orderings were successfully parsed, meaning the
 * ORDER BY clause can be generated entirely on the server side.
 */
function canUseServerOrder<T>(query: QueryObject<T>): boolean {
    return query.orderings.length > 0 && query.orderings.length === query.orderByExpressions.length;
}

/**
 * Recursively compiles a {@link QueryExpression} tree into a SQL fragment,
 * appending parameter values to the `params` array.
 */
function compileExpression(expression: QueryExpression, dialect: SqlDialect, params: unknown[]): string {
    if (expression.kind === 'logical') {
        return `(${expression.expressions.map(part => compileExpression(part, dialect, params)).join(` ${expression.operator.toUpperCase()} `)})`;
    }

    const field = dialect.quoteIdentifier(expression.field);

    // NULL handling — SQL uses IS NULL / IS NOT NULL syntax
    if (expression.value === null || expression.value === undefined) {
        return expression.operator === '!=' ? `${field} IS NOT NULL` : `${field} IS NULL`;
    }

    const parameter = dialect.parameter(params.length);
    params.push(expression.value);

    return `${field} ${toSqlOperator(expression.operator)} ${parameter}`;
}

/**
 * Compiles an array of order expressions into a comma-separated `ORDER BY` fragment.
 */
function compileOrderExpressions(expressions: QueryOrderExpression[], dialect: SqlDialect): string {
    return expressions
        .map(expression => `${dialect.quoteIdentifier(expression.field)} ${expression.direction.toUpperCase()}`)
        .join(', ');
}

/**
 * Maps the internal comparison operator type to its SQL string representation.
 */
function toSqlOperator(operator: QueryComparisonOperator): string {
    if (operator === 'notLike') return 'NOT LIKE';
    return operator === 'like' ? 'LIKE' : operator;
}

/**
 * Builds a comparer function from an array of {@link QueryOrdering} descriptors,
 * used for client-side sorting when server-side ORDER BY is not available.
 */
function createComparer<T>(orderings: QueryObject<T>['orderings']): ((a: T, b: T) => number) | undefined {
    if (!orderings.length) {
        return undefined;
    }

    return (a, b) => {
        for (const ordering of orderings) {
            const left = ordering.selector(a);
            const right = ordering.selector(b);
            const comparison = compareValues(left, right);

            if (comparison !== 0) {
                return ordering.direction === 'desc' ? -comparison : comparison;
            }
        }

        return 0;
    };
}

/**
 * Compares two values with null-safe semantics:
 * - Equal → 0
 * - null/undefined always sorts first → -1
 * - Otherwise uses standard `<` comparison.
 */
function compareValues(left: unknown, right: unknown): number {
    if (left === right) return 0;
    if (left === undefined || left === null) return -1;
    if (right === undefined || right === null) return 1;
    return left < right ? -1 : 1;
}
