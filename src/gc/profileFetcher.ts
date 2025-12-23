import CS2, { CS2ProfileResponse } from 'node-cs2';
import SteamUser from 'steam-user';
import { logger } from '../utils/logger';
import path from 'path';
import fs from 'fs/promises';

/**
 * Timing constants for profile fetching operations
 */
const TIMING = {
  /** Timeout for profile request (in milliseconds) */
  PROFILE_REQUEST_TIMEOUT_MS: 30000,
} as const;

/**
 * Interface for player commendations
 */
export interface PlayerCommendations {
  friendly: number;
  leader: number;
  teacher: number;
}

/**
 * Interface for service medal/pin
 */
export interface ServiceMedal {
  medalId: number;
  pinId?: number;
}

/**
 * Interface for player profile data
 */
export interface PlayerProfile {
  steamId64: string;
  commendations: PlayerCommendations;
  medals: ServiceMedal[];
  equippedMedal?: number | null;
  xpLevel?: number;
  fetchedAt: string;
}

/**
 * Fetches player profiles from the CS2 Game Coordinator
 * Handles CMsgGCCStrike15_v2_ClientRequestPlayersProfile (7501) requests
 * 
 * ⚠️ CRITICAL: This relies on node-cs2 which uses Valve's Protobuf definitions.
 * When Valve releases major CS2 updates (Operations, UI changes), protobufs often change.
 * 
 * Symptoms of outdated protobufs:
 * - Service connects but profileFetcher returns empty/garbage data
 * - Profile responses are missing fields or have wrong structure
 * 
 * Fix: Run `npm update node-cs2` to get the latest protobuf definitions.
 * If the library hasn't updated yet, the service may be non-functional until it does.
 */
export class ProfileFetcher {
  private gc: CS2;
  private outputDir: string;
  private steamUser?: SteamUser;
  private enableFileCache: boolean;

  constructor(gc: CS2, steamUser?: SteamUser) {
    this.gc = gc;
    this.steamUser = steamUser || gc._steamUser;
    this.outputDir = path.join(process.cwd(), 'output', 'profiles');
    // Enable file cache only if ENABLE_FILE_CACHE is explicitly set to 'true'
    this.enableFileCache = process.env.ENABLE_FILE_CACHE === 'true';
  }

  /**
   * Ensures the output directory exists (async)
   */
  private async ensureOutputDirectory(): Promise<void> {
    try {
      await fs.access(this.outputDir);
    } catch {
      await fs.mkdir(this.outputDir, { recursive: true });
    }
  }

