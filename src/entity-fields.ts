/**
 * @module entity-fields
 * @internal Not re-exported from the package entry point.
 *
 * Small metadata lookups shared by the query builder and the SQL builders.
 */

import 'reflect-metadata';
import { ColumnOptions, getNotMapped } from './decorators';

const BOOLEAN_COLUMN_TYPES = new Set(['boolean', 'bool', 'bit']);

/**
 * Returns the properties of `entityType` that are declared as boolean columns:
 * `@Column({ type: 'boolean' | 'bool' | 'bit' })`, or a decorated property
 * whose `design:type` is `Boolean` (requires `emitDecoratorMetadata`).
 *
 * Columns renamed with `@Column({ name })` are left out: the query translator
 * works with property names, which are not the column names in that case.
 */
export function getBooleanFields(entityType: unknown): string[] {
    if (typeof entityType !== 'function') {
        return [];
    }

    const columns: Array<{ propertyKey: string | symbol; options?: ColumnOptions }> =
        Reflect.getMetadata('entity:columns', entityType) || [];

    return columns
        .filter(column => typeof column.propertyKey === 'string')
        .filter(column => !column.options?.name || column.options.name === column.propertyKey)
        .filter(column => {
            const explicitType = column.options?.type;
            if (explicitType) {
                return BOOLEAN_COLUMN_TYPES.has(explicitType.toLowerCase());
            }
            return Reflect.getMetadata('design:type', entityType.prototype, column.propertyKey) === Boolean;
        })
        .map(column => column.propertyKey as string);
}

/**
 * Returns the `@NotMapped` property names of the class `entity` is an
 * instance of (empty for plain objects).
 */
export function getNotMappedKeys(entity: object): Set<string | symbol> {
    const ctor = (entity as { constructor?: unknown }).constructor;
    if (typeof ctor !== 'function' || ctor === Object) {
        return new Set();
    }
    return new Set(getNotMapped(ctor));
}
