import dotenv from 'dotenv';
import { logger } from './utils/logger';
import { printBanner } from './utils/banner';
import { SteamAuth } from './auth/steamAuth';
import { GCConnection } from './gc/gcConnection';
import { ProfileFetcher } from './gc/profileFetcher';
import { APIServer } from './api/server';

// Load environment variables
dotenv.config();

/**
 * Timing constants for service initialization and operations
 */
const TIMING = {
  /** Delay after Steam login to allow full initialization */
  STEAM_INIT_DELAY_MS: 3000,
  /** Delay after setting persona state */
  PERSONA_SET_DELAY_MS: 2000,
  /** Delay after GC connection initialization */
  GC_INIT_DELAY_MS: 2000,
  /** Delay after launching CS2 game to establish GC connection */
  GC_LAUNCH_DELAY_MS: 20000,
  /** Delay between GC connection retry attempts */
  GC_RETRY_DELAY_MS: 10000,
  /** Delay in background retry loop for GC connection */
  GC_BACKGROUND_RETRY_DELAY_MS: 5000,
  /** Interval for background GC connection retry */
  GC_BACKGROUND_RETRY_INTERVAL_MS: 30000,
  /** Delay during graceful shutdown to allow processes to finish */
  SHUTDOWN_DELAY_MS: 2000,
} as const;

/**
 * Main entry point for CS2 DeepScope service
 */
