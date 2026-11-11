'use strict';

/**
 * Test helpers shared by the test files.
 *
 * `sqlEval` evaluates a parsed QueryExpression against a row using SQL
 * three-valued logic (NULL comparisons are UNKNOWN and do not match), the way
 * a database evaluates the WHERE clause that `buildSelectSql` generates.
 * LIKE follows the PostgreSQL / MySQL rules (backslash is the default escape).
 *
 * With `{ caseInsensitive: true }` string comparisons follow the default
 * collation of SQL Server and MySQL: case-insensitive, with trailing spaces
 * ignored (`'abc ' = 'ABC'`).
 *
 * `serverThenClient` reproduces what the SQL providers do: the database
 * filters with the parsed expression, then `applyClientSideQuery` re-applies
 * the original JS predicate. Rows rejected by the server never reach the
 * client, so the server filter must never be stricter than the predicate.
 */

const { parsePredicate } = require('../dist');

function likeToRegExp(pattern, flags = '') {
    let source = '';
    for (let i = 0; i < pattern.length; i++) {
        const char = pattern[i];
        if (char === '\\' && i + 1 < pattern.length) {
            source += escapeRegExp(pattern[++i]);
        } else if (char === '%') {
            source += '[\\s\\S]*';
        } else if (char === '_') {
            source += '[\\s\\S]';
        } else {
            source += escapeRegExp(char);
        }
    }
    return new RegExp(`^${source}$`, flags);
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collate(value, options) {
    return options.caseInsensitive && typeof value === 'string' ? value.toLowerCase().replace(/ +$/, '') : value;
}

function sqlEval(expression, row, options = {}) {
    if (expression.kind === 'logical') {
        const values = expression.expressions.map(part => sqlEval(part, row, options));
        if (expression.operator === 'and') {
            if (values.some(v => v === false)) return false;
            return values.every(v => v === true) ? true : null;
        }
        if (values.some(v => v === true)) return true;
        return values.every(v => v === false) ? false : null;
    }

    const raw = row[expression.field] ?? null;
    const column = collate(raw, options);
    const value = collate(expression.value, options);
    const likeFlags = options.caseInsensitive ? 'i' : '';

    if (expression.value === null || expression.value === undefined) {
        return expression.operator === '!=' ? column !== null : column === null;
    }

    if (column === null) return null;

    switch (expression.operator) {
        case '=': return column === value;
        case '!=': return column !== value;
        case '>': return column > value;
        case '>=': return column >= value;
        case '<': return column < value;
        case '<=': return column <= value;
        case 'like': return likeToRegExp(expression.value, likeFlags).test(raw);
        case 'notLike': return !likeToRegExp(expression.value, likeFlags).test(raw);
        default: throw new Error(`unknown operator ${expression.operator}`);
    }
}

function serverThenClient(predicate, rows, options = {}) {
    const expression = parsePredicate(predicate, options.parse);
    const fromServer = expression ? rows.filter(row => sqlEval(expression, row, options) === true) : rows;
    return fromServer.filter(predicate);
}

module.exports = { sqlEval, serverThenClient };
