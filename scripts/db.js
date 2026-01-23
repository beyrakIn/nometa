/**
 * SQLite Database Module for NoMeta.az Blog
 * Single source of truth for all article data
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const CONTENT_DIR = path.join(__dirname, '..', 'content');
const DB_PATH = path.join(CONTENT_DIR, 'nometa.db');

let db = null;

/**
 * Initialize database with schema
 */
function initDb() {
    if (db) return db;

    // Create content directory if it doesn't exist
    if (!fs.existsSync(CONTENT_DIR)) {
        fs.mkdirSync(CONTENT_DIR, { recursive: true });
        logger.debug('db', 'Created content directory', { path: CONTENT_DIR });
    }

    try {
        db = new Database(DB_PATH);

        // Enable WAL mode for better concurrent access
        db.pragma('journal_mode = WAL');

        // Create articles table
        db.exec(`
            CREATE TABLE IF NOT EXISTS articles (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                original_url TEXT UNIQUE NOT NULL,
                source TEXT NOT NULL,
                source_url TEXT,
                published_date TEXT,
                description TEXT,
                content TEXT,
                slug TEXT UNIQUE NOT NULL,
                status TEXT DEFAULT 'pending',
                fetched_at TEXT,

                -- translation fields
                translated_title TEXT,
                translated_content TEXT,
                translated_at TEXT,
                translation_provider TEXT,
                published_at TEXT
            )
        `);

        // Create indexes
        db.exec(`
            CREATE INDEX IF NOT EXISTS idx_articles_status ON articles(status);
            CREATE INDEX IF NOT EXISTS idx_articles_source ON articles(source);
            CREATE INDEX IF NOT EXISTS idx_articles_slug ON articles(slug);
        `);

        // Create metadata table
        db.exec(`
            CREATE TABLE IF NOT EXISTS metadata (
                key TEXT PRIMARY KEY,
                value TEXT
            )
        `);

        // Create api_keys table for translation providers
        db.exec(`
            CREATE TABLE IF NOT EXISTS api_keys (
                provider TEXT PRIMARY KEY,
                api_key TEXT NOT NULL,
                enabled INTEGER DEFAULT 1,
                created_at TEXT,
                updated_at TEXT
            )
        `);

        logger.info('db', 'Database initialized', { path: DB_PATH });
        return db;
    } catch (error) {
        logger.error('db', 'Database initialization failed', {
            path: DB_PATH,
            error: error.message,
            stack: error.stack
        });
        throw error;
    }
}

/**
 * Get database instance (initializes if needed)
 */
function getDb() {
    if (!db) {
        initDb();
    }
    return db;
}

/**
 * Close database connection
 */
function closeDb() {
    if (db) {
        db.close();
        db = null;
    }
}

/**
 * Get all articles with optional filters
 * @param {Object} filters - Optional filters { status: string|string[], source: string }
 */
function getAllArticles(filters = {}) {
    const db = getDb();
    let query = 'SELECT * FROM articles';
    const conditions = [];
    const params = [];

    if (filters.status) {
        if (Array.isArray(filters.status)) {
            conditions.push(`status IN (${filters.status.map(() => '?').join(', ')})`);
            params.push(...filters.status);
        } else {
            conditions.push('status = ?');
            params.push(filters.status);
        }
    }

    if (filters.source) {
        conditions.push('source = ?');
        params.push(filters.source);
    }

    if (conditions.length > 0) {
        query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY fetched_at DESC, published_date DESC';

    const rows = db.prepare(query).all(...params);
    return rows.map(rowToArticle);
}

/**
 * Get article by ID
 */
function getArticleById(id) {
    const db = getDb();
    const row = db.prepare('SELECT * FROM articles WHERE id = ?').get(id);
    return row ? rowToArticle(row) : null;
}

/**
 * Get article by slug
 */
function getArticleBySlug(slug) {
    const db = getDb();
    const row = db.prepare('SELECT * FROM articles WHERE slug = ?').get(slug);
    return row ? rowToArticle(row) : null;
}

/**
 * Get article by original URL
 */
function getArticleByUrl(originalUrl) {
    const db = getDb();
    const row = db.prepare('SELECT * FROM articles WHERE original_url = ?').get(originalUrl);
    return row ? rowToArticle(row) : null;
}

/**
 * Insert a new article
 */
function insertArticle(article) {
    const db = getDb();
    const stmt = db.prepare(`
        INSERT INTO articles (
            id, title, original_url, source, source_url, published_date,
            description, content, slug, status, fetched_at,
            translated_title, translated_content, translated_at,
            translation_provider, published_at
        ) VALUES (
            @id, @title, @originalUrl, @source, @sourceUrl, @publishedDate,
            @description, @content, @slug, @status, @fetchedAt,
            @translatedTitle, @translatedContent, @translatedAt,
            @translationProvider, @publishedAt
        )
    `);

    try {
        stmt.run(articleToRow(article));
        logger.debug('db', 'Article inserted', {
            articleId: article.id,
            source: article.source,
            slug: article.slug
        });
        return true;
    } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            logger.debug('db', 'Duplicate article skipped', {
                url: article.originalUrl,
                slug: article.slug
            });
            return false;
        }
        logger.error('db', 'Article insert failed', {
            articleId: article.id,
            error: error.message,
            stack: error.stack
        });
        throw error;
    }
}

