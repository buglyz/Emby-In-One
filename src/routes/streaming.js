const { Router } = require('express');
const { requireAuth } = require('../middleware/auth-middleware');
const { proxyStream, buildStreamUrl } = require('../utils/stream-proxy');
const logger = require('../utils/logger');

function createStreamingRoutes(config, idManager, upstreamManager) {
  const router = Router();

  /**
   * Resolve item ID and get stream configuration.
   */
  function resolveStreamRequest(req) {
    const itemId = req.params.itemId;
    const resolved = req.resolveId(itemId);
    if (!resolved) return null;

    const serverConfig = config.upstream[resolved.serverIndex];
    const playbackMode = serverConfig?.playbackMode || config.playback.mode || 'proxy';

    return { ...resolved, playbackMode };
  }

  /**
   * Handle a stream request: either proxy or redirect.
   */
  async function handleStream(req, res, pathBuilder) {
    const resolved = resolveStreamRequest(req);
    if (!resolved) {
      return res.status(404).json({ message: 'Item not found' });
    }

    // Resolve MediaSourceId in query params — this determines the ACTUAL server to stream from
    const params = { ...req.query };
    let virtualMsId = null;
    let actualClient = resolved.client;        // default: item's primary server
    let actualServerIndex = resolved.serverIndex;
    let actualOriginalId = resolved.originalId;

    if (params.MediaSourceId) {
      virtualMsId = params.MediaSourceId;
      const msResolved = idManager.resolveVirtualId(params.MediaSourceId);
      if (msResolved) {
        params.MediaSourceId = msResolved.originalId;
        // If MediaSource belongs to a different server than the item, switch to that server
        if (msResolved.serverIndex !== resolved.serverIndex) {
          const msClient = upstreamManager.getClient(msResolved.serverIndex);
          if (msClient && msClient.online) {
            actualClient = msClient;
            actualServerIndex = msResolved.serverIndex;
            // Also need the original item ID on THAT server
            const otherInst = (resolved.otherInstances || []).find(i => i.serverIndex === msResolved.serverIndex);
            if (otherInst) actualOriginalId = otherInst.originalId;
          }
        }
      }
    }
    if (params.PlaySessionId) {
      const psResolved = idManager.resolveVirtualId(params.PlaySessionId);
      if (psResolved) params.PlaySessionId = psResolved.originalId;
    }

    const upstreamPath = pathBuilder(actualOriginalId, req);
    let upstreamUrl;

    // Check if we have a specifically stored stream URL for this MediaSource
    const isTranscode = req.path.includes('master.m3u8') || req.path.includes('main.m3u8') || req.path.includes('hls');
    const storedUrl = idManager.getMediaSourceStreamUrl(isTranscode ? virtualMsId + '_transcode' : virtualMsId);

    if (storedUrl) {
      try {
        const url = new URL(storedUrl);
        for (const [k, v] of Object.entries(params)) {
          if (v != null && k !== 'api_key' && k !== 'ApiKey') {
            url.searchParams.set(k, v);
          }
        }
        upstreamUrl = url.toString();
      } catch (e) {
        upstreamUrl = buildStreamUrl(actualClient, upstreamPath, params);
      }
    } else {
      // Fallback: build from client base URL
      upstreamUrl = buildStreamUrl(actualClient, upstreamPath, params);
    }

    const serverConfig = config.upstream[actualServerIndex];
    const playbackMode = serverConfig?.playbackMode || config.playback.mode || 'proxy';

    if (playbackMode === 'redirect') {
      return res.redirect(302, upstreamUrl);
    }

    // Proxy mode
    try {
      const streamHeaders = actualClient.getRequestHeaders();
      logger.debug(`Stream headers for [${actualClient.name}]: ${JSON.stringify(streamHeaders)}`);
      // Attach proxy base URL and token so proxyStream can rewrite HLS manifest URLs
      req._proxyBase = `http://localhost:${config.server.port}`;
      req._proxyToken = req.query.api_key || req.proxyToken || '';
      await proxyStream(upstreamUrl, actualClient.accessToken, req, res, streamHeaders);
    } catch (err) {
      logger.error(`Stream error for ${req.path}: ${err.message}`);
      if (!res.headersSent) res.status(502).json({ message: 'Stream failed' });
    }
  }

  // GET /Videos/:itemId/stream
  // GET /Videos/:itemId/stream.:format
  router.get('/Videos/:itemId/stream', requireAuth, async (req, res) => {
    await handleStream(req, res, (origId) => `/Videos/${origId}/stream`);
  });
  router.get('/Videos/:itemId/stream.:format', requireAuth, async (req, res) => {
    await handleStream(req, res, (origId, r) => `/Videos/${origId}/stream.${r.params.format}`);
  });

  // GET /Audio/:itemId/stream
  // GET /Audio/:itemId/stream.:format
  router.get('/Audio/:itemId/stream', requireAuth, async (req, res) => {
    await handleStream(req, res, (origId) => `/Audio/${origId}/stream`);
  });
  router.get('/Audio/:itemId/stream.:format', requireAuth, async (req, res) => {
    await handleStream(req, res, (origId, r) => `/Audio/${origId}/stream.${r.params.format}`);
  });

  // GET /Audio/:itemId/universal
  router.get('/Audio/:itemId/universal', requireAuth, async (req, res) => {
    await handleStream(req, res, (origId) => `/Audio/${origId}/universal`);
  });

  // GET /Videos/:itemId/master.m3u8 — HLS master playlist
  router.get('/Videos/:itemId/master.m3u8', requireAuth, async (req, res) => {
    await handleStream(req, res, (origId) => `/Videos/${origId}/master.m3u8`);
  });

  // GET /Videos/:itemId/main.m3u8
  router.get('/Videos/:itemId/main.m3u8', requireAuth, async (req, res) => {
    await handleStream(req, res, (origId) => `/Videos/${origId}/main.m3u8`);
  });

  // GET /Videos/:itemId/hls1/:playlistId/:segmentId.:format — HLS segments
  router.get('/Videos/:itemId/hls1/:playlistId/:segmentId.:format', requireAuth, async (req, res) => {
    await handleStream(req, res, (origId, r) =>
      `/Videos/${origId}/hls1/${r.params.playlistId}/${r.params.segmentId}.${r.params.format}`
    );
  });

  // GET /Videos/:itemId/hls/:playlistFile — HLS playlist files
  router.get('/Videos/:itemId/hls/:playlistFile', requireAuth, async (req, res) => {
    await handleStream(req, res, (origId, r) => `/Videos/${origId}/hls/${r.params.playlistFile}`);
  });

  // GET /Videos/:itemId/:mediaSourceId/Subtitles/:subtitleIndex/:startTicks/Stream.:format
  router.get('/Videos/:itemId/:mediaSourceId/Subtitles/:subtitleIndex/:startTicks/Stream.:format', requireAuth, async (req, res) => {
    const { mediaSourceId, subtitleIndex, startTicks, format } = req.params;
    let origMediaSourceId = mediaSourceId;
    const msResolved = idManager.resolveVirtualId(mediaSourceId);
    if (msResolved) origMediaSourceId = msResolved.originalId;
    await handleStream(req, res, (origId) =>
      `/Videos/${origId}/${origMediaSourceId}/Subtitles/${subtitleIndex}/${startTicks}/Stream.${format}`
    );
  });

  // GET /Videos/:itemId/:mediaSourceId/Subtitles/:subtitleIndex/Stream.:format
  router.get('/Videos/:itemId/:mediaSourceId/Subtitles/:subtitleIndex/Stream.:format', requireAuth, async (req, res) => {
    const { mediaSourceId, subtitleIndex, format } = req.params;
    let origMediaSourceId = mediaSourceId;
    const msResolved = idManager.resolveVirtualId(mediaSourceId);
    if (msResolved) origMediaSourceId = msResolved.originalId;
    await handleStream(req, res, (origId) =>
      `/Videos/${origId}/${origMediaSourceId}/Subtitles/${subtitleIndex}/Stream.${format}`
    );
  });

  // GET /Videos/:itemId/:mediaSourceId/Attachments/:attachmentIndex
  router.get('/Videos/:itemId/:mediaSourceId/Attachments/:attachmentIndex', requireAuth, async (req, res) => {
    const { mediaSourceId, attachmentIndex } = req.params;
    let origMediaSourceId = mediaSourceId;
    const msResolved = idManager.resolveVirtualId(mediaSourceId);
    if (msResolved) origMediaSourceId = msResolved.originalId;
    await handleStream(req, res, (origId) =>
      `/Videos/${origId}/${origMediaSourceId}/Attachments/${attachmentIndex}`
    );
  });

  // DELETE /Videos/ActiveEncodings — stop transcoding
  router.delete('/Videos/ActiveEncodings', requireAuth, async (req, res) => {
    try {
      const params = { ...req.query };
      let serverIndex = null;

      if (params.PlaySessionId) {
        const resolved = idManager.resolveVirtualId(params.PlaySessionId);
        if (resolved) {
          params.PlaySessionId = resolved.originalId;
          serverIndex = resolved.serverIndex;
        }
      }

      if (serverIndex !== null) {
        const client = upstreamManager.getClient(serverIndex);
        if (client) {
          await client.request('DELETE', '/Videos/ActiveEncodings', { params });
        }
      } else {
        // Send to all servers
        const onlineClients = upstreamManager.getOnlineClients();
        await Promise.allSettled(
          onlineClients.map(c => c.request('DELETE', '/Videos/ActiveEncodings', { params }))
        );
      }

      res.status(204).end();
    } catch (err) {
      logger.error(`Error in DELETE ActiveEncodings: ${err.message}`);
      res.status(204).end();
    }
  });

  return router;
}

module.exports = { createStreamingRoutes };
