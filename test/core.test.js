'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const orm = require('../dist');

const {
    applyClientSideQuery,
    Column,
    DbContext,
    DbContextOptions,
    Entity,
    getColumns,
    MigrationService,
    PrimaryKey,
    QueryBuilder,
    ScaffoldService,
    Transaction
} = orm;

/** Minimal provider: stores rows per table and answers QueryObjects client-side. */
function fakeProvider(tables = {}) {
    const calls = [];
    return {
        calls,
        tables,
        async connect() {},
        async disconnect() {},
        async executeQuery(sqlOrTable, paramsOrQuery) {
            calls.push([sqlOrTable, paramsOrQuery]);
            if (Array.isArray(paramsOrQuery) || paramsOrQuery === undefined) return [];
            return applyClientSideQuery(tables[sqlOrTable] ?? [], paramsOrQuery);
        },
        async saveChanges() {}
    };
}

const tempDirs = [];

function tempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'romatech-orm-test-'));
    tempDirs.push(dir);
    return dir;
}

test.after(() => {
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const pgDialect = {
    quoteIdentifier: id => `"${id.replace(/"/g, '""')}"`,
    parameter: i => `$${i + 1}`
};

class Ctx extends DbContext {
    constructor(provider) {
        super(new DbContextOptions().useProvider(provider));
    }
}

// ─── Ordering ────────────────────────────────────────────────────────────────

test('orderBy().thenBy() falls through to the next key when Date values are equal', async () => {
    const rows = [
        { id: 1, createdAt: new Date('2026-01-01T00:00:00Z'), name: 'b' },
        { id: 2, createdAt: new Date('2026-01-01T00:00:00Z'), name: 'a' },
        { id: 3, createdAt: new Date('2025-01-01T00:00:00Z'), name: 'c' }
    ];
    const builder = new QueryBuilder(Object, fakeProvider({ T: rows }), 'T');
    const result = await builder.orderBy(r => r.createdAt).thenBy(r => r.name).toList();
    assert.deepEqual(result.map(r => r.id), [3, 2, 1]);
});

test('orderBy() puts null values first in a consistent way', async () => {
    const rows = [{ id: 1, n: 'b' }, { id: 2, n: null }, { id: 3, n: 'a' }, { id: 4, n: null }];
    const builder = new QueryBuilder(Object, fakeProvider({ T: rows }), 'T');
    const asc = await builder.orderBy(r => r.n).thenBy(r => r.id).toList();
    assert.deepEqual(asc.map(r => r.id), [2, 4, 3, 1]);
});

// ─── all() with a projection ─────────────────────────────────────────────────

test('all() evaluates the predicate on entities even after select()', async () => {
    const rows = [{ id: 1, age: 30, name: 'x' }, { id: 2, age: 40, name: 'y' }];
    const builder = new QueryBuilder(Object, fakeProvider({ T: rows }), 'T');
    assert.equal(await builder.select(r => r.name).all(r => r.age > 18), true);
});

// ─── Transactions ────────────────────────────────────────────────────────────

test('Transaction uses commitTransaction/rollbackTransaction of a transactional provider', async () => {
    const make = () => {
        const provider = fakeProvider();
        provider.supportsTransactions = true;
        provider.events = [];
        provider.beginTransaction = async () => { provider.events.push('begin'); };
        provider.commitTransaction = async () => { provider.events.push('commit'); };
        provider.rollbackTransaction = async () => { provider.events.push('rollback'); };
        return provider;
    };

    const committed = make();
    const tx = await new Ctx(committed).beginTransaction();
    await tx.commit();
    assert.deepEqual(committed.events, ['begin', 'commit']);
    assert.equal(committed.calls.some(([sql]) => sql === 'COMMIT'), false);

    const rolledBack = make();
    const tx2 = await new Ctx(rolledBack).beginTransaction();
    await tx2.rollback();
    assert.deepEqual(rolledBack.events, ['begin', 'rollback']);
});

test('Transaction falls back to raw COMMIT/ROLLBACK for other providers', async () => {
    const provider = fakeProvider();
    const tx = new Transaction(provider);
    await tx.commit();
    assert.deepEqual(provider.calls.map(([sql]) => sql), ['COMMIT']);
});

// ─── Batch operations ────────────────────────────────────────────────────────

test('deleteWhere/updateWhere escape double quotes in the table name', async () => {
    const provider = fakeProvider();
    const db = new Ctx(provider);
    await db.deleteWhere('Users" WHERE 1=1; --', 'id = ?', [1]);
    await db.updateWhere('Users"x', 'a = 1', 'id = ?', [1]);
    assert.equal(provider.calls[0][0], 'DELETE FROM "Users"" WHERE 1=1; --" WHERE id = ?');
    assert.equal(provider.calls[1][0], 'UPDATE "Users""x" SET a = 1 WHERE id = ?');
});

test('deleteWhere/updateWhere quote the table name with the provider dialect when it has one', async () => {
    const provider = fakeProvider();
    provider.quoteIdentifier = id => `\`${id.replace(/`/g, '``')}\``;
    const db = new Ctx(provider);
    await db.deleteWhere('Us`ers', 'id = ?', [1]);
    await db.updateWhere('Users', 'a = 1', 'id = ?', [1]);
    assert.equal(provider.calls[0][0], 'DELETE FROM `Us``ers` WHERE id = ?');
    assert.equal(provider.calls[1][0], 'UPDATE `Users` SET a = 1 WHERE id = ?');
});