/**
 * Update an existing article
 */
function updateArticle(id, data) {
    const db = getDb();

    // Build dynamic update query
    const fields = [];
    const params = {};

    const fieldMap = {
        title: 'title',
        originalUrl: 'original_url',
        source: 'source',
        sourceUrl: 'source_url',
        publishedDate: 'published_date',
        description: 'description',
        content: 'content',
        slug: 'slug',
        status: 'status',
        fetchedAt: 'fetched_at',
        translatedTitle: 'translated_title',
        translatedContent: 'translated_content',
        translatedAt: 'translated_at',
        translationProvider: 'translation_provider',
        publishedAt: 'published_at'
    };

    for (const [jsField, dbField] of Object.entries(fieldMap)) {
        if (data.hasOwnProperty(jsField)) {
            fields.push(`${dbField} = @${jsField}`);
            params[jsField] = data[jsField];
        }
    }

    if (fields.length === 0) {
        logger.warn('db', 'Update called with no fields', { articleId: id });
        return null;
    }

    params.id = id;
    const query = `UPDATE articles SET ${fields.join(', ')} WHERE id = @id`;

    try {
        const result = db.prepare(query).run(params);

        if (result.changes > 0) {
            logger.debug('db', 'Article updated', {
                articleId: id,
                fields: Object.keys(data)
            });
            return getArticleById(id);
        }
        logger.warn('db', 'Article not found for update', { articleId: id });
        return null;
    } catch (error) {
        logger.error('db', 'Article update failed', {
            articleId: id,
            fields: Object.keys(data),
            error: error.message,
            stack: error.stack
        });
        throw error;
    }
}

/**
 * Delete an article by ID
 */
function deleteArticle(id) {
    const db = getDb();
    try {
        const result = db.prepare('DELETE FROM articles WHERE id = ?').run(id);
        if (result.changes > 0) {
            logger.info('db', 'Article deleted', { articleId: id });
            return true;
        }
        logger.warn('db', 'Article not found for deletion', { articleId: id });
        return false;
    } catch (error) {
        logger.error('db', 'Article deletion failed', {
            articleId: id,
            error: error.message,
            stack: error.stack
        });
        throw error;
    }
}

/**
 * Get published articles (status = 'published' only)
 * Ordered by published_at (or translated_at as fallback) DESC so latest appears first
 */
function getPublishedArticles() {
    const db = getDb();
    const rows = db.prepare(`
        SELECT * FROM articles
        WHERE status = 'published'
        ORDER BY COALESCE(published_at, translated_at) DESC, published_date DESC
    `).all();
    return rows.map(rowToArticle);
}

/**
 * Get metadata value by key
 */
function getMetadata(key) {
    const db = getDb();
    const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get(key);
    return row ? row.value : null;
}

/**
 * Set metadata value
 */
