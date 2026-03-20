const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const logger = require('./utils/logger');

/**
 * ID Manager: maintains bidirectional mapping between virtual IDs and original IDs.
 * Uses SQLite for persistence when available, falls back to in-memory Map.
 */
function createIdManager(dataDir) {
  let db = null;
  let stmtInsert = null;
  let stmtGetByVirtual = null;
  let stmtGetByOriginal = null;
  let stmtCount = null;

  // In-memory fallback
  const virtualToOriginal = new Map();
  const originalToVirtual = new Map();

  // Try to initialize SQLite
  try {
    const Database = require('better-sqlite3');
    const dbDir = dataDir || path.resolve(__dirname, '..', 'data');
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

    const dbPath = path.join(dbDir, 'mappings.db');
    db = new Database(dbPath);

    // WAL mode for better concurrent performance
    db.pragma('journal_mode = WAL');

    db.exec(`
      CREATE TABLE IF NOT EXISTS id_mappings (
        virtual_id TEXT PRIMARY KEY,
        original_id TEXT NOT NULL,
        server_index INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_original ON id_mappings(original_id, server_index);
    `);

    stmtInsert = db.prepare('INSERT OR IGNORE INTO id_mappings (virtual_id, original_id, server_index) VALUES (?, ?, ?)');
    stmtGetByVirtual = db.prepare('SELECT original_id, server_index FROM id_mappings WHERE virtual_id = ?');
    stmtGetByOriginal = db.prepare('SELECT virtual_id FROM id_mappings WHERE original_id = ? AND server_index = ?');
    stmtCount = db.prepare('SELECT COUNT(*) as count FROM id_mappings');

    // Load existing mappings into memory cache for speed
    const rows = db.prepare('SELECT virtual_id, original_id, server_index FROM id_mappings').all();
    for (const row of rows) {
      virtualToOriginal.set(row.virtual_id, { originalId: row.original_id, serverIndex: row.server_index });
      originalToVirtual.set(`${row.original_id}:${row.server_index}`, row.virtual_id);
    }

    logger.info(`SQLite ID store initialized: ${rows.length} existing mappings loaded`);
  } catch (err) {
    logger.warn(`SQLite not available (${err.message}), using in-memory ID store`);
    db = null;
  }

  function _compositeKey(originalId, serverIndex) {
    return `${originalId}:${serverIndex}`;
  }

  function getOrCreateVirtualId(originalId, serverIndex) {
    if (originalId == null || originalId === "") return originalId;

    // If it's already a virtual ID that we know about, return it as-is
    if (virtualToOriginal.has(originalId)) {
      return originalId;
    }

    const key = _compositeKey(originalId, serverIndex);
    let virtualId = originalToVirtual.get(key);
    if (virtualId) return virtualId;

    virtualId = uuidv4().replace(/-/g, '');
    virtualToOriginal.set(virtualId, { originalId, serverIndex, otherInstances: [] });
    originalToVirtual.set(key, virtualId);

    // Persist to SQLite
    if (stmtInsert) {
      try { stmtInsert.run(virtualId, originalId, serverIndex); } catch (e) {
        logger.warn(`SQLite insert failed: ${e.message}`);
      }
    }

    return virtualId;
  }

  function setMediaSourceStreamUrl(virtualId, streamUrl) {
    const resolved = virtualToOriginal.get(virtualId);
    if (resolved) {
      resolved.streamUrl = streamUrl;
    }
  }

  function getMediaSourceStreamUrl(virtualId) {
    return virtualToOriginal.get(virtualId)?.streamUrl || null;
  }

  function associateAdditionalInstance(virtualId, originalId, serverIndex) {
    const resolved = virtualToOriginal.get(virtualId);
    if (!resolved) return;

    if (resolved.originalId === originalId && resolved.serverIndex === serverIndex) return;

    if (!resolved.otherInstances) resolved.otherInstances = [];

    const exists = resolved.otherInstances.some(inst => inst.originalId === originalId && inst.serverIndex === serverIndex);
    if (!exists) {
      resolved.otherInstances.push({ originalId, serverIndex });
      // Note: In a full implementation, we might want to persist these secondary mappings too.
      // For now, we'll keep them in memory for the current session's merged results.
    }
  }

  function resolveVirtualId(virtualId) {
    if (!virtualId) return null;
    const resolved = virtualToOriginal.get(virtualId) || null;
    if (resolved) {
      // logger.debug(`Resolved virtualId=${virtualId} → originalId=${resolved.originalId} [Server ${resolved.serverIndex}]`);
    } else {
      // logger.debug(`Failed to resolve virtualId=${virtualId}`);
    }
    return resolved;
  }

  function isVirtualId(id) {
    return virtualToOriginal.has(id);
  }

  function getStats() {
    return {
      mappingCount: virtualToOriginal.size,
      persistent: db !== null,
    };
  }

  /**
   * Remove all ID mappings for a given server index.
   * Called when an upstream server is deleted.
   */
  function removeByServerIndex(serverIndex) {
    let removed = 0;
    for (const [virtualId, info] of virtualToOriginal.entries()) {
      if (info.serverIndex === serverIndex) {
        originalToVirtual.delete(_compositeKey(info.originalId, serverIndex));
        virtualToOriginal.delete(virtualId);
        removed++;
      }
    }
    // Also remove secondary instances pointing to this server
    for (const [, info] of virtualToOriginal.entries()) {
      if (info.otherInstances) {
        info.otherInstances = info.otherInstances.filter(inst => inst.serverIndex !== serverIndex);
      }
    }
    if (db) {
      try { db.prepare('DELETE FROM id_mappings WHERE server_index = ?').run(serverIndex); } catch (e) {
        logger.warn(`SQLite delete failed: ${e.message}`);
      }
    }
    logger.info(`Removed ${removed} ID mappings for server index ${serverIndex}`);
    return removed;
  }

  /**
   * Shift server indices down by 1 for all mappings where serverIndex > deletedIndex.
   * Called after an upstream server is deleted to keep indices consistent.
   */
  function shiftServerIndices(deletedIndex) {
    // Rebuild originalToVirtual keys (they contain serverIndex)
    for (const [virtualId, info] of virtualToOriginal.entries()) {
      if (info.serverIndex > deletedIndex) {
        originalToVirtual.delete(_compositeKey(info.originalId, info.serverIndex));
        info.serverIndex--;
        originalToVirtual.set(_compositeKey(info.originalId, info.serverIndex), virtualId);
      }
      if (info.otherInstances) {
        for (const inst of info.otherInstances) {
          if (inst.serverIndex > deletedIndex) inst.serverIndex--;
        }
      }
    }
    if (db) {
      try {
        db.prepare('UPDATE id_mappings SET server_index = server_index - 1 WHERE server_index > ?').run(deletedIndex);
      } catch (e) {
        logger.warn(`SQLite update failed: ${e.message}`);
      }
    }
    logger.info(`Shifted server indices after deleting index ${deletedIndex}`);
  }

  return {
    getOrCreateVirtualId,
    associateAdditionalInstance,
    setMediaSourceStreamUrl,
    getMediaSourceStreamUrl,
    resolveVirtualId,
    isVirtualId,
    getStats,
    removeByServerIndex,
    shiftServerIndices,
  };
}

module.exports = { createIdManager };
