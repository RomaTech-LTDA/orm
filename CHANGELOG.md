# Changelog

All notable changes to @romatech/orm will be documented in this file.

## [2.0.0] - 2026-06-26

### Added
- **Transactions**: `beginTransaction()`, `commit()`, `rollback()`
- **Bulk operations**: `bulkInsert()`, `bulkUpdate()`, `upsert()`
- **Raw SQL**: `rawQuery<T>(sql, params)`, `rawExecute(sql, params)`
- **Batch operations**: `deleteWhere()`, `updateWhere()` (no entity loading)
- **Connection retry**: `withRetryPolicy({ maxRetries, backoff })`
- **Connection pooling**: `withPooling({ min, max, idleTimeoutMs })`
- **@Version decorator**: optimistic concurrency control
- **@Index, @CompositeIndex**: database index declarations
- **@SoftDelete()**: auto-filter deleted entities
- **Composite primary keys**: `@PrimaryKey()` on multiple properties
- **Global query filters**: `QueryFilterRegistry` for multi-tenancy
- **Change tracker**: `ChangeTracker<T>` with dirty field detection
- **Eager loading**: `IncludeBuilder` with `.include().thenInclude()`
- **IDbProvider.ping?()**: health check method
- **IDbProvider.bulkInsert?/bulkUpdate?/upsert?**: optional bulk ops

### Providers
- SQLite provider (`@romatech/orm-providers-sqlite`) — sql.js WASM, zero native deps
- MongoDB provider (`@romatech/orm-providers-mongodb`) — full CRUD + transactions + server-side query translation
