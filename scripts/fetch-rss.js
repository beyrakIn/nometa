/**
 * RSS Feed Fetcher for NoMeta.az Blog
 * Fetches articles from engineering blogs and stores them in SQLite database
 */

const Parser = require('rss-parser');
const db = require('./db');
const logger = require('./logger');

// Configuration
const CONFIG = {
    articlesPerFeed: 20,        // Number of articles to fetch per feed (0 = all)
    minContentLength: 1000      // Minimum content length to accept article
};

/**
 * Get RSS feeds from database (enabled only)
 * @returns {Array} Array of feed objects with name, url, sourceUrl
 */
function getRSSFeeds() {
    db.initDb(); // Ensure DB is initialized
    return db.getAllFeeds(true); // true = enabled only
}

// Keywords that indicate platform-specific/promotional content to FILTER OUT
const FILTER_KEYWORDS = [
    // Product announcements & releases
    'release notes', 'changelog', 'new feature', 'now available', 'announcing',
    'introducing', 'launch', 'beta', 'preview', 'ga release', 'generally available',
    // Platform specific
    'gitlab ci', 'gitlab runner', 'gitlab premium', 'gitlab ultimate',
    'pricing', 'subscription', 'upgrade', 'migration guide',
    // Corporate/promotional
    'webinar', 'conference', 'event', 'meetup', 'workshop',
    'case study', 'customer story', 'partnership', 'acquisition',
    'careers', 'hiring', 'job', 'join our team',
    // Meta content
    'year in review', 'annual report', 'survey results',
];

/**
 * Check if article should be filtered out
 */
function shouldFilterArticle(article) {
    const titleLower = (article.title || '').toLowerCase();
    const contentLower = (article.content || '').toLowerCase().substring(0, 500);
    const combined = titleLower + ' ' + contentLower;

    // Check against filter keywords
    for (const keyword of FILTER_KEYWORDS) {
        if (combined.includes(keyword.toLowerCase())) {
            return { filtered: true, reason: `Contains "${keyword}"` };
        }
    }

    // Filter if content is too short (likely not a real article)
    if ((article.content || '').length < 1000) {
        return { filtered: true, reason: 'Content too short (<1000 chars)' };
    }

    return { filtered: false };
}

/**
 * Generate a URL-friendly slug from title
 */
function generateSlug(title) {
    return title
        .toLowerCase()
        .replace(/[^\w\s-]/g, '') // Remove special characters
        .replace(/\s+/g, '-')     // Replace spaces with hyphens
        .replace(/-+/g, '-')      // Replace multiple hyphens with single
        .substring(0, 80)         // Limit length
        .replace(/-$/, '');       // Remove trailing hyphen
}

/**
 * Extract plain text description from HTML content
 */
function extractDescription(content, maxLength = 200) {
    if (!content) return '';

    // Remove HTML tags
    const text = content
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (text.length <= maxLength) return text;

    // Truncate at word boundary
    return text.substring(0, maxLength).replace(/\s+\S*$/, '') + '...';
}

/**
 * Fetch articles from a single RSS feed
 */
