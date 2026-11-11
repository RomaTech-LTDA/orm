# @romatech/orm

<p align="center">
  <img src="logo.png" width="120" alt="RomaTech ORM" />
</p>

<p align="center">
  A TypeScript ORM for Node.js inspired by <strong>Entity Framework Core</strong>.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@romatech/orm"><img src="https://img.shields.io/npm/v/@romatech/orm" alt="npm version"></a>
  <a href="https://github.com/RomaTech-LTDA/orm/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@romatech/orm" alt="license"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="node version">
</p>

---

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Entities & Decorators](#entities--decorators)
- [DbContext](#dbcontext)
- [DbSet & CRUD](#dbset--crud)
- [QueryBuilder (LINQ-style)](#querybuilder-linq-style)
- [Migrations](#migrations)
- [Scaffold (Database-First)](#scaffold-database-first)
- [Providers](#providers)
- [CLI](#cli)
- [Configuration](#configuration)
- [API Reference](#api-reference)
- [Known limitations](#known-limitations)
- [License](#license)

---

## Features

| Feature | Description |
|---------|-------------|
| **Decorator-based entities** | `@Entity`, `@Column`, `@PrimaryKey`, `@NotMapped`, `@Version`, `@Index`, `@SoftDelete` (metadata only), relationships |
| **DbContext** | Unit-of-Work pattern with `saveChanges()` |
| **DbSet\<T\>** | Typed sets with CRUD, change tracking, and fluent queries |
| **QueryBuilder** | LINQ-style API: `where`, `select`, `orderBy`, `skip`, `take`, `first`, `single`, `any`, `all`, `count` |
| **Transactions** | `beginTransaction()`, `commit()`, `rollback()` for atomic operations |
| **Bulk operations** | `bulkInsert()`, `bulkUpdate()`, `upsert()` for high-performance writes |
| **Raw SQL** | `rawQuery<T>(sql, params)` for complex queries |
| **Batch operations** | `deleteWhere()`, `updateWhere()` without loading entities |
| **Change tracking** | Dirty field detection, entity state (Added/Modified/Deleted) |
| **Global query filters** | `QueryFilterRegistry` for multi-tenancy / soft-delete filters, applied explicitly with `queryFilters.apply()` (not automatic) |
| **Connection resilience** | Retry policy with exponential backoff, connection pooling |
| **Eager loading** | `IncludeBuilder` with `.include().thenInclude()` |
| **Migrations** | Create, apply, and revert schema changes via JSON migration files |
| **Scaffold** | Reverse-engineer entities and DbContext from an existing database |
| **Multiple providers** | SQL Server, MySQL, PostgreSQL, Oracle, MongoDB, SQLite, In-Memory |
| **Dual naming** | Both camelCase (`where`, `toList`) and PascalCase (`Where`, `ToList`) |

---

## Installation

```bash
npm install @romatech/orm reflect-metadata
```

Then install the provider for your database:

```bash
# Pick one:
npm install @romatech/orm-providers-mssql    # SQL Server
npm install @romatech/orm-providers-mysql    # MySQL / MariaDB
npm install @romatech/orm-providers-pgsql    # PostgreSQL
npm install @romatech/orm-providers-oracle   # Oracle
npm install @romatech/orm-providers-mongodb  # MongoDB (NoSQL)
npm install @romatech/orm-providers-sqlite   # SQLite (local/embedded)
npm install @romatech/orm-providers-memory   # In-Memory (testing)
```

### TypeScript Configuration

Add to your `tsconfig.json`:

```json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

### Entry Point

Import `reflect-metadata` **once** at your application entry point (before anything else):

```ts
import 'reflect-metadata';
```

---

## Quick Start

```ts
import 'reflect-metadata';
import { Entity, PrimaryKey, Column, DbContext, DbContextOptions } from '@romatech/orm';
import { MemoryProvider } from '@romatech/orm-providers-memory';

// 1. Define an entity
@Entity('Users')
class User {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;

    @Column()
    email!: string;
}

// 2. Create a context
class AppDbContext extends DbContext {
    users = this.set(User);

    constructor() {
        super(new DbContextOptions().useProvider(new MemoryProvider()));
    }
}

// 3. Use it
const db = new AppDbContext();

db.users.add({ id: 1, name: 'Alice', email: 'alice@example.com' });
await db.saveChanges();

const alice = await db.users.FirstOrDefault(u => u.name === 'Alice');
console.log(alice); // { id: 1, name: 'Alice', email: 'alice@example.com' }
```

> **Known limitation — read before mapping columns.** `@Column({ name })` is
> only used by migrations and scaffold. CRUD (`add`, `update`, `remove`,
> `find`), queries and results still use the **property name** as the column
> name, so an entity whose property name differs from its column name does not
> work with the SQL providers. Keep property names equal to column names. See
> [Known limitations](#known-limitations).

---

## Entities & Decorators

### `@Entity(tableName?)`

Marks a class as a database entity. The optional `tableName` parameter specifies the database table name (defaults to the class name).

```ts
@Entity('Products')
class Product { ... }
```

### `@PrimaryKey(options?)`

Marks a property as the primary key.

```ts
@PrimaryKey()
id!: number;
```

### `@Column(options?)`

Marks a property as a mapped column.

```ts
@Column({ name: 'user_name', length: 255, nullable: true })
name!: string;
```

**ColumnOptions:**
| Option | Type | Description |
|--------|------|-------------|
| `name` | `string` | Database column name (defaults to property name). **Migrations and scaffold only** — not applied by CRUD or queries (see [Known limitations](#known-limitations)) |
| `type` | `string` | Explicit type override |
| `nullable` | `boolean` | Whether the column allows NULL |
| `unique` | `boolean` | Whether the column has a UNIQUE constraint |
| `default` | `any` | Default value |
| `length` | `number` | Maximum length for string columns |

### `@NotMapped`

Excludes a property from the database mapping: it is not a migration column,
and `buildInsertSql` / `buildUpdateSql` (used by the SQL providers) leave it
out when the entity is an instance of the decorated class. Plain object
literals carry no metadata, so every defined property of them is sent; the
MongoDB and In-Memory providers store the whole object.

```ts
@NotMapped
temporaryField?: string;
```

### Relationships

```ts
@OneToMany(() => Order, 'user')
orders!: Order[];

@ManyToOne(() => User)
user!: User;

@OneToOne(() => Profile, 'user')
profile!: Profile;

@ManyToMany(() => Tag, 'products')
tags!: Tag[];
```

---

## DbContext

The `DbContext` is the central class for database interaction. It manages the connection lifecycle, tracks changes, and exposes typed `DbSet`s.

```ts
class AppDbContext extends DbContext {
    users = this.set(User);
    products = this.set(Product);

    constructor() {
        super(
            new DbContextOptions()
                .useProvider(new MsSqlProvider({ ... }))
                .withConnectionString('Server=localhost;Database=MyDb;...')
        );
    }
}
```

### Connection Lifecycle

| Method | Description |
|--------|-------------|
| `connect()` | Opens the connection (called automatically by default) |
| `disconnect()` | Closes the connection |
| `connectionState` | Current state: `Disconnected`, `Connecting`, `Connected`, `Disconnecting`, `Error` |

Auto-connect is enabled by default. To disable:

```ts
new DbContextOptions().useProvider(provider).disableAutoConnect();
// You must now call db.connect() manually before any operation.
```

### `saveChanges()`

Persists all pending add/update/remove operations across all DbSets.

```ts
db.users.add(newUser);
db.products.remove(oldProduct);
await db.saveChanges(); // Both operations are flushed here
```

---

## DbSet & CRUD

### Adding Entities

```ts
db.users.add({ id: 1, name: 'Alice', email: 'alice@example.com', age: 30 });
db.users.addRange([user1, user2, user3]);
await db.saveChanges();
```

### Updating Entities

```ts
const user = await db.users.FirstOrDefault(u => u.id === 1);
user!.name = 'Updated Name';
db.users.update(user!);
await db.saveChanges();
```

### Removing Entities

```ts
db.users.remove(user);
db.users.removeRange([user1, user2]);
await db.saveChanges();
```

### Fetching All

```ts
const allUsers = await db.users.ToList();
```

---

## QueryBuilder (LINQ-style)

The QueryBuilder provides a fluent, chainable API inspired by C# LINQ.

### Filtering — `where()`

```ts
// Simple comparison
const adults = await db.users.where(u => u.age >= 18).toList();

// String methods (translated to SQL LIKE)
const results = await db.users.where(u => u.name.startsWith('A')).toList();
const search = await db.users.where(u => u.email.includes('@gmail')).toList();

// Multiple conditions (AND)
const active = await db.users
    .where(u => u.isActive)
    .where(u => u.age > 21)
    .toList();

// Combined with OR / AND (inside one predicate)
const filtered = await db.users
    .where(u => u.role === 'admin' || u.role === 'moderator')
    .toList();
```

### What runs on the database

The SQL providers send a parameterised `WHERE` to the database and then
re-apply the original JavaScript predicate to the rows that come back, so the
result always follows JavaScript semantics. The generated `WHERE` may return
more rows than the predicate accepts, but it is built never to return fewer.

This assumes the driver returns each column with the JavaScript type of the
literal it is compared with. Some drivers do not: node-postgres returns
`bigint` and `numeric` columns as strings, and mysql2 returns `BOOLEAN`
(`TINYINT(1)`) columns as `0`/`1`. On such columns, `!==` / `!=` with a number
or boolean follows SQL (`u.id !== 5` does not return the row whose id is `5`,
although `'5' !== 5` is `true` in JavaScript), and `===` with a number or
boolean matches no row in memory. Compare such columns with literals of the
type the driver returns, or configure the driver's type parsing.

Translated to SQL (literal values only, on direct properties of the lambda
parameter):

- `===` / `==` with a string, number, boolean or `null`;
- `!==` / `!=` with a number or boolean → `(col != @p OR col IS NULL)`, and with `null` → `IS NOT NULL`;
- `<`, `<=`, `>`, `>=` with a number (plus `OR col IS NULL` when JavaScript accepts `null`, e.g. `u.age < 30`, because `null < 30` is `true`);
- `.includes()`, `.startsWith()`, `.endsWith()` → `LIKE` (not when the value contains `\` or `[`);
- bare boolean members `u.active` / `!u.active` **only** when the property is
  declared boolean (`@Column() active!: boolean` with `emitDecoratorMetadata`,
  or `@Column({ type: 'boolean' })`);
- `&&`, `||` and parentheses combining the above.

Evaluated in memory, after loading the rows of the table:

- outer variables, function calls, computed values and block bodies with more than one statement;
- bare members of non-boolean properties (`u => u.name` is truthiness, not `name = true`);
- string `!==`, `<`, `<=`, `>`, `>=` and every negated `.includes()` / `.startsWith()` / `.endsWith()`:
  under a case-insensitive collation (the SQL Server and MySQL default) or with trailing-space padding
  the database would reject rows JavaScript accepts (`'ABC' !== 'abc'`);
- nested members (`u.address.city`, `u.name.length`);
- integer literals beyond `Number.MAX_SAFE_INTEGER`, number literals with a leading zero, and string literals with escapes other than `\'`, `\"`, `\\`.

String equality and `LIKE` are still sent to the database: a case-insensitive
collation can only make them match *more* rows, which the in-memory pass then
removes.

### Projection — `select()`

```ts
// Single field
const names = await db.users.select(u => u.name).toList(); // string[]

// Object projection
const dtos = await db.users
    .select(u => ({ id: u.id, name: u.name }))
    .toList(); // { id: number; name: string }[]
```

### Ordering — `orderBy()`, `orderByDescending()`, `thenBy()`

```ts
const sorted = await db.users
    .orderBy(u => u.lastName)
    .thenBy(u => u.firstName)
    .toList();

const newest = await db.users
    .orderByDescending(u => u.createdAt)
    .toList();
```

### Paging — `skip()` / `take()`

```ts
const page3 = await db.users
    .orderBy(u => u.id)
    .skip(40)
    .take(20)
    .toList();
```

### Terminal Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `toList()` / `ToList()` | `Promise<T[]>` | Execute and return all matching rows |
| `toArray()` / `ToArray()` | `Promise<T[]>` | Alias for `toList()` |
| `first(predicate?)` / `First()` | `Promise<T>` | First match or throws |
| `firstOrDefault(predicate?)` / `FirstOrDefault()` | `Promise<T \| undefined>` | First match or undefined |
| `single(predicate?)` / `Single()` | `Promise<T>` | Exactly one or throws |
| `singleOrDefault(predicate?)` / `SingleOrDefault()` | `Promise<T \| undefined>` | Exactly one or undefined |
| `any(predicate?)` / `Any()` | `Promise<boolean>` | Whether any row matches |
| `all(predicate)` / `All()` | `Promise<boolean>` | Whether every row matches |
| `count(predicate?)` / `Count()` | `Promise<number>` | Number of matching rows |

### Include (Eager Loading)

```ts
const orders = await db.orders
    .include(o => o.customer)
    .thenInclude(c => c.address)
    .toList();
```

---

## Transactions

Wrap multiple operations in a transaction for atomicity:

```ts
const tx = await db.beginTransaction();
try {
    db.users.add(newUser);
    db.orders.add(newOrder);
    await db.saveChanges();
    await tx.commit();
} catch (err) {
    await tx.rollback();
    throw err;
}
```

Transaction support depends on the provider (and on its version — check the
provider's README; a SQL Server provider that does not implement
`ITransactionalProvider` cannot open a transaction):

| Provider | Transactions |
|----------|-------------|
| SQL Server | ✅ Full support |
| PostgreSQL | ✅ Full support |
| MySQL | ✅ Full support |
| Oracle | ✅ Full support |
| MongoDB | ✅ Requires replica set |
| In-Memory | ❌ Not supported |

---

## Migrations

### Creating a Migration

```ts
import { MigrationService } from '@romatech/orm';

const service = new MigrationService(provider, './migrations');
const name = await service.createMigration('AddUsersTable');
// Creates: migrations/20260605120000_AddUsersTable.migration.json
```

### Applying Migrations

```ts
await service.updateDatabase(); // Apply all pending
await service.updateDatabase('20260605120000_AddUsersTable'); // Apply up to this one
```

### Reverting Migrations

```ts
await service.downgradeDatabase(); // Revert last
await service.downgradeDatabase('20260605120000_Initial'); // Revert everything after this
```

### How migrations are generated

`createMigration(name)` without explicit operations compares the entity metadata with the schema described by the migration files already in the folder:

- entities whose table does not exist yet → `createTable` (down: `dropTable`);
- new properties of existing tables → `addColumn` (down: `removeColumn`).

Removed entities or columns, renames and type changes are **not** detected — pass them explicitly with `createMigration(name, { up, down })`. Down operations run in reverse order.

When nothing changed, `createMigration(name)` writes no file and rejects with a
"No model changes" error. To create an intentionally empty migration, pass
explicit operations: `createMigration(name, { up: [], down: [] })`.

`downgradeDatabase()` only reverts migrations whose file is in the migrations
folder; a name recorded in the database that is not a file there (for example
`../x`) is rejected before anything runs.

> **⚠️ Migrations generated by 2.0.0 — review them before reverting.** In
> 2.0.0, every auto-generated migration re-created *all* tables, so its `down`
> drops **every table** of the model, not only the ones it introduced.
> Reverting such a migration (`downgradeDatabase()` / `orm downgrade-database`)
> deletes all your data. Before reverting, open each `*.migration.json` created
> with 2.0.0 and remove from `up` and `down` the operations for tables that an
> earlier migration already created (or replace the file with explicit
> operations).

### Migration File Format

```json
{
  "migrationName": "20260605120000_AddUsersTable",
  "up": [
    {
      "action": "createTable",
      "table": "Users",
      "columns": [
        { "name": "id", "primaryKey": true, "tsType": "number" },
        { "name": "name", "tsType": "string" },
        { "name": "email", "tsType": "string" }
      ]
    }
  ],
  "down": [
    { "action": "dropTable", "table": "Users" }
  ]
}
```

---

## Scaffold (Database-First)

Reverse-engineer entity classes from an existing database:

```ts
import { ScaffoldService } from '@romatech/orm';

const service = new ScaffoldService(provider);
await service.generateEntitiesFromDb('src/entities', 'src/context', 'AppDbContext');
```

This generates decorated entity files and a DbContext with typed DbSets for each table found in the database.

Names read from the database are turned into valid identifiers. Class (and
file) names are unique ignoring case, never reuse an imported or global name
(`Entity`, `DbContext`, `Date`, …) or the context name, and get a numeric
suffix when taken (`Users`, `USERS2`). Properties that would collide
(`user name` and `userName`) get a suffix too, and `DbSet` getters never
override a `DbContext` member. Columns whose property name differs from the
column name are emitted with `@Column({ name })` — see
[Known limitations](#known-limitations): such entities do not work with CRUD
yet, so rename the property or the column before using them.

---

## Providers

| Package | Database | Install |
|---------|----------|---------|
| `@romatech/orm-providers-mssql` | SQL Server | `npm i @romatech/orm-providers-mssql` |
| `@romatech/orm-providers-mysql` | MySQL / MariaDB | `npm i @romatech/orm-providers-mysql` |
| `@romatech/orm-providers-pgsql` | PostgreSQL | `npm i @romatech/orm-providers-pgsql` |
| `@romatech/orm-providers-oracle` | Oracle Database | `npm i @romatech/orm-providers-oracle` |
| `@romatech/orm-providers-mongodb` | MongoDB (NoSQL) | `npm i @romatech/orm-providers-mongodb` |
| `@romatech/orm-providers-sqlite` | SQLite (local/embedded) | `npm i @romatech/orm-providers-sqlite` |
| `@romatech/orm-providers-memory` | In-Memory (testing) | `npm i @romatech/orm-providers-memory` |

---

## CLI

```bash
npm install -g @romatech/orm-cli
```

| Command | Description |
|---------|-------------|
| `orm migration:create <name>` | Create a migration file |
| `orm update-database` | Apply pending migrations |
| `orm downgrade-database` | Revert last migration |
| `orm scaffold` | Generate entities from DB |

See [@romatech/orm-cli README](https://www.npmjs.com/package/@romatech/orm-cli) for full documentation.

---

## Configuration

### DbContextOptions

| Method | Description |
|--------|-------------|
| `useProvider(provider, connectionString?)` | Set the database provider |
| `withConnectionString(str)` | Override the connection string |
| `disableAutoConnect()` | Require manual `connect()` calls |

### SqlDialect (for provider authors)

Each provider defines a `SqlDialect` object:

```ts
interface SqlDialect {
    quoteIdentifier(identifier: string): string; // e.g. [col] or `col` or "col"
    parameter(index: number): string;            // e.g. @param0, $1, ?, :1
}
```

Providers should also implement the optional `IDbProvider.quoteIdentifier()`
(usually `id => dialect.quoteIdentifier(id)`): `DbContext.deleteWhere()` and
`updateWhere()` use it to quote the table name, and fall back to ANSI double
quotes without it (which MySQL rejects unless `ANSI_QUOTES` is enabled).

---

## API Reference

### Core Classes

- `DbContext` — Base class for database contexts
- `DbContextOptions` — Configuration builder
- `DbSet<T>` — Typed entity collection with CRUD and queries
- `QueryBuilder<T, TResult>` — Fluent query builder

### Decorators

- `@Entity(tableName?)` — Mark a class as an entity
- `@PrimaryKey(options?)` — Mark the primary key property
- `@Column(options?)` — Mark a column property
- `@NotMapped` — Exclude a property
- `@OneToMany`, `@ManyToOne`, `@OneToOne`, `@ManyToMany` — Relationships

### Services

- `MigrationService` — Create, apply, and revert migrations
- `ScaffoldService` — Reverse-engineer entities from a database

### SQL Generation

- `buildSelectSql()` — Generate parameterised SELECT queries
- `buildInsertSql()` — Generate INSERT statements
- `buildUpdateSql()` — Generate UPDATE statements
- `buildDeleteSql()` — Generate DELETE statements
- `applyClientSideQuery()` — Client-side filter/sort/page/project

### Expression Types

- `QueryExpression` — Discriminated union for WHERE tree nodes
- `QueryObject<T, TResult>` — Complete query descriptor
- `SqlDialect` — Identifier quoting and parameter style

---

## Known limitations

- **`@Column({ name })` is not applied by CRUD or queries.** Only migrations
  and scaffold use it. `add`/`update`/`remove`/`find`, `where()` translation
  and query results use property names as column names. Keep property names
  equal to column names until entity ↔ row mapping is implemented.
- **`@SoftDelete` and `QueryFilterRegistry` are not automatic.** `remove()`
  issues a real `DELETE`, and filters must be applied with
  `queryFilters.apply()`. Do not rely on them alone for tenant isolation.
- **Queries can load more rows than they return.** The shared SQL builder only
  sends the translated `WHERE` (and `ORDER BY`): untranslated predicates, `skip()`,
  `take()`, `count()` and `any()` are applied in memory to the rows it
  returns (a query with no translated predicate reads the whole table).
- **Migrations** do not detect removed or renamed entities/columns or type
  changes; `updateDatabase()` does not run inside a transaction.
- **Raw SQL** in `rawQuery`, `rawExecute`, `deleteWhere` and `updateWhere` is
  sent as written: pass values in `params`, never concatenated.

---

## License

MIT © [RomaTech / Leandro Romanelli](https://github.com/RomaTech-LTDA)
