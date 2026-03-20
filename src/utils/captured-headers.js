/**
 * Stores real client headers captured during authentication.
 * When a real Emby client (Infuse, Emby for Android, etc.) logs into
 * emby-in-one, we capture its headers and reuse them for upstream
 * requests in passthrough mode — ensuring they pass client whitelists.
 */
let captured = null;
let capturedAt = null;

module.exports = {
  set(reqHeaders) {
    captured = {};
    const keys = [
      'user-agent',
      'x-emby-client', 'x-emby-client-version',
      'x-emby-device-name', 'x-emby-device-id',
      'accept', 'accept-language',
    ];
    for (const k of keys) {
      if (reqHeaders[k]) captured[k] = reqHeaders[k];
    }
    capturedAt = new Date().toISOString();
  },
  get() { return captured; },
  getInfo() {
    if (!captured) return null;
    return {
      userAgent: captured['user-agent'] || null,
      client: captured['x-emby-client'] || null,
      clientVersion: captured['x-emby-client-version'] || null,
      deviceName: captured['x-emby-device-name'] || null,
      deviceId: captured['x-emby-device-id'] || null,
      capturedAt,
    };
  },
};
