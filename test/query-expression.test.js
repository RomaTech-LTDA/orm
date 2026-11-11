'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePredicate, buildSelectSql } = require('../dist');
const { serverThenClient } = require('./helpers');

const pg = {
    quoteIdentifier: id => `"${id.replace(/"/g, '""')}"`,
    parameter: i => `$${i + 1}`
};

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
    { id: 1, age: 25, vip: false, active: true, status: 'open', path: 'a\\b', tag: '[x]y', note: 'line\nbreak' },
    { id: 2, age: 35, vip: true, active: false, status: 'archived', path: 'ab', tag: 'xy', note: 'x' },
    { id: 3, age: 20, vip: false, active: null, status: null, path: 'c', tag: 'z', note: 'line\\nbreak' },
    { id: 4, age: 40, vip: false, active: true, status: 'open', path: 'a\\bc', tag: 'q', note: 'y' }
];

const ids = list => list.map(row => row.id);

// ─── Server filter must never drop rows the JS predicate accepts ──────────────

const cases = {
    'block body with several statements': u => { if (u.vip) { return u.age > 30; } return u.age > 18; },
    'negated boolean member (NULL column)': u => !u.active,
    'string literal with backslash (LIKE escape)': u => u.path.includes('a\\b'),
    'string literal with \\n escape': u => u.note === 'line\nbreak',
    'strict !== undefined': u => u.status !== undefined,
    'relational comparison with null literal': u => u.age > null,
    'negated startsWith with _ (LIKE wildcard)': u => !u.path.startsWith('a_'),
    'negated includes with % (LIKE wildcard)': u => !u.path.includes('a%c')
};

for (const [name, predicate] of Object.entries(cases)) {
    test(`server WHERE does not lose rows: ${name}`, () => {
        assert.deepEqual(ids(serverThenClient(predicate, rows)), ids(rows.filter(predicate)));
    });
}

// ─── Parsing details ─────────────────────────────────────────────────────────

test('single-return block body is still translated', () => {
    assert.deepEqual(parsePredicate(u => { return u.age > 18; }), {
        kind: 'comparison', field: 'age', operator: '>', value: 18
    });
    assert.deepEqual(parsePredicate(function (u) { return u.age >= 21; }), {
        kind: 'comparison', field: 'age', operator: '>=', value: 21
    });
});

test('predicate without a parameter is never translated (outer variables are not columns)', () => {
    const flags = { active: true };
    assert.equal(parsePredicate(() => flags.active), undefined);
    assert.equal(parsePredicate(() => flags.active === true), undefined);
});

test('escaped quotes inside string literals are still translated', () => {
    assert.deepEqual(parsePredicate(u => u.name === 'it\'s'), {
        kind: 'comparison', field: 'name', operator: '=', value: "it's"
    });
});

test('LIKE pattern with [ is not translated (character class in SQL Server LIKE)', () => {
    assert.equal(parsePredicate(u => u.tag.startsWith('[x]')), undefined);
});

test('LIKE patterns without special characters are still translated', () => {
    assert.deepEqual(parsePredicate(u => u.email.endsWith('@gmail.com')), {
        kind: 'comparison', field: 'email', operator: 'like', value: '%@gmail.com'
    });
});

test('=== null / !== null still map to IS NULL / IS NOT NULL', () => {
    assert.equal(buildSelectSql('T', queryFor(u => u.status === null), pg).sql, 'SELECT * FROM "T" WHERE "status" IS NULL');
    assert.equal(buildSelectSql('T', queryFor(u => u.status !== null), pg).sql, 'SELECT * FROM "T" WHERE "status" IS NOT NULL');
});

test('!== with a number keeps NULL rows (JS null !== 2 is true)', () => {
    const command = buildSelectSql('T', queryFor(u => u.level !== 2), pg);
    assert.equal(command.sql, 'SELECT * FROM "T" WHERE ("level" != $1 OR "level" IS NULL)');
    assert.deepEqual(command.params, [2]);
});

test('negated boolean member (known boolean field) keeps NULL rows', () => {
    const command = buildSelectSql('T', queryFor(u => !u.active, { booleanFields: ['active'] }), pg);
    assert.equal(command.sql, 'SELECT * FROM "T" WHERE ("active" = $1 OR "active" IS NULL)');
    assert.deepEqual(command.params, [false]);
});

test('identifiers are quoted by the dialect (no injection through field names)', () => {
    const command = buildSelectSql('Us"ers', queryFor(u => u.age >= 18), pg);
    assert.equal(command.sql, 'SELECT * FROM "Us""ers" WHERE "age" >= $1');
    assert.deepEqual(command.params, [18]);
});
