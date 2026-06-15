/**
 * @module decorators
 *
 * Entity metadata decorators inspired by EF Core's data annotations.
 *
 * Use these decorators on your model classes to define the database mapping:
 *
 * ```ts
 * @Entity('Users')
 * class User {
 *     @PrimaryKey()
 *     id!: number;
 *
 *     @Column({ length: 100 })
 *     name!: string;
 *
 *     @NotMapped
 *     temporaryField?: string;
 * }
 * ```
 */

import 'reflect-metadata';

type EntityConstructor<T = any> = new (...args: any[]) => T;

/** Global registry of all decorated entity classes, keyed by class name. */
const registeredEntities = new Map<string, EntityConstructor>();

// ─── @Entity ─────────────────────────────────────────────────────────────────────

/**
 * Marks a class as a database entity and optionally specifies the table name.
 *
 * @param tableName - The database table name. Defaults to the class name.
 *
 * @example
 * ```ts
 * @Entity('Users')
 * class User { ... }
 * ```
 */
export const Entity = (tableName?: string): ClassDecorator => {
    return (target: Function) => {
        registeredEntities.set(target.name, target as EntityConstructor);
        Reflect.defineMetadata('entity:name', tableName || target.name, target);
        if (!Reflect.hasMetadata('entity:columns', target)) {
            Reflect.defineMetadata('entity:columns', [], target);
        }
    };
};

// ─── Column Options ──────────────────────────────────────────────────────────────

/**
 * Configuration options for a column decorator.
 */
export interface ColumnOptions {
    /** Database column name (defaults to the property name). */
    name?: string;

    /** Explicit TypeScript/database type (e.g. 'number', 'VARCHAR(100)'). */
    type?: string;

    /** Whether the column allows NULL values. */
    nullable?: boolean;

    /** Whether the column has a UNIQUE constraint. */
    unique?: boolean;

    /** Default value for the column. */
    default?: any;

    /** Maximum length (for string/varchar columns). */
    length?: number;
}

/**
 * Registers a property as a column in the entity metadata.
 * Called internally by @Column, @PrimaryKey, and relation decorators.
 */
function ensureColumnMetadata(target: any, propertyKey: string | symbol, options: ColumnOptions = {}) {
    const ctor = target.constructor;
    let columns = Reflect.getMetadata('entity:columns', ctor) || [];
    if (!columns.some((c: any) => c.propertyKey === propertyKey)) {
        columns.push({ propertyKey, options });
        Reflect.defineMetadata('entity:columns', columns, ctor);
    }
}

// ─── @Column ─────────────────────────────────────────────────────────────────────

/**
 * Marks a property as a mapped database column.
 *
 * @param options - Optional column configuration.
 *
 * @example
 * ```ts
 * @Column({ name: 'user_name', length: 255 })
 * name!: string;
 * ```
 */
export const Column = (options: ColumnOptions = {}): PropertyDecorator => (target, propertyKey) => {
    ensureColumnMetadata(target, propertyKey, options);
};

// ─── @PrimaryKey ─────────────────────────────────────────────────────────────────

/**
 * Marks a property as the primary key of the entity.
 * Also registers it as a column with a unique constraint.
 *
 * @param options - Optional column configuration.
 *
 * @example
 * ```ts
 * @PrimaryKey()
 * id!: number;
 * ```
 */
export const PrimaryKey = (options: ColumnOptions = {}): PropertyDecorator => (target, propertyKey) => {
    Reflect.defineMetadata('entity:primaryKey', propertyKey, target.constructor);
    ensureColumnMetadata(target, propertyKey, { ...options, unique: true });
};

// ─── @NotMapped ──────────────────────────────────────────────────────────────────

/**
 * Excludes a property from database mapping.
 * Useful for computed or transient fields.
 *
 * @example
 * ```ts
 * @NotMapped
 * fullName?: string;
 * ```
 */
export const NotMapped: PropertyDecorator = (target, propertyKey) => {
    const ctor = target.constructor;
    let notMapped = Reflect.getMetadata('entity:notMapped', ctor) || [];
    notMapped.push(propertyKey);
    Reflect.defineMetadata('entity:notMapped', notMapped, ctor);
};

// ─── Relation Options ────────────────────────────────────────────────────────────

/**
 * Configuration for relationship decorators.
 */
export interface RelationOptions {
    /** Factory returning the target entity type (avoids circular imports). */
    target: () => Function;

    /** Name of the inverse navigation property on the related entity. */
    inverse?: string;

    /** Whether to cascade operations (insert/update/delete). */
    cascade?: boolean;

    /** Whether to eager-load this relation by default. */
    eager?: boolean;
}

// ─── @OneToMany ──────────────────────────────────────────────────────────────────

