/**
 * Entity state in the change tracker.
 */
export enum EntityState {
  Unchanged = 'unchanged',
  Added = 'added',
  Modified = 'modified',
  Deleted = 'deleted',
  Detached = 'detached',
}

/**
 * Tracks changes to entity properties.
 */
export interface TrackedEntity<T = any> {
  entity: T;
  state: EntityState;
  originalValues: Partial<T>;
  modifiedProperties: Set<string>;
}

/**
 * Change tracker that monitors entity modifications.
 * Enables generating minimal UPDATE statements (only dirty fields).
 *
 * @example
 * ```ts
 * const tracker = new ChangeTracker<User>();
 *
 * // Track an entity loaded from DB
 * tracker.attach(user);
 *
 * // Modify it
 * user.name = 'New Name';
 *
 * // Detect changes
 * tracker.detectChanges(user);
 * const entry = tracker.getEntry(user);
 * console.log(entry.modifiedProperties); // Set { 'name' }
 * console.log(entry.originalValues);     // { name: 'Old Name' }
 * ```
 */
export class ChangeTracker<T extends object = any> {
  private readonly _entries = new Map<T, TrackedEntity<T>>();

  /**
   * Begins tracking an entity in Unchanged state.
   * Stores a snapshot of current values as original.
   */
  attach(entity: T): void {
    this._entries.set(entity, {
      entity,
      state: EntityState.Unchanged,
      originalValues: { ...entity } as Partial<T>,
      modifiedProperties: new Set(),
    });
  }

  /**
   * Tracks a new entity (Added state).
   */
  add(entity: T): void {
    this._entries.set(entity, {
      entity,
      state: EntityState.Added,
      originalValues: {},
      modifiedProperties: new Set(Object.keys(entity)),
    });
  }

  /**
   * Marks an entity for deletion.
   */
  remove(entity: T): void {
    const entry = this._entries.get(entity);
    if (entry) {
      entry.state = EntityState.Deleted;
    }
  }

  /**
   * Detects which properties changed since the entity was attached.
   */
  detectChanges(entity: T): void {
    const entry = this._entries.get(entity);
    if (!entry || entry.state === EntityState.Added || entry.state === EntityState.Deleted) return;

    entry.modifiedProperties.clear();
    for (const key of Object.keys(entry.originalValues)) {
      if ((entity as any)[key] !== (entry.originalValues as any)[key]) {
        entry.modifiedProperties.add(key);
      }
    }

    entry.state = entry.modifiedProperties.size > 0 ? EntityState.Modified : EntityState.Unchanged;
  }

  /**
   * Returns the tracking entry for an entity.
   */
  getEntry(entity: T): TrackedEntity<T> | undefined {
    return this._entries.get(entity);
  }

  /**
   * Returns all entities in a specific state.
   */
  getByState(state: EntityState): TrackedEntity<T>[] {
    return Array.from(this._entries.values()).filter(e => e.state === state);
  }

  /**
   * Returns true if any tracked entity has changes.
   */
  hasChanges(): boolean {
    return Array.from(this._entries.values()).some(
      e => e.state !== EntityState.Unchanged && e.state !== EntityState.Detached
    );
  }

  /**
   * Marks all entities as unchanged (after save).
   */
  acceptChanges(): void {
    for (const entry of this._entries.values()) {
      if (entry.state === EntityState.Deleted) {
        this._entries.delete(entry.entity);
      } else {
        entry.state = EntityState.Unchanged;
        entry.originalValues = { ...entry.entity } as Partial<T>;
        entry.modifiedProperties.clear();
      }
    }
  }

  /**
   * Stops tracking an entity.
   */
  detach(entity: T): void {
    this._entries.delete(entity);
  }

  /** Number of tracked entities. */
  get count(): number {
    return this._entries.size;
  }
}