  /**
   * Fetches a player profile for the given Steam ID
   * @param steamId64 - The Steam ID 64 of the player
   * @returns Promise that resolves with the player profile data
   */
  async fetchProfile(steamId64: string): Promise<PlayerProfile> {
    return new Promise((resolve, reject) => {
      // Validate Steam ID format for security
      if (!/^\d{17}$/.test(steamId64)) {
        reject(new Error('Invalid Steam ID 64 format. Must be 17 digits.'));
        return;
      }

      // Set timeout for request
      let timeout: NodeJS.Timeout;

      // Set up response handler for 'playersProfile#' event (node-cs2 specific)
      const eventName = `playersProfile#${steamId64}`;
      const responseHandler = async (profile: unknown) => {
        // Type guard: ensure profile is CS2ProfileResponse
        if (!profile || typeof profile !== 'object') {
          logger.error('❌ Invalid profile response format - possible protobuf mismatch');
          logger.error('💡 Try running: npm update node-cs2');
          throw new Error('Invalid profile response format - possible protobuf mismatch. Try updating node-cs2.');
        }
        const typedProfile = profile as CS2ProfileResponse;
        
        // Validate critical fields to detect protobuf changes
        if (!typedProfile.account_id && typedProfile.account_id !== 0) {
          logger.warn('⚠️ Profile response missing account_id - possible protobuf mismatch');
          logger.warn('💡 Try running: npm update node-cs2');
        }
        try {
          clearTimeout(timeout);
          
          const parsedProfile = await this.parseProfileResponse(typedProfile, steamId64);
          
          // Save to JSON file only if file cache is enabled
          if (this.enableFileCache) {
            await this.saveProfileToFile(parsedProfile);
          }

          this.gc.removeListener(eventName, responseHandler);
          resolve(parsedProfile);
        } catch (error: unknown) {
          this.gc.removeListener(eventName, responseHandler);
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error(`❌ Failed to parse profile response: ${errorMessage}`, { error });
          reject(error);
        }
      };

      // Listen for response using node-cs2's event format
      // Type assertion needed because event name is dynamic
      this.gc.once(eventName, responseHandler as (profile: unknown) => void);

      // Set timeout for request
      timeout = setTimeout(() => {
        this.gc.removeListener(eventName, responseHandler);
        reject(new Error(`Timeout waiting for profile response for ${steamId64}`));
      }, TIMING.PROFILE_REQUEST_TIMEOUT_MS);

      // Send request using node-cs2's built-in method
      try {
        if (this.gc.requestPlayersProfile) {
          this.gc.requestPlayersProfile(steamId64);
        } else {
          throw new Error('requestPlayersProfile method not available on GC instance');
        }
      } catch (error: unknown) {
        clearTimeout(timeout);
        this.gc.removeListener(eventName, responseHandler);
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`❌ Failed to send GC request: ${errorMessage}`);
        reject(error);
      }
    });
  }

  /**
   * Parses the profile response from node-cs2 to extract commendations and medals
   * @param profile - The CS2 profile object from node-cs2 (already parsed from protobuf)
   * @param steamId64 - The Steam ID 64 for the profile
   * @returns Parsed player profile
   */
  private async parseProfileResponse(profile: CS2ProfileResponse, steamId64: string): Promise<PlayerProfile> {
    // Extract commendations (CS2 uses cmd_friendly, cmd_teaching, cmd_leader)
    // If these fields are missing, it might indicate a protobuf change
    const commendations: PlayerCommendations = {
      friendly: profile.commendation?.cmd_friendly || 0,
      leader: profile.commendation?.cmd_leader || 0,
      teacher: profile.commendation?.cmd_teaching || 0,
    };
    
    // Warn if commendations structure seems wrong (all zeros might be normal, but missing structure is suspicious)
    if (!profile.commendation && (profile as unknown as Record<string, unknown>).commendation === undefined) {
      logger.warn('⚠️ Profile response missing commendation structure - possible protobuf change');
    }

    // Extract medals (CS2 uses display_items_defidx array)
    let medals: ServiceMedal[] = [];
    if (profile.medals?.display_items_defidx && Array.isArray(profile.medals.display_items_defidx)) {
      const uniqueMedalIds = Array.from(
        new Set(profile.medals.display_items_defidx.filter((id): id is number => typeof id === 'number'))
      );

      medals = uniqueMedalIds.map((medalId) => ({
        medalId,
      }));
    }

    // Equipped medal: assume the first display_items_defidx is the equipped one
    const equippedMedal =
      profile.medals?.display_items_defidx && Array.isArray(profile.medals.display_items_defidx)
        ? profile.medals.display_items_defidx[0] ?? null
        : null;

    // Extract XP level (CS2 uses player_level field)
    const xpLevel = profile.player_level;

    // Log ranking info if available (for debugging)
    if (profile.ranking) {
      logger.info(`📊 Rank: ${profile.ranking.rank_id}, Wins: ${profile.ranking.wins}`);
    }

    return {
      steamId64,
      commendations,
      medals,
      equippedMedal,
      xpLevel,
      fetchedAt: new Date().toISOString(),
    };
  }

  /**
   * Converts Steam ID 64 to account ID format
   * @param steamId64 - Steam ID 64 string
   * @returns Account ID number
   */
  private steamId64ToAccountId(steamId64: string): number {
    const id = BigInt(steamId64);
    return Number(id & BigInt(0xFFFFFFFF));
  }

  /**
   * Saves the profile data to a JSON file (async)
   * @param profile - The player profile to save
   */
  private async saveProfileToFile(profile: PlayerProfile): Promise<void> {
    try {
      // Validate Steam ID for path security
      if (!/^\d{17}$/.test(profile.steamId64)) {
        throw new Error(`Invalid Steam ID 64 format: ${profile.steamId64}`);
      }

      // Ensure directory exists
      await this.ensureOutputDirectory();

      const filePath = path.join(this.outputDir, `${profile.steamId64}.json`);
      await fs.writeFile(filePath, JSON.stringify(profile, null, 2), 'utf8');
    } catch (error) {
      logger.error(`❌ Failed to save profile to file: ${error}`);
      throw error;
    }
  }

  /**
   * Loads a profile from disk if it exists (async)
   * @param steamId64 - The Steam ID 64 to load
   * @returns The profile or null if not found
   */
  async loadProfileFromFile(steamId64: string): Promise<PlayerProfile | null> {
    try {
      // Validate Steam ID for path security
      if (!/^\d{17}$/.test(steamId64)) {
        logger.warn(`⚠️ Invalid Steam ID 64 format: ${steamId64}`);
        return null;
      }

      const filePath = path.join(this.outputDir, `${steamId64}.json`);
      try {
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
      } catch {
        // File doesn't exist, return null
        return null;
      }
    } catch (error) {
      logger.warn(`⚠️ Failed to load profile from file: ${error}`);
      return null;
    }
  }
}

