/**
 * RSS Feed Fetcher for NoMeta.az Blog
 * Fetches articles from engineering blogs and stores them in SQLite database
 */

const Parser = require('rss-parser');
const db = require('./db');

// Configuration
const CONFIG = {
    articlesPerFeed: 20,        // Number of articles to fetch per feed (0 = all)
    minContentLength: 1000      // Minimum content length to accept article
};

// RSS feed sources - ONLY sources that provide FULL article content via RSS
// Removed: Stack Overflow, Cloudflare, Stripe, GitHub, Netflix, Uber, Dropbox,
//          Meta, Google, AWS, Mozilla, LinkedIn (all provide snippets only)
const RSS_FEEDS = [
    {
        name: 'GitLab',
        url: 'https://about.gitlab.com/atom.xml',
        sourceUrl: 'https://about.gitlab.com/blog'
    },
    {
        name: 'Dev.to',
        url: 'https://dev.to/feed',
        sourceUrl: 'https://dev.to'
    },
    {
        name: 'Martin Fowler',
        url: 'https://martinfowler.com/feed.atom',
        sourceUrl: 'https://martinfowler.com'
    },
    {
        name: 'A List Apart',
        url: 'https://alistapart.com/main/feed/',
        sourceUrl: 'https://alistapart.com'
    }
];

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
        console.log(`  Fetching from ${feed.name}...`);
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
                filtered++;
                continue; // Skip this article
            }

            articles.push(article);
        }

        console.log(`    Found ${articles.length} articles (${filtered} filtered out)`);
        return articles;
    } catch (error) {
        console.error(`  Error fetching ${feed.name}:`, error.message);
        return [];
    }
}

/**
 * Main fetch function - fetches all feeds and stores in database
 */
async function fetchAllFeeds() {
    console.log('Starting RSS fetch...\n');

    // Initialize database
    db.initDb();

    const parser = new Parser({
        timeout: 10000,
        headers: {
            'User-Agent': 'NoMeta.az RSS Fetcher/1.0'
        }
    });

    // Fetch from all feeds
    let newCount = 0;
    for (const feed of RSS_FEEDS) {
        const articles = await fetchFeed(feed, parser);

        // Insert new articles (duplicates are automatically skipped by unique URL constraint)
        for (const article of articles) {
            // Check if article already exists by URL
            if (!db.getArticleByUrl(article.originalUrl)) {
                if (db.insertArticle(article)) {
                    newCount++;
                }
            }
        }
    }

    console.log(`\nFound ${newCount} new articles`);

    // Update last fetched timestamp
    db.setMetadata('last_fetched', new Date().toISOString());

    const totalCount = db.getArticleCount();
    console.log(`\nTotal articles in database: ${totalCount}`);

    return {
        newArticles: newCount,
        totalCount: totalCount,
        lastFetched: new Date().toISOString()
    };
}

/**
 * Get articles filtered by status
 */
function getArticlesByStatus(status) {
    return db.getAllArticles({ status });
}

/**
 * Get articles filtered by source
 */
function getArticlesBySource(source) {
    return db.getAllArticles({ source });
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
    return {
        articles,
        lastFetched,
        totalCount: articles.length,
        sources: RSS_FEEDS.map(f => f.name)
    };
}

// Export functions for use in other scripts
module.exports = {
    fetchAllFeeds,
    loadExistingArticles,
    getArticlesByStatus,
    getArticlesBySource,
    updateArticleStatus,
    getArticleById,
    shouldFilterArticle,
    RSS_FEEDS,
    FILTER_KEYWORDS,
    CONFIG
};

// Run if called directly
if (require.main === module) {
    fetchAllFeeds()
        .then(() => console.log('\nDone!'))
        .catch(err => {
            console.error('Fatal error:', err);
            process.exit(1);
        });
}
