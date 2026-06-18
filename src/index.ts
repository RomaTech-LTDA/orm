/**
 * @romatech/orm — A TypeScript ORM for Node.js inspired by Entity Framework Core.
 *
 * This is the main barrel export file. All public API surfaces are re-exported
 * from here so consumers can import everything from a single package:
 *
 * ```ts
 * import {
 *     DbContext,
 *     DbContextOptions,
 *     DbSet,
 *     Entity,
 *     Column,
 *     PrimaryKey,
 *     QueryBuilder,
 *     MigrationService,
 *     ScaffoldService,
 *     // ...
 * } from '@romatech/orm';
 * ```
 *
 * @packageDocumentation
 */

export * from './db-context.js';
export * from './decorators.js';
export * from './provider.js';
export * from './transaction.js';
export * from './query-builder.js';
export * from './query-expression.js';
export * from './sql-query-builder.js';
export * from './migration-service.js';
export * from './scaffold-service.js';
export * from './dbset.js';
export * from './connection-state-enum.js';
export * from './db-context-options.js';
