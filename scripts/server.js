/**
 * Local Admin Server for NoMeta.az Blog
 * Runs only on localhost for article management
 */

const express = require('express');
const path = require('path');
const { execFileSync } = require('child_process');

// Import database module
const db = require('./db');
const logger = require('./logger');

// Import our modules
const { fetchAllFeeds, loadExistingArticles, updateArticleStatus, getArticleById, getRSSFeeds, CONFIG, FILTER_KEYWORDS } = require('./fetch-rss');
const { translateArticle, getTranslatedArticles, getTranslatedArticle, checkProviders } = require('./translate');
const { generateBlog } = require('./generate-blog');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, '..', 'admin')));

// CORS for local development
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

/**
 * API Routes
 */

// Get all articles
app.get('/api/articles', (req, res) => {
    try {
        const data = loadExistingArticles();
        const feeds = getRSSFeeds();
        res.json({
            articles: data.articles || [],
            sources: feeds.map(f => f.name),
            lastFetched: data.lastFetched,
            totalCount: data.totalCount || 0
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Fetch new articles from RSS feeds
app.post('/api/fetch', async (req, res) => {
    try {
        const beforeCount = db.getArticleCount();
        await fetchAllFeeds();
        const afterCount = db.getArticleCount();

        res.json({
            success: true,
            newArticles: afterCount - beforeCount,
            totalArticles: afterCount
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get translated articles
app.get('/api/translated', (req, res) => {
    try {
        const articles = getTranslatedArticles();
        res.json(articles);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get available translation providers
app.get('/api/providers', (req, res) => {
    try {
        const available = checkProviders();
        const providers = [
            { id: 'claude-api', name: 'Claude API', available: available.includes('claude-api') },
            { id: 'openai', name: 'OpenAI', available: available.includes('openai') },
            { id: 'claude-cli', name: 'Claude Code CLI', available: available.includes('claude-cli') }
        ];
        res.json(providers);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Translate an article
app.post('/api/translate', async (req, res) => {
    try {
        const { articleId, provider } = req.body;

        if (!articleId) {
            return res.status(400).json({ success: false, error: 'Article ID required' });
        }

        // Get the article
        const article = getArticleById(articleId);
        if (!article) {
            return res.status(404).json({ success: false, error: 'Article not found' });
        }

        // Translate (this now saves directly to database)
        const translatedArticle = await translateArticle(article, provider || 'claude-api');

        res.json({
            success: true,
            article: translatedArticle,
            translatedContent: translatedArticle.content
        });
    } catch (error) {
        logger.error('server', 'Translation request failed', {
            articleId: req.body.articleId,
            provider: req.body.provider,
            error: error.message,
            stack: error.stack
        });
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Push changes to GitHub (triggers GitHub Pages deployment)
 */
function pushToGitHub(articleTitle) {
    const rootDir = path.join(__dirname, '..');
    const commitMessage = articleTitle
        ? `Publish: ${articleTitle}`
        : 'Update blog content';

    try {
        // Add news directory and sitemap
        execFileSync('git', ['add', 'news/', 'sitemap.xml'], { cwd: rootDir, encoding: 'utf-8' });

        // Check if there are changes to commit
        const status = execFileSync('git', ['status', '--porcelain', 'news/', 'sitemap.xml'], { cwd: rootDir, encoding: 'utf-8' });
        if (!status.trim()) {
            logger.info('server', 'No changes to push');
            return { pushed: false, message: 'No changes to push' };
        }

        // Get current branch and commit and push (using execFileSync to prevent shell injection)
        const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: rootDir, encoding: 'utf-8' }).trim();
        execFileSync('git', ['commit', '-m', commitMessage], { cwd: rootDir, encoding: 'utf-8' });
        execFileSync('git', ['push', 'origin', branch], { cwd: rootDir, encoding: 'utf-8' });

        logger.info('server', 'Pushed to GitHub', { branch, commitMessage });
        return { pushed: true, message: `Pushed to ${branch}` };
    } catch (error) {
        logger.error('server', 'Git push failed', {
            error: error.message,
            stack: error.stack,
            cwd: rootDir
        });
        throw new Error(`Git push failed: ${error.message}`);
    }
}

// Publish an article (mark as published, generate blog, and push to GitHub)
app.post('/api/publish', (req, res) => {
    try {
        const { articleId, slug, autoPush = true } = req.body;

        if (!articleId && !slug) {
            return res.status(400).json({ success: false, error: 'Article ID or slug required' });
        }

        // Get article by ID or slug
        let article;
        if (articleId) {
            article = db.getArticleById(articleId);
        } else {
            article = db.getArticleBySlug(slug);
        }

        if (!article) {
            return res.status(404).json({ success: false, error: 'Article not found' });
        }

        // Update status to published
        const updatedArticle = db.updateArticle(article.id, {
            status: 'published',
            publishedAt: new Date().toISOString()
        });

        // Auto-generate blog to create the HTML page
        const result = generateBlog();

        // Push to GitHub if autoPush is enabled
        let pushResult = { pushed: false, message: 'Auto-push disabled' };
        if (autoPush) {
            try {
                pushResult = pushToGitHub(updatedArticle.title);
            } catch (pushError) {
                logger.error('server', 'Git push failed during publish', {
                    articleId: article.id,
                    error: pushError.message
                });
                pushResult = { pushed: false, message: pushError.message };
            }
        }

        res.json({
            success: true,
            article: updatedArticle,
            generated: result.articlesGenerated,
            pushed: pushResult.pushed,
            pushMessage: pushResult.message
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Generate blog HTML
app.post('/api/generate', (req, res) => {
    try {
        const result = generateBlog();
        res.json({
            success: true,
            articlesGenerated: result.articlesGenerated,
            outputDir: result.outputDir
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Push to GitHub manually
app.post('/api/push', (req, res) => {
    try {
        const pushResult = pushToGitHub();
        res.json({
            success: true,
            pushed: pushResult.pushed,
            message: pushResult.message
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get single article by ID
app.get('/api/articles/:id', (req, res) => {
    try {
        const article = getArticleById(req.params.id);
        if (article) {
            res.json(article);
        } else {
            res.status(404).json({ error: 'Article not found' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get fetch config
app.get('/api/config', (req, res) => {
    const feeds = getRSSFeeds();
    res.json({
        articlesPerFeed: CONFIG.articlesPerFeed,
        minContentLength: CONFIG.minContentLength,
        sources: feeds.map(f => ({ name: f.name, url: f.sourceUrl })),
        filterKeywords: FILTER_KEYWORDS
    });
});

// Get RSS feed sources (enabled only)
app.get('/api/sources', (req, res) => {
    const feeds = getRSSFeeds();
    res.json(feeds);
});

// Get database statistics
app.get('/api/stats', (req, res) => {
    try {
        const stats = {
            total: db.getArticleCount(),
            pending: db.getArticleCount('pending'),
            saved: db.getArticleCount('saved'),
            translated: db.getArticleCount('translated'),
            published: db.getArticleCount('published'),
            disabled: db.getArticleCount('disabled'),
            sources: db.getSources(),
            lastFetched: db.getMetadata('last_fetched')
        };
        res.json(stats);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * RSS Feed Management Endpoints
 */

// Get all RSS feeds (including disabled)
app.get('/api/feeds', (req, res) => {
    try {
        const feeds = db.getAllFeeds(false); // false = include disabled
        res.json(feeds);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Add a new RSS feed
app.post('/api/feeds', (req, res) => {
    try {
        const { name, url, sourceUrl } = req.body;

        if (!name || !url || !sourceUrl) {
            return res.status(400).json({
                success: false,
                error: 'Name, URL, and source URL are required'
            });
        }

        // Validate URL format
        try {
            new URL(url);
            new URL(sourceUrl);
        } catch {
            return res.status(400).json({
                success: false,
                error: 'Invalid URL format'
            });
        }

        const feed = db.insertFeed({ name, url, sourceUrl });
        res.json({ success: true, feed });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Update an RSS feed
app.put('/api/feeds/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { name, url, sourceUrl, enabled } = req.body;

        if (isNaN(id)) {
            return res.status(400).json({ success: false, error: 'Invalid feed ID' });
        }

        // Validate URLs if provided
        if (url) {
            try {
                new URL(url);
            } catch {
                return res.status(400).json({ success: false, error: 'Invalid feed URL format' });
            }
        }
        if (sourceUrl) {
            try {
                new URL(sourceUrl);
            } catch {
                return res.status(400).json({ success: false, error: 'Invalid source URL format' });
            }
        }

        const feed = db.updateFeed(id, { name, url, sourceUrl, enabled });

        if (feed) {
            res.json({ success: true, feed });
        } else {
            res.status(404).json({ success: false, error: 'Feed not found' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Delete an RSS feed
app.delete('/api/feeds/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id);

        if (isNaN(id)) {
            return res.status(400).json({ success: false, error: 'Invalid feed ID' });
        }

        const deleted = db.deleteFeed(id);

        if (deleted) {
            res.json({ success: true, message: 'Feed deleted' });
        } else {
            res.status(404).json({ success: false, error: 'Feed not found' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Toggle feed enabled status
app.put('/api/feeds/:id/toggle', (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { enabled } = req.body;

        if (isNaN(id)) {
            return res.status(400).json({ success: false, error: 'Invalid feed ID' });
        }

        if (typeof enabled !== 'boolean') {
            return res.status(400).json({ success: false, error: 'Enabled status required (boolean)' });
        }

        const feed = db.toggleFeed(id, enabled);

        if (feed) {
            res.json({
                success: true,
                feed,
                message: `Feed ${enabled ? 'enabled' : 'disabled'}`
            });
        } else {
            res.status(404).json({ success: false, error: 'Feed not found' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * API Key Management Endpoints
 */

// Get all API keys (masked for security)
app.get('/api/settings/api-keys', (req, res) => {
    try {
        const keys = db.getAllApiKeys(false); // false = masked
        res.json(keys);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Add or update an API key
app.post('/api/settings/api-keys', (req, res) => {
    try {
        const { provider, apiKey, enabled = true } = req.body;

        if (!provider || !apiKey) {
            return res.status(400).json({ success: false, error: 'Provider and API key required' });
        }

        // Validate provider name
        const validProviders = ['claude-api', 'openai'];
        if (!validProviders.includes(provider)) {
            return res.status(400).json({ success: false, error: `Invalid provider. Must be one of: ${validProviders.join(', ')}` });
        }

        db.setApiKey(provider, apiKey, enabled);

        res.json({
            success: true,
            message: `API key for ${provider} saved`
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Toggle API key enabled status
app.put('/api/settings/api-keys/:provider/toggle', (req, res) => {
    try {
        const { provider } = req.params;
        const { enabled } = req.body;

        if (typeof enabled !== 'boolean') {
            return res.status(400).json({ success: false, error: 'Enabled status required (boolean)' });
        }

        const updated = db.toggleApiKey(provider, enabled);

        if (updated) {
            res.json({
                success: true,
                message: `${provider} ${enabled ? 'enabled' : 'disabled'}`
            });
        } else {
            res.status(404).json({ success: false, error: 'API key not found' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Delete an API key
app.delete('/api/settings/api-keys/:provider', (req, res) => {
    try {
        const { provider } = req.params;
        const deleted = db.deleteApiKey(provider);

        if (deleted) {
            res.json({
                success: true,
                message: `API key for ${provider} deleted`
            });
        } else {
            res.status(404).json({ success: false, error: 'API key not found' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Delete an article
app.delete('/api/articles/:id', (req, res) => {
    try {
        const articleId = req.params.id;
        const article = db.getArticleById(articleId);

        if (!article) {
            return res.status(404).json({ success: false, error: 'Article not found' });
        }

        const deleted = db.deleteArticle(articleId);

        if (deleted) {
            res.json({ success: true, message: 'Article deleted' });
        } else {
            res.status(500).json({ success: false, error: 'Failed to delete article' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Disable/Enable an article (toggle status to 'disabled' or back to 'pending')
app.post('/api/articles/:id/toggle-disable', (req, res) => {
    try {
        const articleId = req.params.id;
        const article = db.getArticleById(articleId);

        if (!article) {
            return res.status(404).json({ success: false, error: 'Article not found' });
        }

        // Toggle between disabled and pending
        const newStatus = article.status === 'disabled' ? 'pending' : 'disabled';
        const updatedArticle = db.updateArticle(articleId, { status: newStatus });

        res.json({
            success: true,
            article: updatedArticle,
            message: newStatus === 'disabled' ? 'Article disabled' : 'Article enabled'
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Save/Unsave an article (toggle status to 'saved' or back to 'pending')
app.post('/api/articles/:id/toggle-save', (req, res) => {
    try {
        const articleId = req.params.id;
        const article = db.getArticleById(articleId);

        if (!article) {
            return res.status(404).json({ success: false, error: 'Article not found' });
        }

        // Toggle between saved and pending
        const newStatus = article.status === 'saved' ? 'pending' : 'saved';
        const updatedArticle = db.updateArticle(articleId, { status: newStatus });

        res.json({
            success: true,
            article: updatedArticle,
            message: newStatus === 'saved' ? 'Article saved' : 'Article unsaved'
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Bulk delete articles
app.post('/api/articles/bulk-delete', (req, res) => {
    try {
        const { ids } = req.body;

        if (!ids || !Array.isArray(ids) || ids.length === 0 || ids.length > 500) {
            return res.status(400).json({ success: false, error: 'Provide 1-500 article IDs' });
        }
        if (!ids.every(id => typeof id === 'string')) {
            return res.status(400).json({ success: false, error: 'All IDs must be strings' });
        }

        let deleted = 0;
        for (const id of ids) {
            if (db.deleteArticle(id)) {
                deleted++;
            }
        }

        res.json({ success: true, deleted, message: `Deleted ${deleted} articles` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Bulk disable articles
app.post('/api/articles/bulk-disable', (req, res) => {
    try {
        const { ids } = req.body;

        if (!ids || !Array.isArray(ids) || ids.length === 0 || ids.length > 500) {
            return res.status(400).json({ success: false, error: 'Provide 1-500 article IDs' });
        }
        if (!ids.every(id => typeof id === 'string')) {
            return res.status(400).json({ success: false, error: 'All IDs must be strings' });
        }

        let disabled = 0;
        for (const id of ids) {
            const article = db.getArticleById(id);
            if (article && article.status !== 'disabled') {
                db.updateArticle(id, { status: 'disabled' });
                disabled++;
            }
        }

        res.json({ success: true, disabled, message: `Disabled ${disabled} articles` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Serve admin panel
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'admin', 'index.html'));
});

// Graceful shutdown handler
function shutdown(signal) {
    logger.info('server', 'Shutdown signal received', { signal });

    // Close database connection
    db.closeDb();
    logger.info('server', 'Database connection closed');

    process.exit(0);
}

// Register shutdown handlers
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Initialize database before starting server
db.initDb();

// Start server
app.listen(PORT, () => {
    // Display database statistics
    const stats = {
        total: db.getArticleCount(),
        pending: db.getArticleCount('pending'),
        saved: db.getArticleCount('saved'),
        translated: db.getArticleCount('translated'),
        published: db.getArticleCount('published')
    };

    // Check available providers
    const available = checkProviders();

    // Log startup info
    logger.info('server', 'Server started', {
        port: PORT,
        dbPath: db.DB_PATH,
        providers: available,
        stats
    });

    // Human-readable output for local dev
    if (!process.env.CI && process.env.LOG_FORMAT !== 'json') {
        console.log(`
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║   NoMeta.az Admin Panel                                    ║
║                                                            ║
║   Server running at: http://localhost:${PORT}                 ║
║                                                            ║
║   Open the URL above in your browser to manage articles.   ║
║                                                            ║
║   Press Ctrl+C to stop the server.                         ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
`);
        console.log('Database statistics:');
        console.log(`  Total: ${stats.total} | Pending: ${stats.pending} | Saved: ${stats.saved} | Translated: ${stats.translated} | Published: ${stats.published}`);
        console.log('\nAvailable translation providers:', available.length > 0 ? available.join(', ') : 'None');

        if (available.length === 0) {
            console.log('\nTo enable translation:');
            console.log('  - Go to Settings tab and add API keys, or');
            console.log('  - Set ANTHROPIC_API_KEY / OPENAI_API_KEY env vars, or');
            console.log('  - Install claude CLI for Claude Code');
        }
        console.log('');
    }
});

module.exports = app;
