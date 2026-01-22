/**
 * Local Admin Server for NoMeta.az Blog
 * Runs only on localhost for article management
 */

const express = require('express');
const path = require('path');
const { execSync } = require('child_process');

// Import database module
const db = require('./db');

// Import our modules
const { fetchAllFeeds, loadExistingArticles, updateArticleStatus, getArticleById, RSS_FEEDS, CONFIG, FILTER_KEYWORDS } = require('./fetch-rss');
const { translateArticle, getTranslatedArticles, getTranslatedArticle, checkProviders } = require('./translate');
const { generateBlog } = require('./generate-blog');

const app = express();
const PORT = 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'admin')));

// CORS for local development
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
        res.json({
            articles: data.articles || [],
            sources: RSS_FEEDS.map(f => f.name),
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
        console.error('Translation error:', error);
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
        execSync('git add news/ sitemap.xml', { cwd: rootDir, encoding: 'utf-8' });

        // Check if there are changes to commit
        const status = execSync('git status --porcelain news/ sitemap.xml', { cwd: rootDir, encoding: 'utf-8' });
        if (!status.trim()) {
            return { pushed: false, message: 'No changes to push' };
        }

        // Get current branch and commit and push
        const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: rootDir, encoding: 'utf-8' }).trim();
        execSync(`git commit -m "${commitMessage}"`, { cwd: rootDir, encoding: 'utf-8' });
        execSync(`git push origin ${branch}`, { cwd: rootDir, encoding: 'utf-8' });

        return { pushed: true, message: `Pushed to ${branch}` };
    } catch (error) {
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
        console.log(`Blog generated: ${result.articlesGenerated} articles`);

        // Push to GitHub if autoPush is enabled
        let pushResult = { pushed: false, message: 'Auto-push disabled' };
        if (autoPush) {
            try {
                pushResult = pushToGitHub(updatedArticle.title);
                console.log(`Git push: ${pushResult.message}`);
            } catch (pushError) {
                console.error('Git push failed:', pushError.message);
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
    res.json({
        articlesPerFeed: CONFIG.articlesPerFeed,
        minContentLength: CONFIG.minContentLength,
        sources: RSS_FEEDS.map(f => ({ name: f.name, url: f.sourceUrl })),
        filterKeywords: FILTER_KEYWORDS
    });
});

// Get RSS feed sources
app.get('/api/sources', (req, res) => {
    res.json(RSS_FEEDS);
});

// Get database statistics
app.get('/api/stats', (req, res) => {
    try {
        const stats = {
            total: db.getArticleCount(),
            pending: db.getArticleCount('pending'),
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

// Bulk delete articles
app.post('/api/articles/bulk-delete', (req, res) => {
    try {
        const { ids } = req.body;

        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ success: false, error: 'Article IDs required' });
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

        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ success: false, error: 'Article IDs required' });
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

// Start server
app.listen(PORT, () => {
    // Initialize database
    db.initDb();
    console.log(`Database initialized at: ${db.DB_PATH}`);

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

    // Display database statistics
    const stats = {
        total: db.getArticleCount(),
        pending: db.getArticleCount('pending'),
        translated: db.getArticleCount('translated'),
        published: db.getArticleCount('published')
    };
    console.log('Database statistics:');
    console.log(`  Total: ${stats.total} | Pending: ${stats.pending} | Translated: ${stats.translated} | Published: ${stats.published}`);

    // Check available providers
    const available = checkProviders();
    console.log('\nAvailable translation providers:', available.length > 0 ? available.join(', ') : 'None');

    if (available.length === 0) {
        console.log('\nTo enable translation:');
        console.log('  - Set ANTHROPIC_API_KEY for Claude API');
        console.log('  - Set OPENAI_API_KEY for OpenAI');
        console.log('  - Install claude CLI for Claude Code');
    }
    console.log('');
});

module.exports = app;
