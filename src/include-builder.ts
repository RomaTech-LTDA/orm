/**
 * Builder for eager loading navigation properties.
 * Inspired by EF Core's .Include() / .ThenInclude().
 *
 * @example
 * ```ts
 * const orders = await db.orders
 *     .include(o => o.customer)
 *     .thenInclude(c => c.address)
 *     .include(o => o.items)
 *     .ToList();
 * ```
 *
 * Note: This builds the include chain. Actual loading depends on the provider.
 * SQL providers generate JOINs, Memory provider loads in-memory.
 */
export class IncludeBuilder<T> {
  private readonly _includes: IncludeEntry[] = [];

  /**
   * Includes a navigation property for eager loading.
   */
  include<K extends keyof T>(selector: (entity: T) => T[K]): IncludeBuilder<T> {
    const propName = this.extractPropertyName(selector);
    this._includes.push({ property: propName, thenIncludes: [] });
    return this;
  }

  /**
   * Chains a nested include on the last included property.
   */
  thenInclude<K extends string>(selector: (entity: any) => any): IncludeBuilder<T> {
    const propName = this.extractPropertyName(selector);
    const last = this._includes[this._includes.length - 1];
    if (last) {
      last.thenIncludes.push(propName);
    }
    return this;
  }

  /**
   * Returns the include chain as a flat list of dot-separated paths.
   * e.g., ['customer', 'customer.address', 'items']
   */
  getIncludes(): string[] {
    const result: string[] = [];
    for (const entry of this._includes) {
      result.push(entry.property);
      let path = entry.property;
      for (const nested of entry.thenIncludes) {
        path = `${path}.${nested}`;
        result.push(path);
      }
    }
    return result;
  }

  private extractPropertyName(selector: Function): string {
    const source = selector.toString();
    // Match patterns: x => x.prop, (x) => x.prop, x => x['prop']
    const match = source.match(/=>\s*\w+\.(\w+)/) ?? source.match(/\['(\w+)'\]/);
    return match?.[1] ?? 'unknown';
  }
}

interface IncludeEntry {
  property: string;
  thenIncludes: string[];
}
