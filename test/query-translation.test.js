'use strict';

/**
 * Translation rules added in 2.1.0. Every case checks the invariant the SQL
 * providers rely on: the server WHERE may return more rows than the JS
 * predicate accepts (they are re-filtered on the client) but never fewer.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { parsePredicate, parseSelector, buildSelectSql, QueryBuilder, Column, Entity, PrimaryKey, applyClientSideQuery } = require('../dist');
const { serverThenClient } = require('./helpers');

const pg = {
    quoteIdentifier: id => `"${id.replace(/"/g, '""')}"`,
    parameter: i => `$${i + 1}`
};

const ids = list => list.map(row => row.id);

function queryFor(predicate, options) {
    const expression = parsePredicate(predicate, options);
    return {
        includes: [],
        predicates: [predicate],
        whereExpressions: expression ? [expression] : [],
        orderings: [],
        orderByExpressions: []
    };
}

const rows = [
    { id: 1, name: 'abc', status: 'OPEN', age: null, n: 8, flag: true },
    { id: 2, name: '', status: 'open', age: 25, n: 10, flag: false },
    { id: 3, name: null, status: 'Closed', age: 40, n: 1, flag: null },
    { id: 4, name: 'x', status: 'open ', age: 0, n: 0, flag: true },
    { id: 5, name: 'a', status: 'archived', age: -3, n: 2, flag: false }
];

// ─── Server filter must never drop rows the JS predicate accepts ──────────────

const cases = {
    // Bare member on a non-boolean column used to become `name = true`
    'bare member on a string column': u => u.name,
    'bare member inside OR': u => u.age === 40 || u.name,
    // Case-insensitive collation (SQL Server / MySQL default)
    '!== on a string (CI collation)': u => u.status !== 'open',
    '> on a string (CI collation)': u => u.name > 'B',
    '<= on a string (CI collation)': u => u.status <= 'Closed',
    'negated startsWith (CI collation)': u => !u.status.startsWith('op'),
    'negated includes (CI collation)': u => !u.status.includes('OPEN'),
    // JS coerces null to 0 in relational comparisons
    '< number keeps NULL rows (null < 30 is true)': u => u.age < 30,
    '>= 0 keeps NULL rows (null >= 0 is true)': u => u.age >= 0,
    '> -1 keeps NULL rows (null > -1 is true)': u => u.age > -1,
    'flipped literal: 30 > age keeps NULL rows': u => 30 > u.age,
    '> 5 (NULL rows are rejected by JS too)': u => u.age > 5,
    // Legacy octal literal: 010 === 8 in sloppy-mode JS, but Number('010') === 10
    'legacy octal literal': new Function('u', 'return u.n === 010'),
    // Nested member access is not a column
    'nested member (string length)': u => u.status.length > 4
};

for (const [name, predicate] of Object.entries(cases)) {
    test(`server WHERE does not lose rows: ${name}`, () => {
        const expected = ids(rows.filter(predicate));
        assert.deepEqual(ids(serverThenClient(predicate, rows, { caseInsensitive: true })), expected);
        assert.deepEqual(ids(serverThenClient(predicate, rows)), expected);
    });
}

// ─── Bare boolean members ────────────────────────────────────────────────────

test('bare member is not translated unless the field is known to be boolean', () => {
    assert.equal(parsePredicate(u => u.name), undefined);
    assert.equal(parsePredicate(u => !u.name), undefined);
});

test('bare member on a known boolean field is translated (NULL kept for the negation)', () => {
    const options = { booleanFields: ['flag'] };
    assert.deepEqual(parsePredicate(u => u.flag, options), { kind: 'comparison', field: 'flag', operator: '=', value: true });

    const negated = buildSelectSql('T', queryFor(u => !u.flag, options), pg);
    assert.equal(negated.sql, 'SELECT * FROM "T" WHERE ("flag" = $1 OR "flag" IS NULL)');
    assert.deepEqual(negated.params, [false]);
    assert.deepEqual(ids(serverThenClient(u => !u.flag, rows, { parse: options })), ids(rows.filter(u => !u.flag)));
    assert.deepEqual(ids(serverThenClient(u => u.flag, rows, { parse: options })), ids(rows.filter(u => u.flag)));

    assert.equal(parsePredicate(u => u.name, options), undefined);
});

test('QueryBuilder translates bare members only for Boolean properties of the entity', async () => {
    class Account {}
    Entity('Accounts')(Account);
    PrimaryKey()(Account.prototype, 'id');
    Reflect.defineMetadata('design:type', Boolean, Account.prototype, 'active');
    Column()(Account.prototype, 'active');
    Reflect.defineMetadata('design:type', String, Account.prototype, 'name');
    Column()(Account.prototype, 'name');
    Column({ type: 'boolean' })(Account.prototype, 'archived');

    const seen = [];
    const provider = {
        async executeQuery(table, query) {
            seen.push(query.whereExpressions);
            return applyClientSideQuery([], query);
        }
    };

    await new QueryBuilder(Account, provider, 'Accounts').where(a => a.active).toList();
    await new QueryBuilder(Account, provider, 'Accounts').where(a => !a.archived).toList();
    await new QueryBuilder(Account, provider, 'Accounts').where(a => a.name).toList();

    assert.deepEqual(seen[0], [{ kind: 'comparison', field: 'active', operator: '=', value: true }]);
    assert.equal(seen[1].length, 1);
    assert.equal(seen[1][0].kind, 'logical');
    assert.deepEqual(seen[2], []);
});

// ─── Strings and collation ───────────────────────────────────────────────────

test('string inequality, NOT LIKE and relational string comparisons stay on the client', () => {
    assert.equal(parsePredicate(u => u.status !== 'open'), undefined);
    assert.equal(parsePredicate(u => u.status != 'open'), undefined);
    assert.equal(parsePredicate(u => u.name > 'B'), undefined);
    assert.equal(parsePredicate(u => 'B' < u.name), undefined);
    assert.equal(parsePredicate(u => !u.name.includes('a')), undefined);
    assert.equal(parsePredicate(u => !u.name.startsWith('a')), undefined);
});

test('string equality and LIKE are still translated (collation can only widen them)', () => {
    assert.deepEqual(parsePredicate(u => u.status === 'open'), { kind: 'comparison', field: 'status', operator: '=', value: 'open' });
    assert.deepEqual(parsePredicate(u => u.name.startsWith('ab')), { kind: 'comparison', field: 'name', operator: 'like', value: 'ab%' });
});

test('numeric inequality is still translated and keeps NULL rows', () => {
    const command = buildSelectSql('T', queryFor(u => u.age !== 18), pg);
    assert.equal(command.sql, 'SELECT * FROM "T" WHERE ("age" != $1 OR "age" IS NULL)');
});

test('numeric relational comparisons add IS NULL only when JS accepts null', () => {
    assert.equal(buildSelectSql('T', queryFor(u => u.age > 5), pg).sql, 'SELECT * FROM "T" WHERE "age" > $1');
    assert.equal(buildSelectSql('T', queryFor(u => u.age < 30), pg).sql, 'SELECT * FROM "T" WHERE ("age" < $1 OR "age" IS NULL)');
    assert.equal(buildSelectSql('T', queryFor(u => u.age <= 0), pg).sql, 'SELECT * FROM "T" WHERE ("age" <= $1 OR "age" IS NULL)');
    assert.equal(buildSelectSql('T', queryFor(u => u.age < 0), pg).sql, 'SELECT * FROM "T" WHERE "age" < $1');
});

// ─── Literals ────────────────────────────────────────────────────────────────

test('integer literals beyond Number.MAX_SAFE_INTEGER are not translated', () => {
    assert.equal(parsePredicate(u => u.id === 9007199254740993), undefined);
    assert.equal(parsePredicate(u => u.id === -9007199254740993), undefined);
    assert.deepEqual(parsePredicate(u => u.id === 9007199254740991), {
        kind: 'comparison', field: 'id', operator: '=', value: 9007199254740991
    });
});

test('number literals with a leading zero are not translated', () => {
    assert.equal(parsePredicate(new Function('u', 'return u.n === 010')), undefined);
    assert.deepEqual(parsePredicate(u => u.n === 0.5), { kind: 'comparison', field: 'n', operator: '=', value: 0.5 });
    assert.deepEqual(parsePredicate(u => u.n === 0), { kind: 'comparison', field: 'n', operator: '=', value: 0 });
});

// ─── Member access ───────────────────────────────────────────────────────────

test('nested member access is never used as a column name', () => {
    assert.equal(parsePredicate(u => u.address.city === 'Rio'), undefined);
    assert.equal(parsePredicate(u => u.name.length > 3), undefined);
    assert.equal(parseSelector(u => u.address.city), undefined);
    assert.deepEqual(parseSelector(u => u.name), { field: 'name' });
});