// ─── CRUD SQL ────────────────────────────────────────────────────────────────

test('INSERT/UPDATE never send @NotMapped properties of an entity instance', () => {
    class Customer {}
    Entity('Customers')(Customer);
    PrimaryKey()(Customer.prototype, 'id');
    Column()(Customer.prototype, 'name');
    orm.NotMapped(Customer.prototype, 'displayName');

    const customer = Object.assign(new Customer(), { id: 7, name: 'Ana', displayName: 'Ana (VIP)' });
    const insert = orm.buildInsertSql('Customers', customer, pgDialect);
    assert.equal(insert.sql, 'INSERT INTO "Customers" ("id", "name") VALUES ($1, $2)');
    assert.deepEqual(insert.params, [7, 'Ana']);

    const update = orm.buildUpdateSql('Customers', customer, 'id', pgDialect);
    assert.equal(update.sql, 'UPDATE "Customers" SET "name" = $1 WHERE "id" = $2');
    assert.deepEqual(update.params, ['Ana', 7]);

    // Plain objects keep the previous behaviour (every defined property)
    assert.equal(orm.buildInsertSql('T', { a: 1, b: 2 }, pgDialect).sql, 'INSERT INTO "T" ("a", "b") VALUES ($1, $2)');
});

// ─── Entity metadata ─────────────────────────────────────────────────────────

test('methods and accessors of an entity are not treated as columns', () => {
    class Person {
        fullName() { return 'x'; }
        get initials() { return 'x'; }
    }
    Entity('People')(Person);
    PrimaryKey()(Person.prototype, 'id');
    Column()(Person.prototype, 'name');
    assert.deepEqual(getColumns(Person).map(c => String(c.propertyKey)), ['id', 'name']);
});

test('entities registered by another copy of the package are visible (global CLI + local project)', () => {
    const distDir = path.dirname(require.resolve('../dist'));
    const saved = {};
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(distDir)) {
            saved[key] = require.cache[key];
            delete require.cache[key];
        }
    }
    let secondCopy;
    try {
        secondCopy = require('../dist');
    } finally {
        Object.assign(require.cache, saved);
    }
    assert.notEqual(secondCopy.getEntityMetadata, orm.getEntityMetadata);

    class CrossCopy {}
    Entity('CrossCopy')(CrossCopy);
    assert.equal(secondCopy.getEntityMetadata().get('CrossCopy'), CrossCopy);
});

// ─── Migrations ──────────────────────────────────────────────────────────────

test('a new migration only contains schema changes since the previous migrations', async () => {
    const dir = tempDir();
    const service = new MigrationService(fakeProvider(), dir);
    const read = name => JSON.parse(fs.readFileSync(path.join(dir, `${name}.migration.json`), 'utf-8'));

    class Order {}
    Entity('MigOrders')(Order);
    PrimaryKey()(Order.prototype, 'id');
    Column()(Order.prototype, 'total');

    const first = read(await service.createMigration('Initial'));
    const firstTables = first.up.filter(op => op.action === 'createTable').map(op => op.table);
    assert.ok(firstTables.includes('MigOrders'));

    // No model change → no migration is written (it would be an empty file)
    const before = fs.readdirSync(dir).length;
    await assert.rejects(service.createMigration('NoChanges'), /No model changes/);
    assert.equal(fs.readdirSync(dir).length, before);

    // An intentionally empty migration is still possible with explicit operations
    const empty = read(await service.createMigration('Manual', { up: [], down: [] }));
    assert.deepEqual(empty.up, []);

    // New column + new entity
    Column()(Order.prototype, 'status');
    class Invoice {}
    Entity('MigInvoices')(Invoice);
    PrimaryKey()(Invoice.prototype, 'id');

    const third = read(await service.createMigration('AddInvoice'));
    assert.deepEqual(
        third.up.map(op => `${op.action}:${op.table}:${op.column ? op.column.name : ''}`).sort(),
        ['addColumn:MigOrders:status', 'createTable:MigInvoices:']
    );
    assert.deepEqual(
        third.down.map(op => `${op.action}:${op.table}`).sort(),
        ['dropTable:MigInvoices', 'removeColumn:MigOrders']
    );
});

test('downgradeDatabase refuses a migration name from the database that is not a file in migrationsPath', async () => {
    const base = tempDir();
    const dir = path.join(base, 'migrations');
    fs.mkdirSync(dir);
    const outside = path.join(base, 'evil.migration.json');
    fs.writeFileSync(outside, JSON.stringify({ migrationName: 'evil', up: [], down: [{ action: 'dropTable', table: 'Users' }] }));

    const dropped = [];
    const provider = fakeProvider();
    provider.getMigrationHistory = async () => ['../evil'];
    provider.dropTable = async table => { dropped.push(table); };
    provider.removeMigration = async () => {};

    await assert.rejects(new MigrationService(provider, dir).downgradeDatabase(), /not a migration file/);
    assert.deepEqual(dropped, []);
});