async function main() {
  try {
    // Print banner
    printBanner();
    
    logger.info('🚀 Starting CS2 DeepScope Service...');

    // Validate environment variables
    const username = process.env.STEAM_USERNAME;
    const password = process.env.STEAM_PASSWORD;
    const sharedSecret = process.env.STEAM_SHARED_SECRET;
    const apiPort = parseInt(process.env.API_PORT || '3000', 10);

    if (!username || !password) {
      throw new Error('STEAM_USERNAME and STEAM_PASSWORD must be set in .env file');
    }

    // Initialize Steam authentication
    logger.info('🔐 Initializing Steam authentication...');
    // Pass sharedSecret to SteamAuth so it can auto-generate 2FA codes
    const steamAuth = new SteamAuth(username, sharedSecret);
    const steamClient = steamAuth.getClient();

    // Set up listeners to track Steam client state (silent)

    // Log in to Steam
    await steamAuth.login(username, password, sharedSecret);

    // Wait for Steam to fully initialize
    await new Promise(resolve => setTimeout(resolve, TIMING.STEAM_INIT_DELAY_MS));
    
    // Set persona state to Online
    steamClient.setPersona(1);
    await new Promise(resolve => setTimeout(resolve, TIMING.PERSONA_SET_DELAY_MS));
    
    // Initialize GC connection
    const gcConnection = new GCConnection(steamClient);
    await new Promise(resolve => setTimeout(resolve, TIMING.GC_INIT_DELAY_MS));
    
    // Launch CS2 to establish GC connection
    steamClient.gamesPlayed([730]);
    await new Promise(resolve => setTimeout(resolve, TIMING.GC_LAUNCH_DELAY_MS));
    
    await gcConnection.attemptConnection();
    
    // Initialize profile fetcher and API server
    const profileFetcher = new ProfileFetcher(gcConnection.getGC(), steamClient);
    logger.info('🌐 Starting API server...');
    const apiServer = new APIServer(profileFetcher, gcConnection, apiPort);
    const httpServer = apiServer.start();
    
    // Setup Steam reconnection monitoring for Wednesday maintenance recovery
    // This handles automatic GC reconnection when Steam services restart
    let isSteamLoggedIn = true;
    let hasInitialLogin = false;
    let gcReconnectInterval: NodeJS.Timeout | null = null;
    
    // Mark initial login as complete after a delay (to distinguish from reconnections)
    setTimeout(() => {
      hasInitialLogin = true;
    }, TIMING.STEAM_INIT_DELAY_MS + TIMING.PERSONA_SET_DELAY_MS + TIMING.GC_LAUNCH_DELAY_MS + 5000);
    
    // Monitor Steam connection status for reconnections
    steamClient.on('loggedOn', () => {
      // Only trigger reconnection logic if this is a reconnection (not initial login)
      if (hasInitialLogin && !isSteamLoggedIn) {
        logger.info('🔄 Steam reconnected after disconnect - reinitializing GC connection...');
        isSteamLoggedIn = true;
        
        // Re-launch CS2 to establish GC connection
        setTimeout(async () => {
          try {
            logger.info('🔄 Restoring persona state and CS2 game status...');
            steamClient.setPersona(1);
            await new Promise(resolve => setTimeout(resolve, TIMING.PERSONA_SET_DELAY_MS));
            
            logger.info('🔄 Re-launching CS2 to reconnect to GC...');
            steamClient.gamesPlayed([730]);
            await new Promise(resolve => setTimeout(resolve, TIMING.GC_LAUNCH_DELAY_MS));
            
            logger.info('🔄 Attempting GC reconnection...');
            await gcConnection.attemptConnection();
            
            // Start background retry for GC connection
            if (gcReconnectInterval) {
              clearInterval(gcReconnectInterval);
            }
            
            logger.info('🔄 Starting GC reconnection retry loop...');
            gcReconnectInterval = setInterval(async () => {
              if (gcConnection.isGcReady()) {
                logger.info('✅ GC reconnected successfully after Steam restart');
                if (gcReconnectInterval) {
                  clearInterval(gcReconnectInterval);
                  gcReconnectInterval = null;
                }
                return;
              }
              try {
                await gcConnection.attemptConnection();
                await new Promise(resolve => setTimeout(resolve, TIMING.GC_BACKGROUND_RETRY_DELAY_MS));
                if (gcConnection.isGcReady()) {
                  logger.info('✅ GC reconnected successfully after Steam restart');
                  if (gcReconnectInterval) {
                    clearInterval(gcReconnectInterval);
                    gcReconnectInterval = null;
                  }
                }
              } catch {
                // Silent retry
              }
            }, TIMING.GC_BACKGROUND_RETRY_INTERVAL_MS);
          } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.warn(`⚠️ Failed to reinitialize GC after Steam reconnect: ${errorMessage}`);
          }
        }, TIMING.STEAM_INIT_DELAY_MS);
      } else if (!hasInitialLogin) {
        // This is the initial login, just mark it
        isSteamLoggedIn = true;
      }
    });
    
    // Track Steam disconnects
    steamClient.on('disconnected', () => {
      logger.warn('⚠️ Steam disconnected - will auto-reconnect and restore GC connection');
      isSteamLoggedIn = false;
      
      // Clear GC reconnect interval (will restart after Steam reconnects)
      if (gcReconnectInterval) {
        clearInterval(gcReconnectInterval);
        gcReconnectInterval = null;
      }
    });
    
    // Try to connect to GC
    let connected = false;
    const maxRetries = 3;
    let backgroundRetry: NodeJS.Timeout | null = null;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await gcConnection.waitForReady();
        connected = true;
        break;
      } catch (error: unknown) {
        if (attempt < maxRetries) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.warn(`⚠️ GC connection attempt ${attempt} failed: ${errorMessage}`);
          await new Promise(resolve => setTimeout(resolve, TIMING.GC_RETRY_DELAY_MS));
          await gcConnection.attemptConnection();
        }
      }
    }
    
    // Background retry for GC connection (if not connected)
    if (!connected) {
      logger.error('❌ Failed to connect to GC');
      
      // Background retry (silent)
      backgroundRetry = setInterval(async () => {
        if (gcConnection.isGcReady()) {
          logger.info('✅ GC connected');
          if (backgroundRetry) {
            clearInterval(backgroundRetry);
            backgroundRetry = null;
          }
          return;
        }
        try {
          await gcConnection.attemptConnection();
          await new Promise(resolve => setTimeout(resolve, TIMING.GC_BACKGROUND_RETRY_DELAY_MS));
          if (gcConnection.isGcReady()) {
            logger.info('✅ GC connected');
            if (backgroundRetry) {
              clearInterval(backgroundRetry);
              backgroundRetry = null;
            }
          }
        } catch {
          // Silent retry
        }
      }, TIMING.GC_BACKGROUND_RETRY_INTERVAL_MS);
    }

    logger.info('✅ Service started successfully!');

    // Handle graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info(`🛑 Received ${signal}, shutting down gracefully...`);

      try {
        // Clear background retry if active
        if (backgroundRetry) {
          clearInterval(backgroundRetry);
          backgroundRetry = null;
        }
        
        // Clear GC reconnect interval if active
        if (gcReconnectInterval) {
          clearInterval(gcReconnectInterval);
          gcReconnectInterval = null;
        }

        // Close Express server
        logger.info('🔌 Closing API server...');
        await apiServer.close();

        // Disconnect from Steam
        logger.info('🔌 Disconnecting from Steam...');
        steamAuth.disconnect();

        // Wait for processes to finish
        logger.info('⏳ Waiting for processes to finish...');
        await new Promise(resolve => setTimeout(resolve, TIMING.SHUTDOWN_DELAY_MS));

        logger.info('✅ Shutdown complete');
        process.exit(0);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`❌ Error during shutdown: ${errorMessage}`);
        process.exit(1);
      }
    };

    // Register signal handlers
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`❌ Fatal error: ${errorMessage}`, { error });
    process.exit(1);
  }
}

// Global error handlers - must be set before any async operations
process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
  const errorMessage = reason instanceof Error ? reason.message : String(reason);
  
  // Filter timeout errors - they're expected and handled by API
  if (errorMessage.includes('timeout') || errorMessage.includes('Timeout')) {
    // Just log as warning, don't treat as critical error
    logger.warn(`⏱️ Unhandled timeout rejection (handled by API): ${errorMessage}`);
    return;
  }
  
  // Log other unhandled rejections
  logger.error(`❌ Unhandled Promise Rejection: ${errorMessage}`, { 
    reason: reason instanceof Error ? reason.stack : reason 
  });
});

process.on('uncaughtException', (error: Error) => {
  logger.error(`❌ Uncaught Exception: ${error.message}`, { 
    stack: error.stack 
  });
  process.exit(1);
});

// Run the service
main();

