/**
 * Type declarations for packages without TypeScript definitions
 * Concrete type definitions to replace 'any' usage throughout the codebase
 */

// ============================================================================
// Steam User Types
// ============================================================================

declare module 'steam-user' {
  import { EventEmitter } from 'events';

  /**
   * Options for SteamUser constructor
   */
  export interface SteamUserOptions {
    dataDirectory?: string;
    autoRelogin?: boolean;
    autoReloginDelay?: number; // Delay in milliseconds before retrying login (default: 1000)
    [key: string]: unknown;
  }

  /**
   * Options for logOn method
   */
  export interface LogOnOptions {
    accountName?: string;
    password?: string;
    loginKey?: string;
    refreshToken?: string;
    machineAuthToken?: string | Buffer | MachineAuthToken;
    shaSentryfile?: Buffer;
    steamGuardCode?: string;
    [key: string]: unknown;
  }

  /**
   * Machine auth token structure
   */
  export interface MachineAuthToken {
    token?: string;
    accountName?: string;
    savedAt?: string;
    [key: string]: unknown;
  }

  /**
   * Logged on event details
   */
  export interface LoggedOnEvent {
    steamID?: string;
    accountName?: string;
    [key: string]: unknown;
  }

  /**
   * Steam User client class
   */
  export default class SteamUser extends EventEmitter {
    constructor(options?: SteamUserOptions);

    // Authentication methods
    logOn(options: LogOnOptions): void;
    logOff(): void;

    // Persona and game status
    setPersona(state: number): void;
    gamesPlayed(appIds: number[]): void;

    // Event listeners with specific types (method overloads)
    on(event: 'loggedOn', listener: (details: LoggedOnEvent) => void): this;
    on(event: 'loginKey', listener: (key: string) => void): this;
    on(event: 'newLoginKey', listener: (key: string) => void): this;
    on(event: 'machineAuthToken', listener: (token: string | Buffer | MachineAuthToken) => void): this;
    on(event: 'sentry', listener: (sentry: Buffer) => void): this;
    on(event: 'steamGuardCode', listener: (domain: string, callback: (code: string) => void) => void): this;
    on(event: 'newGuardCode', listener: () => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    on(event: 'disconnected', listener: (eresult: number, msg?: string) => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;

    once(event: 'loggedOn', listener: (details: LoggedOnEvent) => void): this;
    once(event: 'error', listener: (error: Error) => void): this;
    once(event: string, listener: (...args: unknown[]) => void): this;

    removeListener(event: string, listener: (...args: unknown[]) => void): this;

    // Internal properties (for advanced usage)
    _steamUser?: SteamUser;
    _session?: unknown;
    _steamGuard?: unknown;
    _loginSession?: unknown;
    [key: string]: unknown;
  }
}

// ============================================================================
// Node-CS2 Types
// ============================================================================

declare module 'node-cs2' {
  import { EventEmitter } from 'events';
  import SteamUser from 'steam-user';

  /**
   * GC Connection Status
   * 0 = NoSession, 1 = NoUserSession, 2 = NoSessionButUser, 3 = Queue, 4 = Connected
   */
  export type GCConnectionStatus = 0 | 1 | 2 | 3 | 4;

  /**
   * Player commendations structure from GC
   */
  export interface PlayerCommendations {
    cmd_friendly: number;
    cmd_teaching: number;
    cmd_leader: number;
  }

  /**
   * Player medals structure from GC
   */
  export interface PlayerMedals {
    display_items_defidx?: number[];
    [key: string]: unknown;
  }

  /**
   * Player ranking structure from GC
   */
  export interface PlayerRanking {
    rank_id: number; // 0-18 (Silver 1 to Global Elite)
    wins: number;
    rank_change?: number;
    rank_type_id?: number; // 6 for Wingman, 7 for Danger Zone, 11 for Premier
  }

  /**
   * Complete CS2 player profile structure from GC (CMsgGCCStrike15_v2_ClientRequestPlayersProfile response)
   */
  export interface CS2ProfileResponse {
    account_id: number;
    player_level?: number;
    ongoingmatch?: unknown; // usually null
    global_stats?: unknown;
    penalty_seconds?: number;
    penalty_reason?: number;
    ranking?: PlayerRanking;
    commendation?: PlayerCommendations;
    medals?: {
      medal_team?: number;
      medal_combat?: number;
      medal_weapon?: number;
      medal_global?: number;
      display_items_defidx?: number[]; // The service medals (e.g., 2024 Red Service Medal)
    };
  }

  /**
   * Legacy alias for backwards compatibility
   */
  export interface PlayersProfile extends CS2ProfileResponse {}

  /**
   * GC Ready Event (when connected to GC)
   */
  export interface GCReadyEvent {
    appId?: number;
    version?: number;
    [key: string]: unknown;
  }

  /**
   * GC Message structure
   */
  export interface GCMessage {
    msgType: number;
    message: unknown;
  }

  /**
   * CS2 Game Coordinator client class
   */
  export default class CS2 extends EventEmitter {
    constructor(steamUser: SteamUser);

    // Connection methods
    connect?(): void;
    launch?(): void;
    requestSession?(): void;

    // Profile methods
    requestPlayersProfile?(steamId64: string | number): void;

    // Message methods
    send?(msgType: number, message: unknown): void;

    // Event listeners with specific types (method overloads)
    on(event: 'connectedToGC', listener: () => void): this;
    on(event: 'disconnectedFromGC', listener: (reason: number) => void): this;
    on(event: 'connectionStatus', listener: (status: GCConnectionStatus) => void): this;
    on(event: 'message', listener: (msgType: number, message: unknown) => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;

    once(event: 'connectedToGC', listener: () => void): this;
    once(event: string, listener: (...args: unknown[]) => void): this;

    removeListener(event: string, listener: (...args: unknown[]) => void): this;

    // Internal properties
    _steamUser?: SteamUser;
    [key: string]: unknown;
  }
}
