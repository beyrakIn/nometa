/**
 * Static Blog Generator for NoMeta.az
 * Generates HTML pages from translated articles in SQLite database
 */

const fs = require('fs');
const path = require('path');
const { marked } = require('marked');
const db = require('./db');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const NEWS_DIR = path.join(__dirname, '..', 'news');
const SITEMAP_FILE = path.join(__dirname, '..', 'sitemap.xml');

// Current CSS version for cache busting (format: YYYYMMDDNN)
const CSS_VERSION = '2026012202';

/**
 * Load template file
 */
function loadTemplate(name) {
    const filepath = path.join(TEMPLATES_DIR, name);
    return fs.readFileSync(filepath, 'utf-8');
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
    // Configure marked
    marked.setOptions({
        gfm: true,
        breaks: false,
        headerIds: true,
        mangle: false
    });

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
 */
function extractPlainText(content, maxLength = 500) {
    const text = content
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/[#*_`\[\]]/g, '')
        .trim();

    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength).replace(/\s+\S*$/, '') + '...';
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
    console.log(`  Generating: ${article.slug}/`);

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
    const data = {
        // Basic info
        title: article.title,
        originalTitle: article.originalTitle || article.title,
        shortTitle: truncateTitle(article.title),
        description: article.description || extractPlainText(article.content, 160),
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
        articleBodyText: articleBodyText.replace(/"/g, '\\"'), // Escape quotes for JSON

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
    fs.writeFileSync(outputPath, html, 'utf-8');

    return outputPath;
}

/**
 * Generate blog index page
 */
function generateIndexPage(articles, template) {
    console.log('  Generating index page...');

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

    // Replace the template placeholders
    let html = template
        .replace(/\{\{cssVersion\}\}/g, CSS_VERSION)
        .replace(/\{\{#if articles\}\}[\s\S]*?\{\{\/if\}\}/g, articlesHtml);

    // Write index HTML file
    const outputPath = path.join(NEWS_DIR, 'index.html');
    fs.writeFileSync(outputPath, html, 'utf-8');

    return outputPath;
}

/**
 * Generate RSS feed
 */
function generateRSSFeed(articles) {
    console.log('  Generating RSS feed...');

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
    fs.writeFileSync(outputPath, rss.trim(), 'utf-8');

    return outputPath;
}

/**
 * Update sitemap.xml with news pages
 */
function updateSitemap(articles) {
    console.log('  Updating sitemap...');

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

    fs.writeFileSync(SITEMAP_FILE, sitemap.trim(), 'utf-8');
    return SITEMAP_FILE;
}

/**
 * Main generation function
 */
function generateBlog() {
    console.log('Starting blog generation...\n');

    // Initialize database
    db.initDb();

    // Ensure news directory exists
    if (!fs.existsSync(NEWS_DIR)) {
        fs.mkdirSync(NEWS_DIR, { recursive: true });
    }

    // Load templates
    const articleTemplate = loadTemplate('blog-article.html');
    const indexTemplate = loadTemplate('blog-index.html');

    // Get published articles from database
    const articles = getPublishedArticles();
    console.log(`Found ${articles.length} articles to publish\n`);

    // Generate article pages
    console.log('Generating article pages:');
    for (const article of articles) {
        generateArticlePage(article, articleTemplate);
    }

    // Generate index page
    console.log('\nGenerating supporting files:');
    generateIndexPage(articles, indexTemplate);

    // Generate RSS feed
    generateRSSFeed(articles);

    // Update sitemap
    updateSitemap(articles);

    console.log('\nBlog generation complete!');
    console.log(`  Articles: ${articles.length}`);
    console.log(`  Output: ${NEWS_DIR}`);

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
    CSS_VERSION
};

// Run if called directly
if (require.main === module) {
    generateBlog();
}