function setMetadata(key, value) {
    const db = getDb();
    db.prepare(`
        INSERT INTO metadata (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
}

/**
 * Get article count by status
 */
function getArticleCount(status = null) {
    const db = getDb();
    if (status) {
        return db.prepare('SELECT COUNT(*) as count FROM articles WHERE status = ?').get(status).count;
    }
    return db.prepare('SELECT COUNT(*) as count FROM articles').get().count;
}

/**
 * Get distinct sources
 */
function getSources() {
    const db = getDb();
    const rows = db.prepare('SELECT DISTINCT source FROM articles ORDER BY source').all();
    return rows.map(r => r.source);
}

/**
 * Get API key for a provider
 * @param {string} provider - Provider name (claude-api, openai, claude-cli)
 * @returns {string|null} - API key or null if not found/disabled
 */
function getApiKey(provider) {
    const db = getDb();
    const row = db.prepare('SELECT api_key FROM api_keys WHERE provider = ? AND enabled = 1').get(provider);
    return row ? row.api_key : null;
}

/**
 * Set API key for a provider
 * @param {string} provider - Provider name
 * @param {string} apiKey - API key value
 * @param {boolean} enabled - Whether the provider is enabled
 */
function setApiKey(provider, apiKey, enabled = true) {
    const db = getDb();
    const now = new Date().toISOString();

    db.prepare(`
        INSERT INTO api_keys (provider, api_key, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(provider) DO UPDATE SET
            api_key = excluded.api_key,
            enabled = excluded.enabled,
            updated_at = excluded.updated_at
    `).run(provider, apiKey, enabled ? 1 : 0, now, now);

    logger.info('db', 'API key updated', { provider, enabled });
}

/**
 * Delete API key for a provider
 * @param {string} provider - Provider name
 */
function deleteApiKey(provider) {
    const db = getDb();
    const result = db.prepare('DELETE FROM api_keys WHERE provider = ?').run(provider);
    if (result.changes > 0) {
        logger.info('db', 'API key deleted', { provider });
        return true;
    }
    return false;
}

/**
 * Get all API keys (with masked values for security)
 * @param {boolean} includeFull - Whether to include full API key (for internal use)
 * @returns {Array} - Array of provider configs
 */
function getAllApiKeys(includeFull = false) {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM api_keys ORDER BY provider').all();

    return rows.map(row => ({
        provider: row.provider,
        apiKey: includeFull ? row.api_key : maskApiKey(row.api_key),
        enabled: row.enabled === 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    }));
}

/**
 * Toggle API key enabled status
 * @param {string} provider - Provider name
 * @param {boolean} enabled - New enabled status
 */
function toggleApiKey(provider, enabled) {
    const db = getDb();
    const now = new Date().toISOString();

    const result = db.prepare(`
        UPDATE api_keys SET enabled = ?, updated_at = ? WHERE provider = ?
    `).run(enabled ? 1 : 0, now, provider);

    if (result.changes > 0) {
        logger.info('db', 'API key toggled', { provider, enabled });
        return true;
    }
    return false;
}

/**
 * Mask API key for display (show first 4 and last 4 chars)
 */
function maskApiKey(key) {
    if (!key || key.length < 12) return '****';
    return key.substring(0, 4) + '****' + key.substring(key.length - 4);
}

/**
 * Convert database row to article object (camelCase)
 */
function rowToArticle(row) {
    return {
        id: row.id,
        title: row.translated_title || row.title,
        originalTitle: row.title,
        originalUrl: row.original_url,
        source: row.source,
        sourceUrl: row.source_url,
        publishedDate: row.published_date,
        description: row.description,
        content: row.translated_content || row.content,
        originalContent: row.content,
        slug: row.slug,
        status: row.status,
        fetchedAt: row.fetched_at,
        translatedTitle: row.translated_title,
        translatedContent: row.translated_content,
        translatedAt: row.translated_at,
        translationProvider: row.translation_provider,
        publishedAt: row.published_at
    };
}

/**
 * Convert article object to database row parameters
 */
function articleToRow(article) {
    return {
        id: article.id,
        title: article.originalTitle || article.title,
        originalUrl: article.originalUrl,
        source: article.source,
        sourceUrl: article.sourceUrl,
        publishedDate: article.publishedDate,
        description: article.description,
        content: article.originalContent || article.content,
        slug: article.slug,
        status: article.status || 'pending',
        fetchedAt: article.fetchedAt,
        translatedTitle: article.translatedTitle || null,
        translatedContent: article.translatedContent || null,
        translatedAt: article.translatedAt || null,
        translationProvider: article.translationProvider || null,
        publishedAt: article.publishedAt || null
    };
}

// Export functions
module.exports = {
    initDb,
    getDb,
    closeDb,
    getAllArticles,
    getArticleById,
    getArticleBySlug,
    getArticleByUrl,
    insertArticle,
    updateArticle,
    deleteArticle,
    getPublishedArticles,
    getMetadata,
    setMetadata,
    getArticleCount,
    getSources,
    // API key management
    getApiKey,
    setApiKey,
    deleteApiKey,
    getAllApiKeys,
    toggleApiKey,
    DB_PATH
};
