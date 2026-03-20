const { Router } = require('express');
const { requireAuth } = require('../middleware/auth-middleware');
const { rewriteResponseIds } = require('../utils/id-rewriter');
const capturedHeaders = require('../utils/captured-headers');
const logger = require('../utils/logger');

function createUserRoutes(config, authManager, idManager, upstreamManager) {
  const router = Router();

  // POST /Users/AuthenticateByName
  router.post('/Users/AuthenticateByName', (req, res) => {
    const { Username, Pw, Password } = req.body;
    const password = Pw || Password || '';

    // Log client identification headers
    const clientInfo = {
      userAgent: req.headers['user-agent'],
      client: req.headers['x-emby-client'],
      device: req.headers['x-emby-device-name'],
      deviceId: req.headers['x-emby-device-id'],
      version: req.headers['x-emby-client-version'],
    };
    logger.info(`Login attempt: user="${Username}" client="${clientInfo.client || 'unknown'}" device="${clientInfo.device || 'unknown'}" ip=${req.ip}`);
    logger.debug(`Login headers: UA="${clientInfo.userAgent}" DeviceId="${clientInfo.deviceId}" Version="${clientInfo.version}"`);

    const result = authManager.authenticate(Username, password);
    if (!result) {
      logger.warn(`Login failed: user="${Username}" ip=${req.ip} client="${clientInfo.client || 'unknown'}"`);
      return res.status(401).json({ message: 'Invalid username or password' });
    }

    logger.info(`Login success: user="${Username}" ip=${req.ip}`);

    // Capture real client headers for passthrough mode
    capturedHeaders.set(req.headers);
    const ua = req.headers['user-agent'] || 'unknown';
    const client = req.headers['x-emby-client'] || '';
    logger.info(`Captured client headers: ${client ? client + ' / ' : ''}${ua}`);

    // Auto re-login offline passthrough servers with the real client identity
    for (const c of upstreamManager.clients) {
      if (!c.online && c.config.spoofClient === 'passthrough') {
        logger.info(`[${c.name}] Re-trying login with captured client headers...`);
        c.login().catch(() => {});
      }
    }

    res.json(result);
  });

  // GET /Users/Public
  router.get('/Users/Public', (req, res) => {
    res.json([{
      Name: config.admin.username,
      ServerId: config.server.id,
      Id: authManager.getProxyUserId(),
      HasPassword: true,
      HasConfiguredPassword: true,
      HasConfiguredEasyPassword: false,
      PrimaryImageTag: undefined,
    }]);
  });

  // GET /Users/:userId
  router.get('/Users/:userId', requireAuth, (req, res) => {
    res.json(authManager.buildUserObject());
  });

  // GET /Users/:userId/Views — merge views from all upstream servers
  router.get('/Users/:userId/Views', requireAuth, async (req, res) => {
    try {
      const onlineClients = upstreamManager.getOnlineClients();
      const results = await Promise.allSettled(
        onlineClients.map(async (client) => {
          const data = await client.request('GET', `/Users/${client.userId}/Views`);
          return { serverIndex: client.serverIndex, data };
        })
      );

      const successResults = results
        .filter(r => r.status === 'fulfilled')
        .map(r => r.value);

      // Keep ALL views from ALL servers — each gets its own virtual ID
      // Use "serverIndex:CollectionType" to avoid showing duplicates only within the same server
      const allViews = [];
      for (const { serverIndex, data } of successResults) {
        const items = data.Items || [];
        for (const item of items) {
          const rewritten = rewriteResponseIds(
            JSON.parse(JSON.stringify(item)),
            serverIndex, idManager, config.server.id, authManager.getProxyUserId()
          );
          // Tag the view name with server name to distinguish same-type libraries
          const client = upstreamManager.getClient(serverIndex);
          if (client && onlineClients.length > 1) {
            rewritten.Name = `${rewritten.Name} (${client.name})`;
          }
          allViews.push(rewritten);
        }
      }

      res.json({
        Items: allViews,
        TotalRecordCount: allViews.length,
        StartIndex: 0,
      });
    } catch (err) {
      logger.error(`Error fetching views: ${err.message}`);
      res.status(500).json({ message: 'Failed to fetch views' });
    }
  });

  // GET /Users/:userId/GroupingOptions
  router.get('/Users/:userId/GroupingOptions', requireAuth, (req, res) => {
    res.json([]);
  });

  // POST /Users/:userId/Configuration
  router.post('/Users/:userId/Configuration', requireAuth, (req, res) => {
    res.status(204).end();
  });

  // POST /Users/:userId/Policy
  router.post('/Users/:userId/Policy', requireAuth, (req, res) => {
    res.status(204).end();
  });

  return router;
}

module.exports = { createUserRoutes };
