/**
 * Static Blog Generator for NoMeta.az
 * Generates HTML pages from translated articles in SQLite database
 */

const fs = require('fs');
const path = require('path');
const { marked } = require('marked');
const db = require('./db');
const logger = require('./logger');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const NEWS_DIR = path.join(__dirname, '..', 'news');
const SITEMAP_FILE = path.join(__dirname, '..', 'sitemap.xml');
const HOMEPAGE_FILE = path.join(__dirname, '..', 'index.html');

// Current CSS version for cache busting (format: YYYYMMDDNN)
const CSS_VERSION = '2026012601';

// Custom renderer for lazy loading images
const renderer = new marked.Renderer();
renderer.image = function({ href, title, text }) {
    const titleAttr = title ? ` title="${title}"` : '';
    return `<img src="${href}" alt="${text}"${titleAttr} loading="lazy" decoding="async">`;
};

// Configure marked once at module load
marked.setOptions({
    gfm: true,
    breaks: false,
    headerIds: true,
    mangle: false,
    renderer
});

// Template cache
const templateCache = new Map();

/**
 * Load template file with error handling
 */
function loadTemplate(name) {
    if (templateCache.has(name)) {
        return templateCache.get(name);
    }
    const filepath = path.join(TEMPLATES_DIR, name);
    try {
        const content = fs.readFileSync(filepath, 'utf-8');
        templateCache.set(name, content);
        return content;
    } catch (error) {
        const message = `Failed to load template "${name}": ${error.message}`;
        logger.error('generate', message, { filepath, error: error.code });
        throw new Error(message);
    }
}

/**
 * Safe file write with error handling
 */
function safeWriteFile(filepath, content) {
    try {
        fs.writeFileSync(filepath, content, 'utf-8');
        return true;
    } catch (error) {
        const message = `Failed to write file "${filepath}": ${error.message}`;
        logger.error('generate', message, { filepath, error: error.code });
        throw new Error(message);
    }
}

/**
 * Format date in Azerbaijani
 */
function formatDate(dateString) {
    const date = new Date(dateString);
    const months = [
        'Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'İyun',
        'İyul', 'Avqust', 'Sentyabr', 'Oktyabr', 'Noyabr', 'Dekabr'
    ];

    return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
}

/**
 * Format date for ISO
 */
function formatDateISO(dateString) {
    return new Date(dateString).toISOString().split('T')[0];
}

/**
 * Simple template engine - replaces {{variable}} with values
 */
function renderTemplate(template, data) {
    let result = template;

    // Replace simple variables
    for (const [key, value] of Object.entries(data)) {
        const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
        result = result.replace(regex, value || '');
    }

    return result;
}

/**
 * Convert markdown to HTML with custom options
 */
function markdownToHtml(markdown) {
    return marked.parse(markdown);
}

/**
 * Get all published articles from database
 */
function getPublishedArticles() {
    db.initDb();
    return db.getPublishedArticles();
}

/**
 * Calculate reading time from text
 */
function calculateReadingTime(text) {
    // Average reading speed: 200 words per minute
    const plainText = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const wordCount = plainText.split(/\s+/).length;
    const readingTime = Math.ceil(wordCount / 200);
    return { wordCount, readingTime: Math.max(1, readingTime) };
}

/**
 * Extract plain text from HTML/markdown
 * Removes HTML tags, markdown symbols, and translation artifacts
 */
function extractPlainText(content, maxLength = 500) {
    let text = content
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/[#*_`\[\]]/g, '')
        .trim();

    // Remove common translation artifacts at the start (e.g., "Başlıq: Title Here")
    // These can appear when AI translation adds title prefixes
    text = text.replace(/^(Başlıq|Title|Sərlövhə|Məzmun|Content)\s*:\s*/i, '');

    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength).replace(/\s+\S*$/, '') + '...';
}

/**
 * Escape text for use in JSON-LD structured data
 * Handles quotes, backslashes, and special characters
 */
