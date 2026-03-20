const http = require('http');
const https = require('https');
const { URL } = require('url');
const logger = require('./logger');
const requestStore = require('./request-store');

/**
 * Rewrite HLS manifest (.m3u8) content so that segment/playlist URLs
 * point back to the proxy instead of the upstream server directly.
 * @param {string} content - Raw m3u8 text from upstream
 * @param {string} upstreamBase - Upstream server base URL (protocol + host)
 * @param {string} proxyBase - Proxy base URL for the client (e.g. http://proxy:8096)
 * @param {string} proxyToken - Proxy auth token to append
 */
function rewriteM3u8(content, upstreamBase, proxyBase, proxyToken) {
  return content.replace(/^(?!#)(.+)$/gm, (line) => {
    line = line.trim();
    if (!line) return line;
    let fullUrl;
    try {
      fullUrl = new URL(line, upstreamBase).toString();
    } catch (e) {
      return line; // not a URL, leave as-is
    }
    // Rebuild as a path relative to proxyBase with api_key
    const u = new URL(fullUrl);
    u.searchParams.delete('api_key');
    u.searchParams.delete('ApiKey');
    if (proxyToken) u.searchParams.set('api_key', proxyToken);
    // Use proxy origin but keep the upstream path+query
    const proxyOrigin = new URL(proxyBase);
    return `${proxyOrigin.origin}${u.pathname}${u.search}`;
  });
}

/**
 * Proxy an upstream stream response to the client.
 * Uses Node's built-in http/https for proper backpressure and cleanup.
 * Now supports automatic redirect following and custom headers.
 */
function proxyStream(upstreamUrl, token, req, res, extraHeaders = {}, followCount = 0) {
  if (followCount > 5) {
    logger.error(`Too many redirects for ${upstreamUrl}`);
    if (!res.headersSent) res.status(502).json({ message: 'Too many redirects' });
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    function done() {
      if (!settled) { settled = true; resolve(); }
    }

    let parsed;
    try {
      parsed = new URL(upstreamUrl);
    } catch (e) {
      logger.error(`Invalid stream URL: ${upstreamUrl}`);
      if (!res.headersSent) res.status(502).json({ message: 'Invalid upstream URL' });
      return done();
    }

    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { ...extraHeaders },
    };

    if (req.headers.range) options.headers['Range'] = req.headers.range;
    if (req.headers.accept) options.headers['Accept'] = req.headers.accept;
    if (token) options.headers['X-Emby-Token'] = token;
    // Forward User-Agent from original client as fallback (important for servers with client whitelists)
    if (!options.headers['User-Agent'] && !options.headers['user-agent']) {
      const clientHeaders = requestStore.getStore();
      if (clientHeaders && clientHeaders['user-agent']) {
        options.headers['User-Agent'] = clientHeaders['user-agent'];
      }
    }

    logger.debug(`Stream proxy: ${parsed.hostname}${parsed.pathname.substring(0, 60)} headers=${JSON.stringify(options.headers)}`);

    const upstreamReq = lib.request(options, (upstreamRes) => {
      const statusCode = upstreamRes.statusCode;

      if (statusCode === 401 || statusCode === 403) {
        logger.warn(`Stream ${statusCode} from ${parsed.hostname}: path=${parsed.pathname.substring(0, 80)} sentHeaders=${JSON.stringify(Object.keys(options.headers))}`);
      }

      // Handle Redirects
      if ([301, 302, 303, 307, 308].includes(statusCode) && upstreamRes.headers.location) {
        let redirectUrl = upstreamRes.headers.location;
        if (!redirectUrl.startsWith('http')) {
          redirectUrl = new URL(redirectUrl, upstreamUrl).toString();
        }
        // logger.debug(`Following redirect to: ${redirectUrl}`);
        upstreamRes.destroy();
        return proxyStream(redirectUrl, token, req, res, extraHeaders, followCount + 1).then(done);
      }

      if (res.headersSent) {
        upstreamRes.destroy();
        return done();
      }

      res.status(statusCode);

      const forwardHeaders = [
        'content-type', 'content-length', 'content-range',
        'accept-ranges', 'content-disposition', 'cache-control',
        'etag', 'last-modified', 'transfer-encoding',
      ];
      for (const h of forwardHeaders) {
        if (upstreamRes.headers[h]) res.set(h, upstreamRes.headers[h]);
      }

      // Destroy upstream on client disconnect
      function cleanup() {
        if (!upstreamRes.destroyed) upstreamRes.destroy();
        if (!upstreamReq.destroyed) upstreamReq.destroy();
        done();
      }

      req.on('close', cleanup);
      req.on('aborted', cleanup);
      res.on('close', cleanup);

      // Rewrite HLS manifest segment URLs so they route through the proxy
      const contentType = upstreamRes.headers['content-type'] || '';
      const isM3u8 = contentType.includes('mpegurl') || parsed.pathname.endsWith('.m3u8');

      if (isM3u8 && req._proxyBase) {
        // Buffer the manifest, rewrite URLs, then send
        res.removeHeader('content-length');
        let body = '';
        upstreamRes.setEncoding('utf8');
        upstreamRes.on('data', chunk => { body += chunk; });
        upstreamRes.on('end', () => {
          const rewritten = rewriteM3u8(body, upstreamUrl, req._proxyBase, req._proxyToken);
          res.set('content-type', 'application/x-mpegURL');
          res.end(rewritten);
          done();
        });
      } else {
        upstreamRes.pipe(res);
        upstreamRes.on('end', done);
      }
      upstreamRes.on('error', (err) => {
        logger.error(`Upstream stream error: ${err.message}`);
        if (!res.headersSent) res.status(502).end();
        done();
      });
    });

    upstreamReq.on('error', (err) => {
      logger.error(`Stream upstream request error: ${err.message}`);
      if (!res.headersSent) res.status(502).json({ message: 'Failed to proxy stream' });
      done();
    });

    upstreamReq.end();
  });
}

/**
 * Build the full upstream URL for a stream request.
 * Uses streamBaseUrl if available (for servers with different streaming domains).
 */
function buildStreamUrl(client, path, queryParams = {}) {
  const base = client.streamBaseUrl || client.baseUrl;
  const url = new URL(path, base);
  if (client.accessToken) {
    url.searchParams.set('api_key', client.accessToken);
  }
  for (const [k, v] of Object.entries(queryParams)) {
    if (v != null && k !== 'api_key' && k !== 'ApiKey') {
      url.searchParams.set(k, v);
    }
  }
  return url.toString();
}

module.exports = { proxyStream, buildStreamUrl, rewriteM3u8 };
