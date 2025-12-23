import SteamUser, { LogOnOptions, LoggedOnEvent, MachineAuthToken, SteamUserOptions } from 'steam-user';
import * as path from 'path';
import { promises as fs } from 'fs';
import { logger } from '../utils/logger';

// steam-totp doesn't have TypeScript definitions, use require
const SteamTotp = require('steam-totp');

type TokenData = string | Buffer | MachineAuthToken;

/**
 * Timing constants for Steam authentication operations
 */
const TIMING = {
  /** Delay after loggedOn event to extract loginKey from client internals */
  LOGIN_KEY_EXTRACTION_DELAY_MS: 2000,
  /** Initial delay before checking for machine auth token */
  TOKEN_EXTRACTION_INITIAL_DELAY_MS: 2000,
  /** Retry delays for token extraction (in milliseconds) */
  TOKEN_EXTRACTION_RETRY_DELAYS_MS: [2000, 3000, 5000],
} as const;

/**
 * Steam authentication handler with modern machineAuthToken support
 * Falls back to legacy sentry files if token is missing
 */
export class SteamAuth {
  private client: SteamUser;
  private accountName: string;
  private tokenPath: string;
  private sentryPath: string;
  private loginKeyPath: string;
  private dataDirectory: string;
  private sharedSecret?: string;
  private disconnectCount: number = 0;
  private readonly MAX_DISCONNECTS: number = 5;

  constructor(accountName: string, sharedSecret?: string) {
    // Simple validation for private use
    if (!accountName || typeof accountName !== 'string' || accountName.trim().length === 0) {
      throw new Error('Account name must be a non-empty string');
    }

    this.accountName = accountName.trim();
    // Store sharedSecret for automatic 2FA code generation
    this.sharedSecret = sharedSecret || process.env.STEAM_SHARED_SECRET;

    // Use absolute paths to avoid issues with process.cwd() changes
    const baseDir = path.resolve(process.cwd());
    this.dataDirectory = path.resolve(baseDir, '.steam-data');
    this.tokenPath = path.resolve(baseDir, `token_${accountName}.json`);
    this.sentryPath = path.resolve(baseDir, `sentry_${accountName}.bin`);
    this.loginKeyPath = path.resolve(baseDir, `loginKey_${accountName}.txt`);

    // Enable automatic storage via dataDirectory
    // This allows steam-user to manage some security files automatically
    // Add autoRelogin with delay to prevent aggressive reconnection attempts
    const options: SteamUserOptions = {
      dataDirectory: this.dataDirectory,
      autoRelogin: true,
      autoReloginDelay: 30000, // Wait 30 seconds before retrying (default is 1s)
      // This gives Steam servers time to "cool down" and accept the connection again
    };
    this.client = new SteamUser(options);

    // Ensure data directory exists
    this.ensureDataDirectory().catch((error) => {
      logger.error(`❌ Failed to create data directory: ${error instanceof Error ? error.message : String(error)}`);
    });

    // CRITICAL: Setup event listeners BEFORE any logOn() calls
    // loginKey, machineAuthToken, and sentry listeners must be registered before login
    this.setupEventListeners();

    // Session persistence initialized
  }

