/**
 * AsyncLocalStorage-based store for passing the original client's
 * request headers through to upstream EmbyClient calls without
 * modifying every route handler.
 */
const { AsyncLocalStorage } = require('async_hooks');
module.exports = new AsyncLocalStorage();
