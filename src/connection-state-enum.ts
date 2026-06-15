/**
 * Represents the possible states of a database connection.
 *
 * Used by {@link DbContext} to track the lifecycle of the underlying
 * provider connection.
 */
export enum ConnectionState {
    /** No active connection. Initial state. */
    Disconnected = 'Disconnected',

    /** A connection attempt is currently in progress. */
    Connecting = 'Connecting',

    /** The connection is open and ready to execute queries. */
    Connected = 'Connected',

    /** The connection is being closed. */
    Disconnecting = 'Disconnecting',

    /** The last connection attempt failed. */
    Error = 'Error'
}