/**
 * Defines a one-to-many relationship.
 *
 * @param targetType - Factory returning the related entity class.
 * @param inverse - Property name on the child that points back.
 * @param options - Additional relation options.
 */
export const OneToMany = (targetType: () => Function, inverse: string, options: Partial<RelationOptions> = {}): PropertyDecorator => {
    return (target, propertyKey) => {
        Reflect.defineMetadata('relation:oneToMany', { targetType, inverse, ...options }, target, propertyKey);
        ensureColumnMetadata(target, propertyKey);
    };
};

// ─── @ManyToOne ──────────────────────────────────────────────────────────────────

/**
 * Defines a many-to-one relationship (foreign key side).
 *
 * @param targetType - Factory returning the parent entity class.
 * @param options - Additional relation options.
 */
export const ManyToOne = (targetType: () => Function, options: Partial<RelationOptions> = {}): PropertyDecorator => {
    return (target, propertyKey) => {
        Reflect.defineMetadata('relation:manyToOne', { targetType, ...options }, target, propertyKey);
        ensureColumnMetadata(target, propertyKey);
    };
};

// ─── @OneToOne ───────────────────────────────────────────────────────────────────

/**
 * Defines a one-to-one relationship.
 *
 * @param targetType - Factory returning the related entity class.
 * @param inverse - Property name on the other side (optional).
 * @param options - Additional relation options.
 */
export const OneToOne = (targetType: () => Function, inverse?: string, options: Partial<RelationOptions> = {}): PropertyDecorator => {
    return (target, propertyKey) => {
        Reflect.defineMetadata('relation:oneToOne', { targetType, inverse, ...options }, target, propertyKey);
        ensureColumnMetadata(target, propertyKey);
    };
};

// ─── @ManyToMany ─────────────────────────────────────────────────────────────────

/**
 * Defines a many-to-many relationship.
 *
 * @param targetType - Factory returning the related entity class.
 * @param inverse - Property name on the other side.
 * @param options - Additional relation options.
 */
export const ManyToMany = (targetType: () => Function, inverse: string, options: Partial<RelationOptions> = {}): PropertyDecorator => {
    return (target, propertyKey) => {
        Reflect.defineMetadata('relation:manyToMany', { targetType, inverse, ...options }, target, propertyKey);
        ensureColumnMetadata(target, propertyKey);
    };
};

// ─── Metadata Access Functions ───────────────────────────────────────────────────

/**
 * Returns the global registry of all decorated entity classes.
 */
export function getEntityMetadata() {
    return registeredEntities;
}

/**
 * Returns the table name configured via `@Entity(tableName)`.
 * Returns undefined if the class was not decorated.
 */
export function getTableName(target: Function): string | undefined {
    return Reflect.getMetadata('entity:name', target);
}

/**
 * Returns all column metadata for an entity, excluding @NotMapped properties.
 * Also includes any instance properties not explicitly decorated (convention-based).
 */
export function getColumns(target: Function): Array<{ propertyKey: string | symbol; options: ColumnOptions }> {
    const columns: Array<{ propertyKey: string | symbol; options: ColumnOptions }> =
        Reflect.getMetadata('entity:columns', target) || [];
    const notMapped: (string | symbol)[] = Reflect.getMetadata('entity:notMapped', target) || [];

    // Convention: include all own properties that aren't explicitly mapped or excluded
    const instance = Object.create(target.prototype);
    const allProps = new Set<string | symbol>([
        ...Object.getOwnPropertyNames(instance),
        ...Object.getOwnPropertyNames(target.prototype)
    ]);

    for (const key of allProps) {
        if (
            key !== 'constructor' &&
            !columns.some(c => c.propertyKey === key) &&
            !notMapped.includes(key)
        ) {
            columns.push({ propertyKey: key, options: {} });
        }
    }

    return columns.filter(c => !notMapped.includes(c.propertyKey));
}

/**
 * Returns the property marked as `@PrimaryKey` for the given entity.
 */
export function getPrimaryKey(target: Function): string | symbol | undefined {
    return Reflect.getMetadata('entity:primaryKey', target);
}

/**
 * Returns the metadata for a specific relation on a property.
 *
 * @param target - The entity prototype.
 * @param propertyKey - The decorated property.
 * @param type - Relation type: 'oneToMany', 'manyToOne', 'oneToOne', 'manyToMany'.
 */
export function getRelation(target: any, propertyKey: string | symbol, type: string) {
    return Reflect.getMetadata(`relation:${type}`, target, propertyKey);
}

/**
 * Returns the list of properties marked with `@NotMapped`.
 */
export function getNotMapped(target: Function): (string | symbol)[] {
    return Reflect.getMetadata('entity:notMapped', target) || [];
}
