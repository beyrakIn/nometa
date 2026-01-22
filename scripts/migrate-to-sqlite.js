/**
 * Migration Script: JSON to SQLite
 * Migrates existing articles.json and translated/*.json to SQLite database
 */

const fs = require('fs');
const path = require('path');
const db = require('./db');

const ARTICLES_FILE = path.join(__dirname, '..', 'content', 'articles.json');
const TRANSLATED_DIR = path.join(__dirname, '..', 'content', 'translated');

function migrate() {
    console.log('Starting migration to SQLite...\n');

    // Initialize database
    db.initDb();
    console.log(`Database initialized at: ${db.DB_PATH}\n`);

    // Load existing articles.json
    let articlesData = { articles: [], lastFetched: null };
    if (fs.existsSync(ARTICLES_FILE)) {
        try {
            articlesData = JSON.parse(fs.readFileSync(ARTICLES_FILE, 'utf-8'));
            console.log(`Found ${articlesData.articles.length} articles in articles.json`);
        } catch (error) {
            console.error('Error reading articles.json:', error.message);
        }
    } else {
        console.log('No articles.json found');
    }

    // Load translated articles
    const translatedArticles = new Map();
    if (fs.existsSync(TRANSLATED_DIR)) {
        const files = fs.readdirSync(TRANSLATED_DIR).filter(f => f.endsWith('.json'));
        console.log(`Found ${files.length} translated articles`);

        for (const file of files) {
            try {
                const filepath = path.join(TRANSLATED_DIR, file);
                const translated = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
                // Use slug (filename without .json) as key
                const slug = file.replace('.json', '');
                translatedArticles.set(slug, translated);
            } catch (error) {
                console.error(`Error reading ${file}:`, error.message);
            }
        }
    } else {
        console.log('No translated directory found');
    }

    // Merge and insert articles
    console.log('\nMigrating articles...');
    let inserted = 0;
    let skipped = 0;
    let errors = 0;

    for (const article of articlesData.articles) {
        try {
            // Check if there's translated content for this article
            const translated = translatedArticles.get(article.slug);

            // Prepare article data
            const articleData = {
                id: article.id,
                title: article.title,
                originalTitle: article.title,
                originalUrl: article.originalUrl,
                source: article.source,
                sourceUrl: article.sourceUrl,
                publishedDate: article.publishedDate,
                description: article.description,
                content: article.content,
                originalContent: article.content,
                slug: article.slug,
                status: article.status || 'pending',
                fetchedAt: article.fetchedAt,
                translatedTitle: null,
                translatedContent: null,
                translatedAt: article.translatedAt || null,
                translationProvider: article.translationProvider || null,
                publishedAt: article.publishedAt || null
            };

            // Merge translated data if available
            if (translated) {
                articleData.translatedTitle = translated.title !== translated.originalTitle
                    ? translated.title
                    : null;
                articleData.translatedContent = translated.content;
                articleData.translatedAt = translated.translatedAt;
                articleData.translationProvider = translated.translationProvider;
                articleData.status = translated.status || articleData.status;
                articleData.publishedAt = translated.publishedAt;
            }

            // Insert into database
            if (db.insertArticle(articleData)) {
                inserted++;
            } else {
                skipped++; // Duplicate URL or slug
            }
        } catch (error) {
            console.error(`  Error inserting article "${article.title}":`, error.message);
            errors++;
        }
    }

    // Handle translated articles that might not be in articles.json
    for (const [slug, translated] of translatedArticles) {
        // Check if already inserted
        if (!db.getArticleBySlug(slug)) {
            try {
                const articleData = {
                    id: translated.id || `migrated-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                    title: translated.originalTitle || translated.title,
                    originalTitle: translated.originalTitle || translated.title,
                    originalUrl: translated.originalUrl,
                    source: translated.source,
                    sourceUrl: translated.sourceUrl,
                    publishedDate: translated.publishedDate,
                    description: translated.description,
                    content: translated.originalContent || translated.content,
                    originalContent: translated.originalContent || translated.content,
                    slug: slug,
                    status: translated.status || 'translated',
                    fetchedAt: translated.fetchedAt,
                    translatedTitle: translated.title !== translated.originalTitle
                        ? translated.title
                        : null,
                    translatedContent: translated.content,
                    translatedAt: translated.translatedAt,
                    translationProvider: translated.translationProvider,
                    publishedAt: translated.publishedAt
                };

                if (db.insertArticle(articleData)) {
                    inserted++;
                    console.log(`  Inserted orphan translated article: ${slug}`);
                }
            } catch (error) {
                console.error(`  Error inserting orphan article "${slug}":`, error.message);
                errors++;
            }
        }
    }

    // Save metadata
    if (articlesData.lastFetched) {
        db.setMetadata('last_fetched', articlesData.lastFetched);
    }

    // Verify migration
    const totalInDb = db.getArticleCount();
    const pendingCount = db.getArticleCount('pending');
    const translatedCount = db.getArticleCount('translated');
    const publishedCount = db.getArticleCount('published');

    console.log('\n════════════════════════════════════════');
    console.log('Migration Complete!');
    console.log('════════════════════════════════════════');
    console.log(`  Inserted:   ${inserted}`);
    console.log(`  Skipped:    ${skipped} (duplicates)`);
    console.log(`  Errors:     ${errors}`);
    console.log('');
    console.log('Database Statistics:');
    console.log(`  Total:      ${totalInDb}`);
    console.log(`  Pending:    ${pendingCount}`);
    console.log(`  Translated: ${translatedCount}`);
    console.log(`  Published:  ${publishedCount}`);
    console.log('');
    console.log(`Database file: ${db.DB_PATH}`);

    // Close database
    db.closeDb();

    return { inserted, skipped, errors, total: totalInDb };
}

// Run if called directly
if (require.main === module) {
    try {
        migrate();
    } catch (error) {
        console.error('Migration failed:', error);
        process.exit(1);
    }
}

module.exports = { migrate };
