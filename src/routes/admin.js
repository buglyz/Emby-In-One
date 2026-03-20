const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const { requireAuth } = require('../middleware/auth-middleware');
const { saveConfig, normalizeUpstream } = require('../config');
const { EmbyClient } = require('../emby-client');
const logger = require('../utils/logger');
const { getLogFilePath } = require('../utils/logger');
const capturedHeaders = require('../utils/captured-headers');

function createAdminRoutes(config, idManager, upstreamManager) {
  const router = Router();

  // All admin routes require auth
  router.use(requireAuth);

  // ========== Dashboard ==========

  router.get('/api/client-info', (req, res) => {
    res.json(capturedHeaders.getInfo());
  });

  router.get('/api/status', (req, res) => {
    const clients = upstreamManager.clients;
    res.json({
      serverName: config.server.name,
      serverId: config.server.id,
      port: config.server.port,
      playbackMode: config.playback.mode,
      idMappings: idManager.getStats(),
      upstreamCount: clients.length,
      upstreamOnline: clients.filter(c => c.online).length,
      upstream: clients.map(c => ({
        index: c.serverIndex,
        name: c.name,
        url: c.baseUrl,
        online: c.online,
        userId: c.userId,
        playbackMode: config.upstream[c.serverIndex]?.playbackMode || config.playback.mode,
      })),
    });
  });

  // ========== Upstream Servers ==========

  router.get('/api/upstream', (req, res) => {
    const list = config.upstream.map((s, index) => ({
      index,
      name: s.name,
      url: s.url,
      username: s.username,
      authType: s.apiKey ? 'apiKey' : 'password',
      online: upstreamManager.getClient(index)?.online || false,
      playbackMode: s.playbackMode || config.playback.mode,
      spoofClient: s.spoofClient || 'none',
      followRedirects: s.followRedirects !== false,
      proxyId: s.proxyId || null,
      priorityMetadata: s.priorityMetadata || false,
    }));
    res.json(list);
  });

  router.post('/api/upstream', async (req, res) => {
    try {
      const { name, url, username, password, apiKey, playbackMode, spoofClient, followRedirects, proxyId, priorityMetadata } = req.body;
      const newServer = { name, url, username, password, apiKey, playbackMode, spoofClient, followRedirects, proxyId, priorityMetadata };
      const index = config.upstream.length;
      normalizeUpstream(newServer, index, config);
      config.upstream.push(newServer);
      const client = new EmbyClient(newServer, index, config.proxies || [], config.timeouts || {});
      upstreamManager.clients.push(client);
      await client.login();
      saveConfig(config);
      res.json({ success: true, index, name: client.name, online: client.online });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/api/upstream/:index', async (req, res) => {
    try {
      const index = parseInt(req.params.index);
      if (index < 0 || index >= config.upstream.length) return res.status(404).end();
      const body = req.body;
      const serverConfig = config.upstream[index];
      const allowedKeys = ['name', 'url', 'username', 'password', 'apiKey', 'playbackMode', 'spoofClient', 'followRedirects', 'proxyId', 'priorityMetadata', 'streamingUrl'];
      for (const key of allowedKeys) {
        if (body[key] !== undefined) {
          // Don't overwrite password/apiKey with empty string — the frontend
          // clears these fields for security when opening the edit dialog.
          if ((key === 'password' || key === 'apiKey') && body[key] === '') continue;
          serverConfig[key] = body[key];
        }
      }
      const client = new EmbyClient(serverConfig, index, config.proxies || [], config.timeouts || {});
      upstreamManager.clients[index] = client;
      await client.login();
      saveConfig(config);
      res.json({ success: true, index, name: client.name, online: client.online });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/upstream/reorder', (req, res) => {
    const { fromIndex, toIndex } = req.body;
    if (fromIndex === undefined || toIndex === undefined) return res.status(400).end();
    const item = config.upstream.splice(fromIndex, 1)[0];
    config.upstream.splice(toIndex, 0, item);
    // Reorder existing clients (preserves login state, tokens, userId)
    const clientItem = upstreamManager.clients.splice(fromIndex, 1)[0];
    upstreamManager.clients.splice(toIndex, 0, clientItem);
    upstreamManager.clients.forEach((c, i) => c.serverIndex = i);
    saveConfig(config);
    res.json({ success: true });
  });

  router.delete('/api/upstream/:index', (req, res) => {
    const index = parseInt(req.params.index);
    if (index < 0 || index >= config.upstream.length) return res.status(404).end();
    const name = config.upstream[index].name;
    config.upstream.splice(index, 1);
    upstreamManager.clients.splice(index, 1);
    // Clean up ID mappings for the deleted server, then shift remaining indices
    idManager.removeByServerIndex(index);
    idManager.shiftServerIndices(index);
    upstreamManager.clients.forEach((c, i) => c.serverIndex = i);
    saveConfig(config);
    logger.info(`Upstream server "${name}" (index ${index}) deleted`);
    res.json({ success: true });
  });

  router.post('/api/upstream/:index/reconnect', async (req, res) => {
    const index = parseInt(req.params.index);
    const client = upstreamManager.clients[index];
    if (client) await client.login();
    res.json({ success: true, online: client?.online });
  });

  // ========== Proxies ==========

  router.get('/api/proxies', (req, res) => {
    res.json(config.proxies || []);
  });

  router.post('/api/proxies', (req, res) => {
    const { url, name } = req.body;
    const newProxy = { id: uuidv4().replace(/-/g, ''), name: name || 'Proxy', url };
    config.proxies = config.proxies || [];
    config.proxies.push(newProxy);
    saveConfig(config);
    res.json(newProxy);
  });

  router.delete('/api/proxies/:id', (req, res) => {
    const { id } = req.params;
    config.proxies = (config.proxies || []).filter(p => p.id !== id);
    saveConfig(config);
    res.status(204).end();
  });

  // ========== Settings ==========

  router.get('/api/settings', (req, res) => {
    res.json({
      serverName: config.server.name,
      port: config.server.port,
      playbackMode: config.playback.mode,
      adminUsername: config.admin.username,
      timeouts: config.timeouts || {},
    });
  });

  router.put('/api/settings', (req, res) => {
    const { serverName, playbackMode, adminUsername, adminPassword, timeouts } = req.body;
    if (serverName !== undefined) config.server.name = serverName;
    if (playbackMode !== undefined) config.playback.mode = playbackMode;
    if (adminUsername !== undefined) config.admin.username = adminUsername;
    if (adminPassword !== undefined && adminPassword !== '') config.admin.password = adminPassword;
    if (timeouts && typeof timeouts === 'object') {
      config.timeouts = config.timeouts || {};
      for (const key of ['api', 'global', 'login', 'healthCheck', 'healthInterval']) {
        if (timeouts[key] !== undefined) {
          const val = parseInt(timeouts[key]);
          if (!isNaN(val) && val > 0) config.timeouts[key] = val;
        }
      }
    }
    saveConfig(config);
    res.json({ success: true });
  });

  // ========== Logs ==========

  const logBuffer = [];
  const MAX_LOGS = 500;
  const { format } = require('winston');
  const Transport = require('winston-transport');

  class BufferTransport extends Transport {
    log(info, callback) {
      logBuffer.push({
        timestamp: info.timestamp || new Date().toISOString(),
        level: info.level,
        message: info.message,
      });
      if (logBuffer.length > MAX_LOGS) logBuffer.shift();
      callback();
    }
  }

  logger.add(new BufferTransport({
    format: format.combine(format.timestamp(), format.simple()),
  }));

  router.get('/api/logs', (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    res.json(logBuffer.slice(-limit));
  });

  // Download persistent log file
  router.get('/api/logs/download', (req, res) => {
    const logFile = getLogFilePath();
    if (!logFile) {
      return res.status(404).json({ error: 'Log file not found' });
    }
    // Winston tailable mode may write to emby-in-one1.log instead of emby-in-one.log
    const candidates = [logFile, logFile.replace(/\.log$/, '1.log')];
    const actualFile = candidates.find(f => fs.existsSync(f));
    if (!actualFile) {
      return res.status(404).json({ error: 'Log file not found' });
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="emby-in-one.log"');
    fs.createReadStream(actualFile).pipe(res);
  });

  // Clear persistent log file
  router.delete('/api/logs', (req, res) => {
    const logFile = getLogFilePath();
    if (logFile && fs.existsSync(logFile)) {
      fs.writeFileSync(logFile, '', 'utf8');
      logger.info('Log file cleared by admin');
    }
    logBuffer.length = 0;
    res.json({ success: true });
  });

  return router;
}

module.exports = { createAdminRoutes };
