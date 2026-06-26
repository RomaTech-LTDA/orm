import 'reflect-metadata';

/**
 * Marks an entity as soft-deletable.
 * When applied, `remove()` sets the delete column instead of actually deleting.
 * Queries automatically filter out soft-deleted entities.
 *
 * @param columnName - Column that marks deletion. Default: 'deletedAt'
 *
 * @example
 * ```ts
 * @Entity('Users')
 * @SoftDelete()  // uses 'deletedAt' column
 * class User {
 *     @PrimaryKey() id!: number;
 *     @Column() name!: string;
 *     @Column() deletedAt?: Date;
 * }
 *
 * // remove() sets deletedAt = new Date() instead of DELETE
 * db.users.remove(user);
 *
 * // queries auto-filter: WHERE deletedAt IS NULL
 * const activeUsers = await db.users.ToList();
 *
 * // to include deleted:
 * const all = await db.users.withDeleted().ToList();
 * ```
 */
export function SoftDelete(columnName = 'deletedAt'): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata('entity:softDelete', columnName, target);
  };
}

/**
 * Returns the soft-delete column name, or undefined if not soft-deletable.
 */
export function getSoftDeleteColumn(target: Function): string | undefined {
  return Reflect.getMetadata('entity:softDelete', target);
}

/**
 * Checks if an entity class uses soft delete.
 */
export function isSoftDeletable(target: Function): boolean {
  return Reflect.hasMetadata('entity:softDelete', target);
}