function escapeForJson(text) {
    if (!text) return '';
    return text
        // Replace curly/smart quotes with regular quotes FIRST (before escaping)
        // U+201C (") and U+201D (") -> regular quote
        .replace(/[\u201C\u201D]/g, '"')
        // Escape backslashes
        .replace(/\\/g, '\\\\')
        // Escape double quotes for JSON
        .replace(/"/g, '\\"')
        // Replace newlines and tabs
        .replace(/\n/g, ' ')
        .replace(/\r/g, '')
        .replace(/\t/g, ' ')
        // Collapse multiple spaces
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Generate keywords from content
 */
function extractKeywords(title, source, content) {
    // Extract common tech keywords from content
    const techKeywords = ['API', 'JavaScript', 'Python', 'React', 'Node.js', 'Docker',
        'Kubernetes', 'AWS', 'Cloud', 'DevOps', 'CI/CD', 'Machine Learning', 'AI',
        'Database', 'SQL', 'NoSQL', 'Security', 'Performance', 'Microservices'];

    const contentLower = (title + ' ' + content).toLowerCase();
    const foundKeywords = techKeywords.filter(kw =>
        contentLower.includes(kw.toLowerCase())
    );

    return [...new Set([source, ...foundKeywords.slice(0, 5)])].join(', ');
}

/**
 * Truncate title for breadcrumb
 */
function truncateTitle(title, maxLength = 50) {
    if (title.length <= maxLength) return title;
    return title.substring(0, maxLength).replace(/\s+\S*$/, '') + '...';
}

/**
 * Remove duplicate title from content (first h1 that matches article title)
 */
function removeDuplicateTitle(html) {
    // Remove first h1 tag from content (it duplicates the page title)
    return html.replace(/^\s*<h1[^>]*>.*?<\/h1>\s*/i, '');
}

/**
 * Generate article page
 */
function generateArticlePage(article, template) {
    logger.debug('generate', 'Generating article page', { slug: article.slug });

    // Create article directory
    const articleDir = path.join(NEWS_DIR, article.slug);
    if (!fs.existsSync(articleDir)) {
        fs.mkdirSync(articleDir, { recursive: true });
    }

    // Convert content to HTML if it's markdown, then remove duplicate title
    const contentHtml = removeDuplicateTitle(markdownToHtml(article.content));

    // Calculate reading metrics
    const { wordCount, readingTime } = calculateReadingTime(article.content);

    // Extract plain text for schema
    const articleBodyText = extractPlainText(article.content, 1000);

    // Generate keywords
    const keywords = extractKeywords(article.title, article.source, article.content);

    // Get copyright year from published date
    const copyrightYear = new Date(article.publishedDate).getFullYear();

    // Get translation provider display name
    const translationProviderName = article.translationProvider === 'claude-api' ? 'Claude AI'
        : article.translationProvider === 'openai' ? 'OpenAI GPT-4'
        : article.translationProvider === 'claude-cli' ? 'Claude AI'
        : 'AI';

    // Prepare template data with all SEO fields
    // Always use translated content for description (SEO in target language)
    const translatedDescription = extractPlainText(article.content, 160);

    const data = {
        // Basic info
        title: article.title,
        titleJson: escapeForJson(article.title), // Escaped for JSON-LD
        originalTitle: article.originalTitle || article.title,
        originalTitleJson: escapeForJson(article.originalTitle || article.title), // Escaped for JSON-LD
        shortTitle: truncateTitle(article.title),
        description: translatedDescription,
        descriptionJson: escapeForJson(translatedDescription), // Escaped for JSON-LD
        slug: article.slug,
        content: contentHtml,

        // Source info
        source: article.source,
        sourceUrl: article.sourceUrl,
        originalUrl: article.originalUrl,

        // Dates
        publishedDate: formatDateISO(article.publishedDate),
        modifiedDate: formatDateISO(article.translatedAt || article.publishedDate),
        formattedDate: formatDate(article.publishedDate),
        copyrightYear: copyrightYear,

        // Translation
        translationProvider: translationProviderName,

        // SEO metrics
        wordCount: wordCount,
        readingTime: readingTime,
        keywords: keywords,
        articleBodyText: escapeForJson(articleBodyText), // Escaped for JSON-LD

        // Share URLs
        encodedTitle: encodeURIComponent(article.title),

        // Assets
        ogImage: 'https://nometa.az/assets/images/og-image.png',
        cssVersion: CSS_VERSION
    };

    // Render template
    const html = renderTemplate(template, data);

    // Write HTML file
    const outputPath = path.join(articleDir, 'index.html');
    safeWriteFile(outputPath, html);

    return outputPath;
}

/**
 * Generate blog index page
 */
function generateIndexPage(articles, template) {
    logger.debug('generate', 'Generating index page', { articleCount: articles.length });

    // Build articles HTML
    let articlesHtml = '';

    if (articles.length === 0) {
        articlesHtml = `
            <div class="no-articles">
                <p>Hələlik məqalə yoxdur. Tezliklə yeni məqalələr əlavə ediləcək.</p>
            </div>`;
    } else {
        for (const article of articles) {
            articlesHtml += `
            <article class="article-card">
                <div class="article-card-meta">
                    <span class="article-source">${article.source}</span>
                    <time datetime="${formatDateISO(article.publishedDate)}">${formatDate(article.publishedDate)}</time>
                </div>
                <h2 class="article-card-title">
                    <a href="/news/${article.slug}/">${article.title}</a>
                </h2>
                <p class="article-card-excerpt">${extractPlainText(article.content, 200)}</p>
                <a href="/news/${article.slug}/" class="read-more">Oxumağa davam et &rarr;</a>
            </article>`;
        }
    }

    // Generate ItemList JSON-LD for rich search results
    let itemListSchema = '';
    if (articles.length > 0) {
        const itemListItems = articles.map((article, index) => `
            {
                "@type": "ListItem",
                "position": ${index + 1},
                "url": "https://nometa.az/news/${article.slug}/"
            }`).join(',');

        itemListSchema = `<script type="application/ld+json">
    {
        "@context": "https://schema.org",
        "@type": "ItemList",
        "itemListElement": [${itemListItems}
        ]
    }
    </script>`;
    }

    // Replace the template placeholders
    let html = template
        .replace(/\{\{cssVersion\}\}/g, CSS_VERSION)
        .replace(/\{\{itemListSchema\}\}/g, itemListSchema)
        .replace(/\{\{#if articles\}\}[\s\S]*?\{\{\/if\}\}/g, articlesHtml);

    // Write index HTML file
    const outputPath = path.join(NEWS_DIR, 'index.html');
    safeWriteFile(outputPath, html);

    return outputPath;
}

/**
 * Generate RSS feed
 */
function generateRSSFeed(articles) {
    logger.debug('generate', 'Generating RSS feed', { articleCount: Math.min(articles.length, 20) });

    const items = articles.slice(0, 20).map(article => `
    <item>
      <title><![CDATA[${article.title}]]></title>
      <link>https://nometa.az/news/${article.slug}/</link>
      <guid>https://nometa.az/news/${article.slug}/</guid>
      <pubDate>${new Date(article.publishedDate).toUTCString()}</pubDate>
      <description><![CDATA[${extractPlainText(article.content, 300)}]]></description>
      <source url="${article.sourceUrl}">${article.source}</source>
    </item>`).join('');

    const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>NoMeta.az Xəbərlər</title>
    <link>https://nometa.az/news/</link>
    <description>Texnologiya şirkətlərinin mühəndislik bloqlarından Azərbaycan dilinə tərcümə edilmiş məqalələr.</description>
    <language>az</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <atom:link href="https://nometa.az/news/feed.xml" rel="self" type="application/rss+xml"/>
    ${items}
  </channel>
</rss>`;

    const outputPath = path.join(NEWS_DIR, 'feed.xml');
    safeWriteFile(outputPath, rss.trim());

    return outputPath;
}

/**
 * Update sitemap.xml with news pages
 */
function updateSitemap(articles) {
    logger.debug('generate', 'Updating sitemap', { articleCount: articles.length });

    // Generate news URLs
    const newsUrls = articles.map(article => `
    <url>
        <loc>https://nometa.az/news/${article.slug}/</loc>
        <lastmod>${formatDateISO(article.translatedAt || article.publishedDate)}</lastmod>
        <changefreq>monthly</changefreq>
        <priority>0.7</priority>
    </url>`).join('');

    const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url>
        <loc>https://nometa.az/</loc>
        <lastmod>${formatDateISO(new Date())}</lastmod>
        <changefreq>weekly</changefreq>
        <priority>1.0</priority>
    </url>
    <url>
        <loc>https://nometa.az/news/</loc>
        <lastmod>${formatDateISO(new Date())}</lastmod>
        <changefreq>daily</changefreq>
        <priority>0.9</priority>
    </url>
    ${newsUrls}
</urlset>`;

    safeWriteFile(SITEMAP_FILE, sitemap.trim());
    return SITEMAP_FILE;
}

/**
 * Update homepage with recent articles
 */
function updateHomepageRecentArticles(articles) {
    logger.debug('generate', 'Updating homepage with recent articles', { count: Math.min(articles.length, 3) });

    // Read current homepage
    let homepage;
    try {
        homepage = fs.readFileSync(HOMEPAGE_FILE, 'utf-8');
    } catch (error) {
        logger.error('generate', 'Failed to read homepage', { error: error.message });
        return;
    }

    // Take only the 3 most recent articles
    const recentArticles = articles.slice(0, 3);

    // Generate recent articles HTML
    let articlesHtml = '';
    if (recentArticles.length > 0) {
        for (const article of recentArticles) {
            articlesHtml += `
                    <article class="recent-article-card">
                        <div class="recent-article-meta">
                            <span class="recent-article-source">${article.source}</span>
                            <time datetime="${formatDateISO(article.publishedDate)}">${formatDate(article.publishedDate)}</time>
                        </div>
                        <h3><a href="/news/${article.slug}/">${article.title}</a></h3>
                    </article>`;
        }
    } else {
        articlesHtml = `
                    <p class="no-recent-articles">Tezliklə yeni məqalələr əlavə ediləcək.</p>`;
    }

    // Build the full section
    const recentSection = `<!-- RECENT_ARTICLES_START -->
            <section class="recent-articles" aria-labelledby="recent-articles-heading">
                <h2 id="recent-articles-heading">Son Məqalələr</h2>
                <div class="recent-articles-grid">${articlesHtml}
                </div>
                <a href="/news/" class="view-all-link">Bütün məqalələr &rarr;</a>
            </section>
            <!-- RECENT_ARTICLES_END -->`;

    // Replace the section in homepage
    const regex = /<!-- RECENT_ARTICLES_START -->[\s\S]*?<!-- RECENT_ARTICLES_END -->/;
    if (regex.test(homepage)) {
        homepage = homepage.replace(regex, recentSection);
        safeWriteFile(HOMEPAGE_FILE, homepage);
        logger.info('generate', 'Updated homepage with recent articles', { count: recentArticles.length });
    } else {
        logger.warn('generate', 'Recent articles section not found in homepage');
    }
}

/**
 * Main generation function
 */
function generateBlog() {
    const endTimer = logger.timer('generate', 'Blog generation');

    logger.info('generate', 'Starting blog generation');

    // Initialize database
    db.initDb();

    // Ensure news directory exists
    if (!fs.existsSync(NEWS_DIR)) {
        fs.mkdirSync(NEWS_DIR, { recursive: true });
        logger.debug('generate', 'Created news directory', { path: NEWS_DIR });
    }

    // Load templates
    const articleTemplate = loadTemplate('blog-article.html');
    const indexTemplate = loadTemplate('blog-index.html');

    // Get published articles from database
    const articles = getPublishedArticles();
    logger.info('generate', 'Found articles to publish', { count: articles.length });

    // Generate article pages
    for (const article of articles) {
        generateArticlePage(article, articleTemplate);
    }

    // Generate index page
    generateIndexPage(articles, indexTemplate);

    // Generate RSS feed
    generateRSSFeed(articles);

    // Update sitemap
    updateSitemap(articles);

    // Update homepage with recent articles
    updateHomepageRecentArticles(articles);

    endTimer({
        articlesGenerated: articles.length,
        outputDir: NEWS_DIR
    });

    return {
        articlesGenerated: articles.length,
        outputDir: NEWS_DIR
    };
}

// Export functions
module.exports = {
    generateBlog,
    generateArticlePage,
    generateIndexPage,
    generateRSSFeed,
    updateSitemap,
    getPublishedArticles,
    formatDate,
    formatDateISO,
    renderTemplate,
    markdownToHtml,
    escapeForJson,
    extractPlainText,
    extractKeywords,
    truncateTitle,
    removeDuplicateTitle,
    calculateReadingTime,
    CSS_VERSION
};

// Run if called directly
if (require.main === module) {
    generateBlog();
}