async function fetchFeed(feed, parser) {
    try {
        logger.debug('fetch', 'Fetching feed', { source: feed.name, url: feed.url });
        const parsed = await parser.parseURL(feed.url);

        // Apply article limit (0 = no limit)
        const items = CONFIG.articlesPerFeed > 0
            ? parsed.items.slice(0, CONFIG.articlesPerFeed)
            : parsed.items;

        const articles = [];
        let filtered = 0;

        for (const item of items) {
            // Get full content from RSS (content:encoded is common for full content)
            const content = item['content:encoded'] || item.content || item.contentSnippet || item.summary || '';

            const article = {
                id: `${feed.name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                title: item.title || 'Untitled',
                originalUrl: item.link || '',
                source: feed.name,
                sourceUrl: feed.sourceUrl,
                publishedDate: item.pubDate || item.isoDate || new Date().toISOString(),
                description: extractDescription(item.contentSnippet || content || ''),
                content: content,
                slug: generateSlug(item.title || 'untitled'),
                status: 'pending',
                fetchedAt: new Date().toISOString(),
                translatedAt: null,
                publishedAt: null,
                translationProvider: null
            };

            // Apply filtering
            const filterResult = shouldFilterArticle(article);
            if (filterResult.filtered) {
                logger.debug('fetch', 'Article filtered', {
                    title: article.title,
                    reason: filterResult.reason
                });
                filtered++;
                continue; // Skip this article
            }

            articles.push(article);
        }

        logger.info('fetch', 'Feed fetched', {
            source: feed.name,
            found: articles.length,
            filtered
        });
        return { articles, error: null };
    } catch (error) {
        logger.error('fetch', 'Feed fetch failed', {
            source: feed.name,
            url: feed.url,
            error: error.message,
            stack: error.stack
        });
        return { articles: [], error: error.message };
    }
}

/**
 * Main fetch function - fetches all feeds and stores in database
 */
async function fetchAllFeeds() {
    const endTimer = logger.timer('fetch', 'RSS fetch');

    // Initialize database
    db.initDb();

    // Get enabled feeds from database
    const feeds = getRSSFeeds();

    logger.info('fetch', 'Starting RSS fetch', { feedCount: feeds.length });

    if (feeds.length === 0) {
        logger.warn('fetch', 'No enabled RSS feeds configured');
        return {
            newArticles: 0,
            totalCount: db.getArticleCount(),
            lastFetched: new Date().toISOString(),
            feedErrors: null
        };
    }

    const parser = new Parser({
        timeout: 10000,
        headers: {
            'User-Agent': 'NoMeta.az RSS Fetcher/1.0'
        }
    });

    // Fetch from all feeds in parallel
    let newCount = 0;
    let feedErrors = [];
    const results = await Promise.allSettled(
        feeds.map(feed => fetchFeed(feed, parser))
    );

    for (let i = 0; i < results.length; i++) {
        const settlement = results[i];

        if (settlement.status === 'rejected') {
            feedErrors.push({ source: feeds[i].name, error: settlement.reason.message });
            continue;
        }

        const result = settlement.value;

        // Track feed errors
        if (result.error) {
            feedErrors.push({ source: feeds[i].name, error: result.error });
        }

        // Insert new articles (duplicates are automatically skipped by unique URL constraint)
        for (const article of result.articles) {
            // Check if article already exists by URL
            if (!db.getArticleByUrl(article.originalUrl)) {
                if (db.insertArticle(article)) {
                    newCount++;
                }
            }
        }
    }

    // Update last fetched timestamp
    db.setMetadata('last_fetched', new Date().toISOString());

    const totalCount = db.getArticleCount();

    endTimer({
        newArticles: newCount,
        totalArticles: totalCount,
        feedErrors: feedErrors.length
    });

    return {
        newArticles: newCount,
        totalCount: totalCount,
        lastFetched: new Date().toISOString(),
        feedErrors: feedErrors.length > 0 ? feedErrors : null
    };
}

/**
 * Update article status
 */
function updateArticleStatus(articleId, status, additionalData = {}) {
    const data = { status, ...additionalData };
    return db.updateArticle(articleId, data);
}

/**
 * Get a single article by ID
 */
function getArticleById(articleId) {
    return db.getArticleById(articleId);
}

/**
 * Load all articles (for backward compatibility with server.js)
 */
function loadExistingArticles() {
    db.initDb();
    const articles = db.getAllArticles();
    const lastFetched = db.getMetadata('last_fetched');
    const feeds = getRSSFeeds();
    return {
        articles,
        lastFetched,
        totalCount: articles.length,
        sources: feeds.map(f => f.name)
    };
}

// Export functions for use in other scripts
module.exports = {
    fetchAllFeeds,
    loadExistingArticles,
    updateArticleStatus,
    getArticleById,
    shouldFilterArticle,
    getRSSFeeds,
    FILTER_KEYWORDS,
    CONFIG
};

// Run if called directly
if (require.main === module) {
    fetchAllFeeds()
        .then((result) => {
            logger.info('fetch', 'Fetch complete', result);
        })
        .catch(err => {
            logger.error('fetch', 'Fatal error', {
                error: err.message,
                stack: err.stack
            });
            process.exit(1);
        });
}
