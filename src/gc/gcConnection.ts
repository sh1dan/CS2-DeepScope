import CS2, { GCConnectionStatus } from 'node-cs2';
import SteamUser from 'steam-user';
import { logger } from '../utils/logger';

/**
 * Timing constants for GC connection operations
 */
const TIMING = {
  /** Default timeout for waiting for GC to be ready (in milliseconds) */
  GC_WAIT_FOR_READY_TIMEOUT_MS: 30000,
} as const;

/**
 * Game Coordinator connection handler
 * Manages the CS2 GC connection with proper handshake
 * 
 * ⚠️ NOTE: Relies on node-cs2 which uses Valve's Protobuf definitions.
 * Major CS2 updates may require updating node-cs2 package.
 */
export class GCConnection {
  private gc: CS2;
  private isConnected: boolean = false;
  private isReady: boolean = false;

  constructor(steamUser: SteamUser) {
    this.gc = new CS2(steamUser);
    this.gc._steamUser = steamUser;
    this.setupEventListeners();
  }

  /**
   * Sets up event listeners for GC connection events
   * Handles reconnection logic to keep the bot alive during Steam disconnects
   */
  private setupEventListeners(): void {
    // GC Welcome event - session is actually alive and ready
    this.gc.on('connectedToGC', () => {
      this.isConnected = true;
      this.isReady = true;
      logger.info('✅ CS2 GC is ready and accepting requests');
    });

    // GC Disconnect - handle "Tuesday Maintenance" and other disconnects
    this.gc.on('disconnectedFromGC', (reason: number) => {
      this.isConnected = false;
      this.isReady = false;
      
      const reasonNames: Record<number, string> = {
        1: 'NoSession',
        2: 'NoUserSession',
        3: 'Timeout',
        4: 'SteamDisconnect',
      };
      
      const reasonText = reasonNames[reason] || `Unknown (${reason})`;
      logger.warn(`⚠️ Disconnected from CS2 GC: ${reasonText}. Waiting for reconnect...`);
      
      // Queue is automatically paused because isGcReady() will return false
      // Profile fetcher will return 503 until GC reconnects
    });

    this.gc.on('connectionStatus', (status: GCConnectionStatus) => {
      // Status values: 0=NoSession, 1=NoUserSession, 2=NoSessionButUser, 3=Queue, 4=Connected
      const statusNames: Record<GCConnectionStatus, string> = {
        0: 'NoSession',
        1: 'NoUserSession', 
        2: 'NoSessionButUser',
        3: 'Queue',
        4: 'Connected'
      };
      
      if (status === 2) {
        logger.error(`❌ GC Error: NO_SESSION (status 2) - ${statusNames[status] || 'Unknown'}`);
        logger.error('💡 This usually means Steam doesn\'t recognize CS2 as running');
        logger.error('💡 Try checking your Steam profile to confirm CS2 shows as running');
        // Reset state on error
        this.isConnected = false;
        this.isReady = false;
      } else if (status === 4) {
        // Connected - state will be set by connectedToGC event
      } else {
        // Other statuses - ensure we're not in ready state
        if (status !== 3) { // Don't reset on Queue status
          this.isReady = false;
        }
      }
    });

    this.gc.on('error', (error: Error) => {
      logger.error(`❌ GC Error: ${error.message}`, { error });
      // Reset state on error to prevent zombie state
      this.isConnected = false;
      this.isReady = false;
    });
  }

  /**
   * Waits for the GC to be ready (connected and handshake complete)
   * @param timeout - Maximum time to wait in milliseconds (default: TIMING.GC_WAIT_FOR_READY_TIMEOUT_MS)
   * @returns Promise that resolves when GC is ready
   */
  async waitForReady(timeout: number = TIMING.GC_WAIT_FOR_READY_TIMEOUT_MS): Promise<void> {
    if (this.isReady) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.gc.removeListener('connectedToGC', readyHandler);
        this.gc.removeListener('connectionStatus', statusHandler);
        reject(new Error('GC connection timeout'));
      }, timeout);

      const readyHandler = () => {
        clearTimeout(timeoutId);
        this.gc.removeListener('connectionStatus', statusHandler);
        resolve();
      };

      // Also listen for connection status
      const statusHandler = () => {
        // Silent handler
      };

      this.gc.on('connectionStatus', statusHandler);
      this.gc.once('connectedToGC', readyHandler);
    });
  }

  /**
   * Attempts to manually trigger GC connection
   * Sometimes the GC needs to be "woken up" after game status is set
   */
  async attemptConnection(): Promise<void> {
    try {
      if (this.gc.connect) {
        this.gc.connect();
      } else if (this.gc.launch) {
        this.gc.launch();
      } else if (this.gc.requestSession) {
        this.gc.requestSession();
      }
    } catch {
      // Silent
    }
  }

  /**
   * Checks if the GC is ready for requests
   * @returns True if connected and ready
   */
  isGcReady(): boolean {
    return this.isReady && this.isConnected;
  }

  /**
   * Gets the CS2 instance
   * @returns The CS2 client
   */
  getGC(): CS2 {
    return this.gc;
  }
}