test('downgradeDatabase still reverts the last migration recorded in the database', async () => {
    const dir = tempDir();
    const name = '20260101120000_AddThing';
    fs.writeFileSync(path.join(dir, `${name}.migration.json`), JSON.stringify({ migrationName: name, up: [], down: [{ action: 'dropTable', table: 'Things' }] }));
    const dropped = [];
    const removed = [];
    const provider = fakeProvider();
    provider.getMigrationHistory = async () => [name];
    provider.dropTable = async table => { dropped.push(table); };
    provider.removeMigration = async migration => { removed.push(migration); };

    await new MigrationService(provider, dir).downgradeDatabase();
    assert.deepEqual(dropped, ['Things']);
    assert.deepEqual(removed, [name]);
});

// ─── Scaffold ────────────────────────────────────────────────────────────────

test('scaffold keeps generated files inside outputDir and escapes names from the database', async () => {
    const base = tempDir();
    const root = path.join(base, 'project');
    const outputDir = path.join(root, 'entities');
    const contextDir = path.join(root, 'context');
    const provider = {
        async getTables() { return ['../../escaped', "x'); require('child_process'); ('"]; },
        async getColumnsForTable() {
            return [
                { name: 'id', primaryKey: true, tsType: 'number' },
                { name: "na'me", tsType: 'string' },
                { name: 'first name', tsType: 'string' }
            ];
        }
    };

    const log = console.log;
    console.log = () => {};
    try {
        await new ScaffoldService(provider).generateEntitiesFromDb(outputDir, contextDir, 'AppDbContext');
    } finally {
        console.log = log;
    }

    assert.equal(fs.existsSync(path.join(root, 'escaped.ts')), false);
    assert.equal(fs.existsSync(path.join(base, 'escaped.ts')), false);

    const files = fs.readdirSync(outputDir);
    assert.equal(files.length, 2);
    for (const file of files) {
        assert.match(file, /^[A-Za-z_$][\w$]*\.ts$/);
        const source = fs.readFileSync(path.join(outputDir, file), 'utf-8');
        assert.doesNotMatch(source, /require\('child_process'\)\s*;/);
        assert.match(source, /@Column\(\{ name: 'na\\'me' \}\)/);
        assert.match(source, /firstName!: string;/);
        assert.match(source, /export class [A-Za-z_$][\w$]* \{/);
    }
    assert.ok(fs.readFileSync(path.join(outputDir, files[0]), 'utf-8').includes("@Entity('"));
});

test('scaffold never lets two tables, a reserved name or the context share a class or file name', async () => {
    const root = tempDir();
    const outputDir = path.join(root, 'entities');
    const provider = {
        async getTables() { return ['Users', 'USERS', 'users', 'Entity', 'db_context', 'AppDbContext', 'Date', 'set']; },
        async getColumnsForTable() {
            return [
                { name: 'id', primaryKey: true, tsType: 'number' },
                { name: 'user name', tsType: 'string' },
                { name: 'userName', tsType: 'string' },
                { name: 'constructor', tsType: 'string' },
                { name: 'created', tsType: 'Date' }
            ];
        }
    };

    const log = console.log;
    console.log = () => {};
    try {
        await new ScaffoldService(provider).generateEntitiesFromDb(outputDir, outputDir, 'AppDbContext');
    } finally {
        console.log = log;
    }

    const files = fs.readdirSync(outputDir);
    assert.equal(files.length, 9, files.join(','));
    assert.equal(new Set(files.map(f => f.toLowerCase())).size, 9);

    const classes = files.filter(f => f !== 'AppDbContext.ts').map(f => f.replace(/\.ts$/, ''));
    for (const reserved of ['Entity', 'Column', 'PrimaryKey', 'DbContext', 'DbSet', 'AppDbContext', 'Date']) {
        assert.equal(classes.includes(reserved), false, `${reserved} must not be a generated class name`);
    }

    const users = fs.readFileSync(path.join(outputDir, 'Users.ts'), 'utf-8');
    const properties = [...users.matchAll(/^  ([A-Za-z_$][\w$]*)!:/gm)].map(m => m[1]);
    assert.equal(new Set(properties).size, properties.length, properties.join(','));
    assert.equal(properties.includes('constructor'), false);
    assert.match(users, /@Column\(\{ name: 'user name' \}\)\n  userName!: string;/);
    assert.match(users, /@Column\(\{ name: 'userName' \}\)\n  userName2!: string;/);

    const context = fs.readFileSync(path.join(outputDir, 'AppDbContext.ts'), 'utf-8');
    const getters = [...context.matchAll(/public get ([A-Za-z_$][\w$]*)\(\)/g)].map(m => m[1]);
    assert.equal(new Set(getters).size, getters.length, getters.join(','));
    for (const member of Object.getOwnPropertyNames(DbContext.prototype)) {
        assert.equal(getters.includes(member), false, `getter '${member}' would override DbContext`);
    }
});