  /**
   * Ensures the data directory exists
   */
  private async ensureDataDirectory(): Promise<void> {
    try {
      await fs.mkdir(this.dataDirectory, { recursive: true });
      // Data directory ready
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`❌ Cannot create data directory: ${errorMessage}`);
    }
  }

  /**
   * Consolidated method to save session data (token or sentry)
   * @param filename - Full path to the file
   * @param data - Data to save (Buffer, string, or object)
   * @param source - Source description for logging
   * @returns Promise that resolves to true if saved successfully
   */
  private async saveSessionData(
    filename: string,
    data: Buffer | string | TokenData,
    source: string
  ): Promise<boolean> {
    try {
      // Check if data is undefined
      if (data === undefined) {
        logger.error(`❌ Data is undefined from ${source} - cannot save`);
        return false;
      }

      // Ensure directory exists
      const dir = path.dirname(filename);
      try {
        await fs.access(dir);
      } catch {
        await fs.mkdir(dir, { recursive: true });
        logger.info(`📁 Created directory: ${dir}`);
      }

      // Prepare data for saving
      let dataToSave: string | Buffer;
      
      // Special handling for token files: save in structured format
      if (filename === this.tokenPath) {
        // Extract token value from data
        let tokenValue: string | undefined;
        
        if (typeof data === 'string') {
          tokenValue = data;
        } else if (data && typeof data === 'object' && !(data instanceof Buffer)) {
          // If it's an object, check for common token field names
          const dataObj = data as Record<string, unknown>;
          tokenValue = 
            (dataObj.token as string) ||
            (dataObj.machineAuthToken as string) ||
            (dataObj.value as string) ||
            (typeof dataObj === 'string' ? dataObj : undefined);
          
          // If still no token, try to stringify the whole object
          if (!tokenValue && Object.keys(dataObj).length > 0) {
            // Check if it's already a structured token object
            if ('token' in dataObj) {
              // Already structured, use as-is but add/update metadata
              const structuredData = {
                token: dataObj.token,
                accountName: this.accountName,
                savedAt: new Date().toISOString(),
              };
              dataToSave = JSON.stringify(structuredData, null, 2);
              // Saving structured token object
            } else {
              // Try to extract token from nested structure
              tokenValue = JSON.stringify(dataObj);
            }
          }
        }
        
        // If we have a token value, create structured format
        if (tokenValue) {
          const structuredData = {
            token: tokenValue,
            accountName: this.accountName,
            savedAt: new Date().toISOString(),
          };
          dataToSave = JSON.stringify(structuredData, null, 2);
          // Saving structured token format
        } else {
          // Fallback: save as JSON
          dataToSave = JSON.stringify(data, null, 2);
        }
      } else if (data instanceof Buffer) {
        // Buffer: save as binary (for sentry files)
        dataToSave = data;
      } else if (typeof data === 'string') {
        // String: save as JSON string
        dataToSave = JSON.stringify(data, null, 2);
      } else if (data && typeof data === 'object') {
        // Object: save as JSON
        dataToSave = JSON.stringify(data, null, 2);
      } else {
        logger.error(`❌ Cannot serialize data from ${source} (type: ${typeof data})`);
        return false;
      }

      // Write file asynchronously using fs.promises.writeFile
      if (dataToSave instanceof Buffer) {
        await fs.writeFile(filename, dataToSave);
      } else {
        await fs.writeFile(filename, dataToSave, 'utf8');
      }

      // Verify file was created
      try {
        const stats = await fs.stat(filename);
        // File saved successfully
        return true;
      } catch {
        logger.error(`❌ File was not created at ${filename}`);
        return false;
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      logger.error(`❌ Failed to save session data: ${errorMessage}`);
      if (errorStack) {
        logger.error(`❌ Error stack: ${errorStack}`);
      }
      logger.error(`❌ File path: ${filename}`);
      return false;
    }
  }


  /**
   * Sets up universal event listeners for authentication and session management
   * CRITICAL: This must be called BEFORE logOn() to capture loginKey, machineAuthToken, and sentry events
   */
  private setupEventListeners(): void {
    // CRITICAL: Listen for loginKey updates BEFORE logOn() is called
    // This is the most reliable way to persist Mobile Guard sessions
    // loginKey event fires after successful authentication with password + 2FA
    const possibleEventNames = ['loginKey', 'newLoginKey', 'login-key', 'sessionKey'];
    
    for (const eventName of possibleEventNames) {
      try {
        (this.client as unknown as { on(event: string, handler: (key: string) => void): void }).on(
          eventName,
          async (key: string) => {
            const saved = await this.saveLoginKey(key);
            if (saved) {
              logger.info('✅ LoginKey saved successfully');
            }
          }
        );
      } catch {
        // Ignore errors for event registration
      }
    }
    
    // Listen for loggedOn to extract loginKey/refreshToken from client internals
    // This is a fallback if events don't fire (common for Mobile Guard)
    this.client.on('loggedOn', async () => {
      // Single check after delay (enough time for Steam to set tokens)
      setTimeout(async () => {
        await this.tryExtractLoginKeyFromClient();
      }, TIMING.LOGIN_KEY_EXTRACTION_DELAY_MS);
    });

    // CRITICAL: Listen for machineAuthToken updates BEFORE logOn() is called
    this.client.on('machineAuthToken', async (token: TokenData | Buffer) => {
      await this.saveSessionData(this.tokenPath, token, 'machineAuthToken event');
    });

    // CRITICAL: Listen for sentry file updates BEFORE logOn() is called
    this.client.on('sentry', async (sentry: Buffer) => {
      await this.saveSessionData(this.sentryPath, sentry, 'sentry event');
    });

    // Listen for guard code events and auto-generate if sharedSecret is available
    // This handles interactive 2FA code requests from steam-user
    this.client.on('steamGuardCode', (domain: string, callback: (code: string) => void) => {
        logger.info(`📝 Steam Guard code requested for domain: ${domain}`);
        
        if (this.sharedSecret) {
          try {
            const code = this.generateTwoFactorCode(this.sharedSecret);
            logger.info(`🔐 Auto-generating 2FA code from STEAM_SHARED_SECRET...`);
            logger.info(`✅ Using generated 2FA code (no manual input required)`);
            callback(code);
          } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error(`❌ Failed to generate 2FA code: ${errorMessage}`);
            logger.warn('⚠️ You may need to enter the code manually');
            // Don't call callback - let steam-user prompt for manual input
          }
        } else {
          logger.warn('⚠️ STEAM_SHARED_SECRET not found in .env or constructor');
          logger.warn('⚠️ You will need to enter the 2FA code manually');
          logger.warn('💡 Add STEAM_SHARED_SECRET to your .env file to enable automatic 2FA');
          // Don't call callback - let steam-user prompt for manual input
        }
      }
    );

    // Also listen for newGuardCode event (for logging)
    this.client.on('newGuardCode', () => {
      logger.info('📝 New guard code required - loginKey will be saved after successful authentication');
    });

    // Watchdog: Track disconnects and force restart if too many failures
    // Listen for successful login to reset counter
    this.client.on('loggedOn', () => {
      this.disconnectCount = 0; // Reset counter on success
      logger.info('✅ Successfully logged into Steam!');
    });

    // Error and disconnect handlers with watchdog
    this.client.on('error', (error: Error) => {
      logger.warn(`⚠️ Steam Error: ${error.message}`);
      this.handleDisconnect();
    });

    this.client.on('disconnected', (eresult: number, msg?: string) => {
      logger.warn(`⚠️ Disconnected: ${msg || 'Unknown reason'} (${eresult})`);
      this.handleDisconnect();
    });
  }

  /**
   * Handles disconnect events and implements watchdog logic
   * If too many disconnects occur without successful login, kills the process
   */
  private handleDisconnect(): void {
    this.disconnectCount++;
    logger.warn(`⚠️ Disconnect count: ${this.disconnectCount}/${this.MAX_DISCONNECTS}`);

    if (this.disconnectCount >= this.MAX_DISCONNECTS) {
      logger.error('🚨 Too many disconnects! Killing process to force a fresh restart...');
      logger.error('💡 The process manager (PM2, systemd, etc.) should restart the bot automatically');
      process.exit(1); // Kill the app to force restart
    }
  }

  /**
   * Loads machine auth token from disk if it exists (async)
   * @returns Promise that resolves with the machine auth token or null if not found
   */
  private async loadMachineAuthToken(): Promise<TokenData | null> {
    try {
      // Check if file exists
      try {
        await fs.access(this.tokenPath);
      } catch {
        // File doesn't exist, return null
        return null;
      }

      // Read file asynchronously
      const tokenData = await fs.readFile(this.tokenPath, 'utf8');

      // Try to parse as JSON first
      try {
        const parsed = JSON.parse(tokenData);
        
        // Check if it's structured format (with token, accountName, savedAt)
        if (parsed && typeof parsed === 'object' && 'token' in parsed) {
          logger.info(`✅ Loaded machine auth token from ${this.tokenPath} (structured format)`);
          // Return just the token value for steam-user
          return parsed.token as string;
        }
        
        // Otherwise, return the whole object
        logger.info(`✅ Loaded machine auth token from ${this.tokenPath}`);
        return parsed as TokenData;
      } catch {
        // If it's not valid JSON, it might be a plain string
        logger.info(
          `✅ Loaded machine auth token (string format) from ${this.tokenPath}`
        );
        return tokenData.trim();
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn(`⚠️ Failed to load machine auth token: ${errorMessage}`);
      // If file is missing or corrupt, proceed to 2FA
      return null;
    }
  }

  /**
   * Saves loginKey to file (for Mobile Guard persistence)
   * @param key - The login key to save
   * @returns Promise that resolves to true if saved successfully
   */
  private async saveLoginKey(key: string): Promise<boolean> {
    try {
      if (!key || typeof key !== 'string') {
        logger.error('❌ Invalid loginKey - cannot save (not a string or empty)');
        return false;
      }

      const trimmedKey = key.trim();
      if (trimmedKey.length === 0) {
        logger.error('❌ Invalid loginKey - empty string after trim');
        return false;
      }

        // Saving loginKey

      // Ensure directory exists
      const dir = path.dirname(this.loginKeyPath);
      try {
        await fs.access(dir);
        logger.debug(`✅ Directory exists: ${dir}`);
      } catch {
        logger.info(`📁 Creating directory: ${dir}`);
        await fs.mkdir(dir, { recursive: true });
      }

      // Test write permissions
      try {
        const testFile = path.join(dir, '.write-test');
        await fs.writeFile(testFile, 'test', 'utf8');
        await fs.unlink(testFile);
        logger.debug('✅ Write permissions OK');
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`❌ Cannot write to directory ${dir}: ${errorMessage}`);
        return false;
      }

      // Save as plain text file
      // Writing to file
      await fs.writeFile(this.loginKeyPath, trimmedKey, 'utf8');
      // File written successfully

      // Verify file was created and has content
      try {
        const stats = await fs.stat(this.loginKeyPath);
        if (stats.size === 0) {
          logger.error(`❌ LoginKey file is empty (0 bytes)`);
          return false;
        }
        
        // Read back to verify
        const readBack = await fs.readFile(this.loginKeyPath, 'utf8');
        if (readBack.trim() !== trimmedKey) {
          logger.error(`❌ LoginKey file content mismatch`);
          return false;
        }
        
        logger.info('✅ Session token saved (future logins will not require 2FA)');
        return true;
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`❌ Login key file verification failed: ${errorMessage}`);
        logger.error(`❌ File path: ${this.loginKeyPath}`);
        return false;
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      logger.error(`❌ Failed to save login key: ${errorMessage}`);
      if (errorStack) {
        logger.error(`❌ Error stack: ${errorStack}`);
      }
      logger.error(`❌ File path: ${this.loginKeyPath}`);
      return false;
    }
  }

  /**
   * Loads loginKey from disk if it exists (for Mobile Guard)
   * @returns Promise that resolves with the login key or null if not found
   */
  private async loadLoginKey(): Promise<string | null> {
    try {
      try {
        await fs.access(this.loginKeyPath);
      } catch {
        // File doesn't exist, return null
        return null;
      }

      const key = await fs.readFile(this.loginKeyPath, 'utf8');
      const trimmedKey = key.trim();
      
      if (trimmedKey.length === 0) {
        logger.warn(`⚠️ Login key file is empty: ${this.loginKeyPath}`);
        return null;
      }

      logger.info('✅ Loaded saved session token');
      return trimmedKey;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn(`⚠️ Failed to load login key: ${errorMessage}`);
      return null;
    }
  }

  /**
   * Loads sentry file from disk if it exists (legacy fallback, async)
   * @returns Promise that resolves with the sentry buffer or null if not found
   */
  private async loadSentryFile(): Promise<Buffer | null> {
    try {
      try {
        await fs.access(this.sentryPath);
      } catch {
        return null;
      }

      const sentry = await fs.readFile(this.sentryPath);
      logger.info(`✅ Loaded sentry file from ${this.sentryPath}`);
      return sentry;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn(`⚠️ Failed to load sentry file: ${errorMessage}`);
      return null;
    }
  }

  /**
   * Authenticates with Steam using loginKey (primary for Mobile Guard), machineAuthToken, or sentry (fallback)
   * @param username - Steam username
   * @param password - Steam password (used if loginKey is not available)
   * @param sharedSecret - Optional shared secret for 2FA (used if loginKey is not available)
   * @returns Promise that resolves when logged in
   */
  async login(
    username: string,
    password: string,
    sharedSecret?: string
  ): Promise<void> {
    // PRIMARY: Try to load loginKey first (most reliable for Mobile Guard)
    const loginKey = await this.loadLoginKey();
    
    if (loginKey) {
      // Use loginKey for authentication (no password or 2FA needed)
      logger.info('🔐 Using saved session token (no 2FA required)');
      return this.loginWithKey(username, loginKey);
    }

    // FALLBACK: Use password + 2FA if loginKey is not available
    logger.info('🔐 LoginKey not found, using password authentication (2FA may be required)');
    
    // Load auth tokens asynchronously before setting up login
    const loginOptions: {
      accountName: string;
      password: string;
      machineAuthToken?: TokenData;
      shaSentryfile?: Buffer;
      twoFactorCode?: string;
    } = {
      accountName: username,
      password: password,
    };

    // Check for token and sentry files
    try {
      const machineAuthToken = await this.loadMachineAuthToken();
      if (machineAuthToken) {
        loginOptions.machineAuthToken = machineAuthToken;
        logger.info('🔐 Using machine auth token for authentication');
      }

      // Also check for sentry file (can be used alongside token)
      const sentry = await this.loadSentryFile();
      if (sentry) {
        loginOptions.shaSentryfile = sentry;
        logger.info('🔐 Using sentry file for authentication');
      }

      // If neither exists, warn user
      if (!machineAuthToken && !sentry) {
        logger.warn(
          '⚠️ No loginKey, machine auth token, or sentry file found. First-time login will require 2FA.'
        );
        logger.warn(
          '⚠️ After login, loginKey will be saved automatically to prevent future 2FA prompts.'
        );
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn(`⚠️ Error loading auth tokens: ${errorMessage}. Proceeding with 2FA if needed.`);
      // Continue with login even if token loading fails
    }

    // Add 2FA if provided
    if (sharedSecret) {
      loginOptions.twoFactorCode = this.generateTwoFactorCode(sharedSecret);
    }

    // Return promise that resolves when logged in
    // NOTE: Event listeners are primary method, but for Mobile Guard we also check client internals
    // after login (NOT from _events, but from _session, _steamGuard, etc.)
    return this.loginWithPassword(loginOptions);
  }

  /**
   * Authenticates with Steam using loginKey or refreshToken (no password or 2FA needed)
   * @param username - Steam username (only used for loginKey, not for refreshToken)
   * @param loginKey - The login key or refreshToken from previous session
   * @returns Promise that resolves when logged in
   */
  private loginWithKey(username: string, loginKey: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Check if the key looks like a JWT (refreshToken) or a loginKey
      // JWT tokens start with "eyJ" or "eyA" (base64 encoded JSON header)
      const isRefreshToken = loginKey.startsWith('eyJ') || loginKey.startsWith('eyA');
      
      let loginOptions: {
        accountName?: string;
        loginKey?: string;
        refreshToken?: string;
      };
      
      if (isRefreshToken) {
        // This is a JWT token (refreshToken)
        // steam-user v5.0.0+ accepts refreshToken for Mobile Guard login
        // IMPORTANT: When using refreshToken, DO NOT specify accountName
        loginOptions = {
          refreshToken: loginKey,
        };
      } else {
        // This looks like a traditional loginKey
        loginOptions = {
          accountName: username,
          loginKey: loginKey,
        };
      }

      // Handle login result
      const loggedOnHandler = (details: unknown) => {
        const eventDetails = details as LoggedOnEvent;
        this.client.removeListener('error', errorHandler);
        const loggedInUsername = eventDetails?.accountName || username || 'user';
        logger.info(`✅ Logged in as ${loggedInUsername} (no 2FA required)`);
        resolve();
      };

      const errorHandler = (error: unknown) => {
        const err = error instanceof Error ? error : new Error(String(error));
        this.client.removeListener('loggedOn', loggedOnHandler);
        logger.error(`❌ Login failed: ${err.message}`);
        logger.warn('⚠️ Session token may be expired. Will use password + 2FA on next attempt.');
        this.handleInvalidLoginKey(username, err).then(() => {
          reject(err);
        });
      };

      // Register handlers BEFORE logOn
      this.client.once('loggedOn', loggedOnHandler);
      this.client.once('error', errorHandler);
      this.client.logOn(loginOptions);
    });
  }

  /**
   * Handles invalid loginKey by deleting it and logging the issue
   * @param username - Steam username
   * @param error - The error that occurred
   */
  private async handleInvalidLoginKey(username: string, error: Error): Promise<void> {
    try {
      await fs.unlink(this.loginKeyPath);
      logger.info(`🗑️ Deleted invalid loginKey file: ${this.loginKeyPath}`);
      logger.warn('💡 Next login will use password + 2FA to generate a new loginKey');
    } catch {
      // File might not exist or already deleted
      logger.debug('LoginKey file not found or already deleted');
    }
  }

  /**
   * Checks if steam-user automatically saved loginKey in dataDirectory
   * steam-user may save session data automatically when dataDirectory is set
   */
  private async checkDataDirectoryForLoginKey(): Promise<boolean> {
    try {
      logger.debug(`🔍 Checking dataDirectory: ${this.dataDirectory}`);
      
      // List all files in dataDirectory
      const files = await fs.readdir(this.dataDirectory);
      logger.debug(`🔍 Found ${files.length} files in dataDirectory: ${files.join(', ')}`);
      
      // Look for files that might contain loginKey
      for (const file of files) {
        if (file.toLowerCase().includes('login') || file.toLowerCase().includes('key') || file.toLowerCase().includes('session')) {
          const filePath = path.join(this.dataDirectory, file);
          logger.info(`🔍 Found potential loginKey file: ${file}`);
          
          try {
            const content = await fs.readFile(filePath, 'utf8');
            const trimmed = content.trim();
            
            // Check if it looks like a loginKey (long string, usually base64-like)
            if (trimmed.length > 20 && trimmed.length < 1000) {
              logger.info(`📝 Found potential loginKey in ${file} (${trimmed.length} chars), attempting to save...`);
              const saved = await this.saveLoginKey(trimmed);
              if (saved) {
                return true;
              }
            } else {
              logger.debug(`🔍 File ${file} content doesn't look like loginKey (length: ${trimmed.length})`);
            }
          } catch (error) {
            logger.debug(`🔍 Could not read file ${file}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      
      return false;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.debug(`🔍 Error checking dataDirectory: ${errorMessage}`);
      return false;
    }
  }

  /**
   * Tries to extract loginKey from client internals after login
   * This is a fallback if the loginKey event doesn't fire
   */
  private async tryExtractLoginKeyFromClient(): Promise<boolean> {
    try {
      const clientAny = this.client as unknown as Record<string, unknown>;
      
      // Check various possible locations for loginKey
      const possiblePaths = [
        '_session.loginKey',
        '_session._loginKey',
        '_loginSession.loginKey',
        '_loginSession._loginKey',
        '_steamGuard.loginKey',
        '_steamGuard._loginKey',
        'loginKey',
        '_loginKey',
      ];
      
      for (const pathStr of possiblePaths) {
        const parts = pathStr.split('.');
        let value: unknown = clientAny;
        let found = true;

        for (const part of parts) {
          if (value && typeof value === 'object' && part in value) {
            value = (value as Record<string, unknown>)[part];
          } else {
            found = false;
            break;
          }
        }

        if (found && value && typeof value === 'string' && value.length > 0) {
          const saved = await this.saveLoginKey(value);
          if (saved) {
            return true;
          }
        }
      }

      // Check private properties
      const allKeys = Object.keys(clientAny);
      const privateKeys = allKeys.filter(k => 
        k.startsWith('_') && 
        k !== '_events' && 
        k !== '_eventsCount' && 
        k !== '_maxListeners' &&
        (k.toLowerCase().includes('login') || k.toLowerCase().includes('key'))
      );
      
      for (const key of privateKeys) {
        const value = clientAny[key];
        
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          const obj = value as Record<string, unknown>;
          if ('loginKey' in obj && typeof obj.loginKey === 'string' && obj.loginKey.length > 0) {
            const saved = await this.saveLoginKey(obj.loginKey);
            if (saved) {
              return true;
            }
          }
        } else if (typeof value === 'string' && value.length > 20 && key.toLowerCase().includes('key')) {
          const saved = await this.saveLoginKey(value);
          if (saved) {
            return true;
          }
        }
      }

      // Check _session and _loginSession for loginKey or refreshToken
      let foundRefreshToken: string | null = null;
      
      if (clientAny._session && typeof clientAny._session === 'object') {
        const session = clientAny._session as Record<string, unknown>;
        for (const key of Object.keys(session)) {
          const val = session[key];
          if (typeof val === 'string' && val.length > 20 && val.length < 1000) {
            if ((key.toLowerCase().includes('login') && key.toLowerCase().includes('key')) ||
                key.toLowerCase() === 'loginkey' || key.toLowerCase() === 'login_key') {
              const saved = await this.saveLoginKey(val);
              if (saved) {
                return true;
              }
            }
          }
        }
      }

      if (clientAny._loginSession && typeof clientAny._loginSession === 'object') {
        const loginSession = clientAny._loginSession as Record<string, unknown>;
        for (const key of Object.keys(loginSession)) {
          const val = loginSession[key];
          if (typeof val === 'string' && val.length > 20 && val.length < 1000) {
            if ((key.toLowerCase().includes('login') && key.toLowerCase().includes('key')) ||
                key.toLowerCase() === 'loginkey' || key.toLowerCase() === 'login_key') {
              const saved = await this.saveLoginKey(val);
              if (saved) {
                return true;
              }
            } else if (key.toLowerCase() === '_refreshtoken' || key.toLowerCase() === 'refreshtoken') {
              foundRefreshToken = val;
            }
          }
        }
      }
      
      // If no loginKey found, use refreshToken as fallback (works for Mobile Guard)
      if (foundRefreshToken) {
        // Saving refreshToken as fallback
        const saved = await this.saveLoginKey(foundRefreshToken);
        if (saved) {
          return true;
        }
      }
      
      return false;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      logger.error(`❌ LoginKey extraction attempt failed: ${errorMessage}`);
      if (errorStack) {
        logger.error(`❌ Error stack: ${errorStack}`);
      }
      return false;
    }
  }

  /**
   * Authenticates with Steam using password and optional 2FA
   * @param loginOptions - Login options including password, tokens, and 2FA
   * @returns Promise that resolves when logged in
   */
  private loginWithPassword(loginOptions: {
    accountName: string;
    password: string;
    machineAuthToken?: TokenData;
    shaSentryfile?: Buffer;
    twoFactorCode?: string;
  }): Promise<void> {
    return new Promise((resolve, reject) => {
      // Helper to extract token from client internals (NOT from _events)
      // This is needed for Mobile Guard where events don't fire
      const tryExtractTokenFromClient = async (): Promise<boolean> => {
        try {
          const clientAny = this.client as unknown as Record<string, unknown>;
          
          // Check _session.machineAuthToken (most common location)
          if (clientAny._session && typeof clientAny._session === 'object') {
            const session = clientAny._session as Record<string, unknown>;
            if (session.machineAuthToken && typeof session.machineAuthToken !== 'function') {
              logger.info('📝 Found machine auth token in _session.machineAuthToken');
              await this.saveSessionData(this.tokenPath, session.machineAuthToken as TokenData, '_session.machineAuthToken');
              return true;
            }
          }

          // Check _steamGuard.machineAuthToken
          if (clientAny._steamGuard && typeof clientAny._steamGuard === 'object') {
            const steamGuard = clientAny._steamGuard as Record<string, unknown>;
            if (steamGuard.machineAuthToken && typeof steamGuard.machineAuthToken !== 'function') {
              logger.info('📝 Found machine auth token in _steamGuard.machineAuthToken');
              await this.saveSessionData(this.tokenPath, steamGuard.machineAuthToken as TokenData, '_steamGuard.machineAuthToken');
              return true;
            }
          }

          // Check _loginSession.machineAuthToken
          if (clientAny._loginSession && typeof clientAny._loginSession === 'object') {
            const loginSession = clientAny._loginSession as Record<string, unknown>;
            if (loginSession.machineAuthToken && typeof loginSession.machineAuthToken !== 'function') {
              logger.info('📝 Found machine auth token in _loginSession.machineAuthToken');
              await this.saveSessionData(this.tokenPath, loginSession.machineAuthToken as TokenData, '_loginSession.machineAuthToken');
              return true;
            }
          }

          // Check direct property
          if (clientAny.machineAuthToken && typeof clientAny.machineAuthToken !== 'function') {
            logger.info('📝 Found machine auth token in direct property');
            await this.saveSessionData(this.tokenPath, clientAny.machineAuthToken as TokenData, 'direct property');
            return true;
          }

          return false;
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.debug(`🔍 Token extraction attempt failed: ${errorMessage}`);
          return false;
        }
      };

      // Handle login result
      const loggedOnHandler = async (details: unknown) => {
        const eventDetails = details as LoggedOnEvent;
        this.client.removeListener('error', errorHandler);
        const accountName = loginOptions.accountName || eventDetails?.accountName;
        logger.info(`✅ Successfully logged in as ${accountName}`);
        
        // CRITICAL: For Mobile Guard, loginKey might be available in client internals
        // Check for loginKey after login (events may not fire immediately)
          // Try to extract and save session token
          await this.tryExtractLoginKeyFromClient();
        
        // Also check for machine auth token
        await new Promise(resolve => setTimeout(resolve, TIMING.TOKEN_EXTRACTION_INITIAL_DELAY_MS));
        
        logger.info('🔍 Checking for machine auth token (Mobile Guard fallback)...');
        let tokenSaved = await tryExtractTokenFromClient();
        
        // Retry with delays if not found
        if (!tokenSaved) {
          for (let i = 0; i < TIMING.TOKEN_EXTRACTION_RETRY_DELAYS_MS.length && !tokenSaved; i++) {
            await new Promise(resolve => setTimeout(resolve, TIMING.TOKEN_EXTRACTION_RETRY_DELAYS_MS[i]));
            logger.debug(`🔍 Retrying token extraction (attempt ${i + 2})...`);
            tokenSaved = await tryExtractTokenFromClient();
          }
        }

        // Verify if loginKey file was created
        try {
          await fs.access(this.loginKeyPath);
          const stats = await fs.stat(this.loginKeyPath);
          // Session token file exists
        } catch {
          // Session token file not found (will be created on next login)
        }

        // Verify if token file was created
        try {
          await fs.access(this.tokenPath);
          const stats = await fs.stat(this.tokenPath);
          logger.info(`✅ Machine auth token saved successfully (${stats.size} bytes)`);
        } catch {
          logger.debug('Machine auth token file not found (this is OK for Mobile Guard)');
        }

        resolve();
      };

      const errorHandler = (error: unknown) => {
        const err = error instanceof Error ? error : new Error(String(error));
        this.client.removeListener('loggedOn', loggedOnHandler);
        reject(err);
      };

      // Register handlers BEFORE logOn
      // CRITICAL: Event listeners (loginKey, machineAuthToken, and sentry) are already registered
      // in setupEventListeners() which is called in the constructor
      this.client.once('loggedOn', loggedOnHandler);
      this.client.once('error', errorHandler);

      logger.info(`🔑 Attempting to log in as ${loginOptions.accountName}...`);
      this.client.logOn(loginOptions);
    });
  }

  /**
   * Generates a 2FA code from shared secret
   * @param sharedSecret - Steam shared secret
   * @returns 2FA code string
   */
  private generateTwoFactorCode(sharedSecret: string): string {
    return SteamTotp.generateAuthCode(sharedSecret);
  }

  /**
   * Gets the Steam User client instance
   * @returns The SteamUser client
   */
  getClient(): SteamUser {
    return this.client;
  }

  /**
   * Gets the account name
   * @returns The account name
   */
  getAccountName(): string {
    return this.accountName;
  }

  /**
   * Safely disconnects from Steam
   * Calls logOff() to gracefully sign out
   */
  disconnect(): void {
    try {
      if (this.client && typeof this.client.logOff === 'function') {
        this.client.logOff();
        logger.info('🔌 Disconnected from Steam');
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn(`⚠️ Error during Steam disconnect: ${errorMessage}`);
    }
  }
}
