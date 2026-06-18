import type { IDbProvider } from './provider';

/**
 * Represents a database transaction.
 *
 * Use `DbContext.beginTransaction()` to start a transaction,
 * then call `commit()` or `rollback()` when done.
 *
 * @example
 * ```ts
 * const tx = await db.beginTransaction();
 * try {
 *     db.users.add(newUser);
 *     db.orders.add(newOrder);
 *     await db.saveChanges();
 *     await tx.commit();
 * } catch (err) {
 *     await tx.rollback();
 *     throw err;
 * }
 * ```
 */
export class Transaction {
  private _committed = false;
  private _rolledBack = false;

  constructor(private readonly _provider: IDbProvider) {}

  /** Whether the transaction has been committed. */
  get isCommitted(): boolean {
    return this._committed;
  }

  /** Whether the transaction has been rolled back. */
  get isRolledBack(): boolean {
    return this._rolledBack;
  }

  /** Whether the transaction is still active (not committed or rolled back). */
  get isActive(): boolean {
    return !this._committed && !this._rolledBack;
  }

  /**
   * Commits all changes made within this transaction.
   * @throws If the transaction was already committed or rolled back.
   */
  async commit(): Promise<void> {
    if (!this.isActive) {
      throw new Error('Transaction is no longer active');
    }
    await this._provider.executeQuery('COMMIT', []);
    this._committed = true;
  }

  /**
   * Rolls back all changes made within this transaction.
   * @throws If the transaction was already committed or rolled back.
   */
  async rollback(): Promise<void> {
    if (!this.isActive) {
      throw new Error('Transaction is no longer active');
    }
    await this._provider.executeQuery('ROLLBACK', []);
    this._rolledBack = true;
  }
}

/**
 * Extended provider interface that supports transactions.
 * Providers can optionally implement this to enable transaction support.
 */
export interface ITransactionalProvider extends IDbProvider {
  /** Starts a new database transaction. */
  beginTransaction(): Promise<void>;

  /** Commits the current transaction. */
  commitTransaction(): Promise<void>;

  /** Rolls back the current transaction. */
  rollbackTransaction(): Promise<void>;

  /** Whether the provider supports transactions. */
  supportsTransactions: boolean;
}

/**
 * Type guard to check if a provider supports transactions.
 */
export function isTransactionalProvider(provider: IDbProvider): provider is ITransactionalProvider {
  return 'supportsTransactions' in provider && (provider as any).supportsTransactions === true;
}
