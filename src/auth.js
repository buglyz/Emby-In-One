const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const logger = require('./utils/logger');

/**
 * Proxy-level authentication manager.
 * Manages the proxy's own tokens (separate from upstream server tokens).
 * Tokens are persisted to disk so they survive restarts.
 */
function createAuthManager(config) {
  let TOKEN_FILE = path.resolve(__dirname, '..', 'data', 'tokens.json');

  // In Docker, prefer /app/data/tokens.json
  const DOCKER_DATA_DIR = '/app/data';
  if (fs.existsSync(DOCKER_DATA_DIR)) {
    TOKEN_FILE = path.join(DOCKER_DATA_DIR, 'tokens.json');
  }

  // token → { userId, username, createdAt }
  const tokens = new Map();

  // The proxy's own virtual user ID — loaded from disk or generated once
  let proxyUserId;
  let savedHadProxyUserId = false;

  // Load persisted tokens from disk
  try {
    const dir = path.dirname(TOKEN_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(TOKEN_FILE)) {
      const saved = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      // proxyUserId is stored as a top-level field, separate from tokens
      if (saved._proxyUserId) {
        proxyUserId = saved._proxyUserId;
        savedHadProxyUserId = true;
      }
      for (const [token, info] of Object.entries(saved)) {
        if (token !== '_proxyUserId') tokens.set(token, info);
      }
      logger.info(`Loaded ${tokens.size} persisted token(s)`);
    }
  } catch (err) {
    logger.warn(`Could not load persisted tokens: ${err.message}`);
  }

  // Generate proxyUserId if not loaded from disk
  if (!proxyUserId) {
    proxyUserId = uuidv4().replace(/-/g, '');
  }

  function saveTokens() {
    try {
      const obj = { _proxyUserId: proxyUserId };
      for (const [token, info] of tokens.entries()) {
        obj[token] = info;
      }
      fs.writeFileSync(TOKEN_FILE, JSON.stringify(obj, null, 2), 'utf8');
    } catch (err) {
      logger.warn(`Could not save tokens: ${err.message}`);
    }
  }

  // Persist proxyUserId immediately if it was just generated or was missing from disk
  if (!savedHadProxyUserId) {
    saveTokens();
  }

  /**
   * Authenticate a user against the proxy's admin credentials.
   * Returns an Emby-compatible auth response or null on failure.
   */
  function authenticate(username, password) {
    if (username !== config.admin.username || password !== config.admin.password) {
      return null;
    }

    const token = uuidv4().replace(/-/g, '');
    tokens.set(token, {
      userId: proxyUserId,
      username,
      createdAt: Date.now(),
    });

    saveTokens();
    logger.info(`User "${username}" authenticated, token=${token.substring(0, 8)}...`);

    return {
      User: buildUserObject(),
      SessionInfo: {
        UserId: proxyUserId,
        UserName: username,
        ServerId: config.server.id,
        Id: uuidv4().replace(/-/g, ''),
        DeviceId: 'proxy',
        DeviceName: 'Proxy Session',
        Client: 'Emby Aggregator',
        ApplicationVersion: '1.0.0',
        SupportsRemoteControl: false,
        PlayableMediaTypes: ['Audio', 'Video'],
        SupportedCommands: [],
      },
      AccessToken: token,
      ServerId: config.server.id,
    };
  }

  /**
   * Validate a token. Returns the token info or null.
   */
  function validateToken(token) {
    if (!token) return null;
    return tokens.get(token) || null;
  }

  /**
   * Get the proxy user ID.
   */
  function getProxyUserId() {
    return proxyUserId;
  }

  /**
   * Build an Emby-compatible user object for the proxy admin.
   */
  function buildUserObject() {
    return {
      Name: config.admin.username,
      ServerId: config.server.id,
      Id: proxyUserId,
      HasPassword: true,
      HasConfiguredPassword: true,
      HasConfiguredEasyPassword: false,
      EnableAutoLogin: false,
      Policy: {
        IsAdministrator: true,
        IsHidden: false,
        IsDisabled: false,
        EnableUserPreferenceAccess: true,
        EnableContentDownloading: true,
        EnableRemoteAccess: true,
        EnableLiveTvAccess: true,
        EnableLiveTvManagement: true,
        EnableMediaPlayback: true,
        EnableAudioPlaybackTranscoding: true,
        EnableVideoPlaybackTranscoding: true,
        EnablePlaybackRemuxing: true,
        EnableContentDeletion: false,
        EnableSyncTranscoding: true,
        EnableMediaConversion: true,
        EnableAllDevices: true,
        EnableAllChannels: true,
        EnableAllFolders: true,
        EnablePublicSharing: true,
        InvalidLoginAttemptCount: 0,
        RemoteClientBitrateLimit: 0,
      },
      Configuration: {
        PlayDefaultAudioTrack: true,
        DisplayMissingEpisodes: false,
        EnableLocalPassword: false,
        HidePlayedInLatest: true,
        RememberAudioSelections: true,
        RememberSubtitleSelections: true,
        EnableNextEpisodeAutoPlay: true,
      },
    };
  }

  return {
    authenticate,
    validateToken,
    getProxyUserId,
    buildUserObject,
  };
}

module.exports = { createAuthManager };
