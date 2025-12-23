import express, { Request, Response } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { logger } from '../utils/logger';
import { ProfileFetcher, PlayerProfile } from '../gc/profileFetcher';
import { GCConnection } from '../gc/gcConnection';

/**
 * Express API server for CS2 DeepScope
 * Provides endpoints to fetch player profiles
 */
export class APIServer {
  private app: express.Application;
  private profileFetcher: ProfileFetcher;
  private gcConnection: GCConnection;
  private port: number;
  private server: ReturnType<express.Application['listen']> | null = null;

  constructor(profileFetcher: ProfileFetcher, gcConnection: GCConnection, port: number = 3000) {
    this.app = express();
    this.profileFetcher = profileFetcher;
    this.gcConnection = gcConnection;
    this.port = port;

    this.setupMiddleware();
    this.setupRoutes();
  }

  /**
   * Sets up Express middleware
   */
  private setupMiddleware(): void {
    // CORS middleware - allows cross-origin requests
    this.app.use(cors());

    // Body parsing middleware
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));

    // Rate limiting middleware for API routes
    // Limit to 100 requests per 15 minutes per IP
    const apiLimiter = rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 100, // Limit each IP to 100 requests per windowMs
      standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
      legacyHeaders: false, // Disable the `X-RateLimit-*` headers
      message: {
        error: 'Too many requests from this IP, please try again later.',
      },
      // Skip rate limiting for health check endpoint
      skip: (req: Request) => req.path === '/api/health',
    });

    // Apply rate limiter to all API routes
    this.app.use('/api/', apiLimiter);
  }

  /**
   * Sets up API routes
   */
  private setupRoutes(): void {
    // Health check endpoint
    this.app.get('/api/health', (req: Request, res: Response) => {
      res.json({
        status: 'ok',
        gcReady: this.gcConnection.isGcReady(),
        timestamp: new Date().toISOString(),
      });
    });

    // Fetch player profile endpoint
    this.app.get('/api/profile/:steamId64', async (req: Request, res: Response) => {
      const { steamId64 } = req.params;

      // Validate Steam ID 64 format (should be 17 digits)
      if (!/^\d{17}$/.test(steamId64)) {
        return res.status(400).json({
          error: 'Invalid Steam ID 64 format. Must be 17 digits.',
        });
      }

      // Check if GC is ready
      if (!this.gcConnection.isGcReady()) {
        return res.status(503).json({
          error: 'Game Coordinator not ready. Please wait for connection.',
        });
      }

      try {
        // Try to load from cache first (only if file cache is enabled)
        const enableFileCache = process.env.ENABLE_FILE_CACHE === 'true';
        if (enableFileCache) {
          const cached = await this.profileFetcher.loadProfileFromFile(steamId64);
          if (cached && req.query.force !== 'true') {
            return res.json({
              ...cached,
              cached: true,
            });
          }
        }

        // Fetch fresh data from GC
        const profile = await this.profileFetcher.fetchProfile(steamId64);

        // Profile data ready for use

        res.json({
          ...profile,
          cached: false,
        });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`❌ Error fetching profile for ${steamId64}: ${errorMessage}`);
        res.status(500).json({
          error: 'Failed to fetch player profile',
          message: errorMessage,
        });
      }
    });

    // Error handler
    this.app.use((err: Error, req: Request, res: Response, next: express.NextFunction): void => {
      logger.error(`❌ API Error: ${err.message}`, { error: err });
      res.status(500).json({
        error: 'Internal server error',
        message: err.message,
      });
    });
  }

  /**
   * Starts the API server
   * @returns The HTTP server instance
   */
  start(): ReturnType<express.Application['listen']> {
    this.server = this.app.listen(this.port, () => {
      logger.info(`🚀 API server started on port ${this.port}`);
    });

    // Handle server errors (e.g., port already in use)
    this.server.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        logger.error(`❌ Port ${this.port} is already in use. Please:`);
        logger.error(`   1. Stop the other process using port ${this.port}`);
        logger.error(`   2. Or change API_PORT in your .env file`);
        process.exit(1);
      } else {
        logger.error(`❌ Server error: ${error.message}`, { error });
        process.exit(1);
      }
    });

    return this.server;
  }

  /**
   * Closes the API server gracefully
   * @returns Promise that resolves when server is closed
   */
  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }

      this.server.close((error) => {
        if (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.warn(`⚠️ Error closing server: ${errorMessage}`);
          reject(error);
        } else {
          logger.info('🔌 API server closed');
          resolve();
        }
      });
    });
  }

  /**
   * Gets the Express app instance
   * @returns The Express application
   */
  getApp(): express.Application {
    return this.app;
  }
}

