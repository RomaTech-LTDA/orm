import 'reflect-metadata';

/**
 * Index configuration.
 */
export interface IndexOptions {
  /** Custom index name. Auto-generated if not provided. */
  name?: string;
  /** Whether this is a unique index. Default: false */
  unique?: boolean;
}

/**
 * Marks a property as indexed for faster queries.
 *
 * @example
 * ```ts
 * @Entity('Users')
 * class User {
 *     @PrimaryKey() id!: number;
 *     @Column() @Index() email!: string;
 *     @Column() @Index({ unique: true }) username!: string;
 * }
 * ```
 */
export function Index(options: IndexOptions = {}): PropertyDecorator {
  return (target, propertyKey) => {
    const ctor = target.constructor;
    let indexes: Array<{ propertyKey: string | symbol; options: IndexOptions }> =
      Reflect.getMetadata('entity:indexes', ctor) || [];
    indexes.push({ propertyKey, options });
    Reflect.defineMetadata('entity:indexes', indexes, ctor);
  };
}

/**
 * Defines a composite index on multiple columns.
 * Apply to the class.
 *
 * @example
 * ```ts
 * @Entity('Orders')
 * @CompositeIndex(['userId', 'createdAt'])
 * @CompositeIndex(['status', 'priority'], { unique: true, name: 'idx_status_priority' })
 * class Order { ... }
 * ```
 */
export function CompositeIndex(columns: string[], options: IndexOptions = {}): ClassDecorator {
  return (target) => {
    let composites: Array<{ columns: string[]; options: IndexOptions }> =
      Reflect.getMetadata('entity:compositeIndexes', target) || [];
    composites.push({ columns, options });
    Reflect.defineMetadata('entity:compositeIndexes', composites, target);
  };
}

/**
 * Returns all index metadata for an entity.
 */
export function getIndexes(target: Function): Array<{ propertyKey: string | symbol; options: IndexOptions }> {
  return Reflect.getMetadata('entity:indexes', target) || [];
}

/**
 * Returns all composite index metadata for an entity.
 */
export function getCompositeIndexes(target: Function): Array<{ columns: string[]; options: IndexOptions }> {
  return Reflect.getMetadata('entity:compositeIndexes', target) || [];
}
