/**
 * A global query filter that is automatically applied to all queries for a table.
 * Used for multi-tenancy, soft-delete auto-filtering, etc.
 */
export interface QueryFilter<T = any> {
  /** Unique name for this filter (used to enable/disable). */
  name: string;
  /** The filter predicate — entities not matching are excluded. */
  predicate: (entity: T) => boolean;
  /** Whether the filter is currently enabled. Default: true */
  enabled?: boolean;
}

/**
 * Registry for global query filters.
 * Filters are applied automatically to all queries on matching tables.
 *
 * @example
 * ```ts
 * // Multi-tenancy: only show current tenant's data
 * queryFilters.register('Users', {
 *     name: 'tenantFilter',
 *     predicate: (user) => user.tenantId === getCurrentTenantId(),
 * });
 *
 * // Soft delete: hide deleted records
 * queryFilters.register('Users', {
 *     name: 'softDelete',
 *     predicate: (user) => user.deletedAt == null,
 * });
 *
 * // Temporarily disable a filter
 * queryFilters.disable('Users', 'softDelete');
 * const allUsers = await db.users.ToList(); // includes deleted
 * queryFilters.enable('Users', 'softDelete');
 * ```
 */
export class QueryFilterRegistry {
  private readonly _filters = new Map<string, QueryFilter[]>();

  /**
   * Registers a global filter for a table.
   */
  register<T>(tableName: string, filter: QueryFilter<T>): void {
    const filters = this._filters.get(tableName) ?? [];
    filters.push({ ...filter, enabled: filter.enabled ?? true });
    this._filters.set(tableName, filters);
  }

  /**
   * Returns all enabled filters for a table.
   */
  getFilters(tableName: string): QueryFilter[] {
    return (this._filters.get(tableName) ?? []).filter(f => f.enabled !== false);
  }

  /**
   * Disables a specific filter by name.
   */
  disable(tableName: string, filterName: string): void {
    const filters = this._filters.get(tableName) ?? [];
    const filter = filters.find(f => f.name === filterName);
    if (filter) filter.enabled = false;
  }

  /**
   * Enables a specific filter by name.
   */
  enable(tableName: string, filterName: string): void {
    const filters = this._filters.get(tableName) ?? [];
    const filter = filters.find(f => f.name === filterName);
    if (filter) filter.enabled = true;
  }

  /**
   * Removes a filter entirely.
   */
  remove(tableName: string, filterName: string): void {
    const filters = this._filters.get(tableName) ?? [];
    this._filters.set(tableName, filters.filter(f => f.name !== filterName));
  }

  /**
   * Applies all enabled filters for a table to a result set.
   */
  apply<T>(tableName: string, entities: T[]): T[] {
    const filters = this.getFilters(tableName);
    if (filters.length === 0) return entities;
    return entities.filter(entity => filters.every(f => f.predicate(entity)));
  }
}

/** Global singleton filter registry. */
export const queryFilters = new QueryFilterRegistry();
