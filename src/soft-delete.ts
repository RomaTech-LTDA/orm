import 'reflect-metadata';

/**
 * Marks an entity as soft-deletable (metadata only).
 *
 * **Not applied automatically yet:** `DbSet.remove()` still issues a real
 * DELETE and queries do not hide soft-deleted rows. Read the column with
 * {@link getSoftDeleteColumn} and implement the behaviour in your code (e.g.
 * set the column and call `update()`, and filter with `where()`).
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
 * // soft delete explicitly
 * user.deletedAt = new Date();
 * db.users.update(user);
 * await db.saveChanges();
 *
 * // and filter explicitly
 * const activeUsers = await db.users.where(u => u.deletedAt === null).toList();
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
