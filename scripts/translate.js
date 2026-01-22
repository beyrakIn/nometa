/**
 * Multi-AI Translation Module for NoMeta.az Blog
 * Supports: Claude API, OpenAI API, Claude Code CLI
 */

const { exec, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const db = require('./db');

/**
 * Translation prompt template for Azerbaijani
 */
const TRANSLATION_PROMPT = `You are a professional translator specializing in technical content.
Translate the following article from English to Azerbaijani (az).

IMPORTANT RULES:
1. Preserve all technical terms, code snippets, and programming keywords in English
2. Keep proper nouns (company names, product names, people's names) unchanged
3. Maintain the original formatting (headers, lists, code blocks)
4. Keep URLs and links unchanged
5. Translate naturally - not word-for-word
6. Use formal/professional tone appropriate for technical articles
7. For code comments inside code blocks, translate them to Azerbaijani
8. Keep markdown formatting intact

Return ONLY the translated content, no explanations.

---
ARTICLE TO TRANSLATE:

Title: {{title}}

Content:
{{content}}`;

/**
 * Translate using Claude API (Anthropic SDK)
 */
async function translateWithClaudeAPI(text, title) {
    const Anthropic = require('@anthropic-ai/sdk');

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        throw new Error('ANTHROPIC_API_KEY environment variable is not set');
    }

    const client = new Anthropic({ apiKey });

    const prompt = TRANSLATION_PROMPT
        .replace('{{title}}', title)
        .replace('{{content}}', text);

    console.log('  Sending to Claude API...');

    const response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8192,
        messages: [
            { role: 'user', content: prompt }
        ]
    });

    return response.content[0].text;
}

/**
 * Translate using OpenAI API
 */
async function translateWithOpenAI(text, title) {
    const OpenAI = require('openai');

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        throw new Error('OPENAI_API_KEY environment variable is not set');
    }

    const client = new OpenAI({ apiKey });

    const prompt = TRANSLATION_PROMPT
        .replace('{{title}}', title)
        .replace('{{content}}', text);

    console.log('  Sending to OpenAI API...');

    const response = await client.chat.completions.create({
        model: 'gpt-4-turbo-preview',
        max_tokens: 8192,
        messages: [
            { role: 'user', content: prompt }
        ]
    });

    return response.choices[0].message.content;
}

/**
 * Translate using Claude Code CLI (local, no API key needed)
 */
async function translateWithClaudeCLI(text, title) {
    return new Promise((resolve, reject) => {
        const prompt = TRANSLATION_PROMPT
            .replace('{{title}}', title)
            .replace('{{content}}', text);

        // Create a temporary file for the prompt
        const tempFile = path.join(__dirname, '..', 'content', '.temp-prompt.txt');
        fs.writeFileSync(tempFile, prompt, 'utf-8');

        console.log('  Sending to Claude Code CLI...');

        // Use async exec to avoid blocking the event loop
        exec(`cat "${tempFile}" | claude --print`, {
            encoding: 'utf-8',
            maxBuffer: 10 * 1024 * 1024, // 10MB buffer
            timeout: 300000 // 5 minute timeout
        }, (error, stdout, stderr) => {
            // Clean up temp file
            if (fs.existsSync(tempFile)) {
                fs.unlinkSync(tempFile);
            }

            if (error) {
                reject(new Error(`Claude CLI error: ${error.message}`));
                return;
            }

            resolve(stdout.trim());
        });
    });
}

/**
 * Main translation function with provider selection
 */
async function translate(text, title, provider = 'claude-api') {
    console.log(`\nTranslating with provider: ${provider}`);

    switch (provider) {
        case 'claude-api':
            return await translateWithClaudeAPI(text, title);
        case 'openai':
            return await translateWithOpenAI(text, title);
        case 'claude-cli':
            return await translateWithClaudeCLI(text, title);
        default:
            throw new Error(`Unknown translation provider: ${provider}`);
    }
}

/**
 * Translate an article and save to database
 */
async function translateArticle(article, provider = 'claude-api') {
    console.log(`\nTranslating: "${article.title}"`);
    console.log(`  Source: ${article.source}`);
    console.log(`  Provider: ${provider}`);

    try {
        // Initialize database
        db.initDb();

        // Get the original content (use originalContent if available, otherwise content)
        const originalContent = article.originalContent || article.content;
        const originalTitle = article.originalTitle || article.title;

        // Translate title (pass title as both arguments so the prompt shows the actual title)
        const translatedTitle = await translate(originalTitle, originalTitle, provider);

        // Translate content
        const translatedContent = await translate(originalContent, originalTitle, provider);

        // Update article in database
        const translatedAt = new Date().toISOString();
        const updatedArticle = db.updateArticle(article.id, {
            translatedTitle: translatedTitle.split('\n')[0].trim().replace(/^#+\s*/, ''), // First line, strip markdown heading
            translatedContent: translatedContent,
            translatedAt: translatedAt,
            translationProvider: provider,
            status: 'translated'
        });

        console.log(`  Translation saved to database`);

        return updatedArticle;
    } catch (error) {
        console.error(`  Translation failed: ${error.message}`);
        throw error;
    }
}

/**
 * Get all translated articles
 */
function getTranslatedArticles() {
    db.initDb();
    return db.getAllArticles({ status: ['translated', 'published'] });
}

/**
 * Get a translated article by slug
 */
function getTranslatedArticle(slug) {
    db.initDb();
    return db.getArticleBySlug(slug);
}

/**
 * Check available translation providers
 */
function checkProviders() {
    const available = [];

    // Check Claude API
    if (process.env.ANTHROPIC_API_KEY) {
        available.push('claude-api');
    }

    // Check OpenAI API
    if (process.env.OPENAI_API_KEY) {
        available.push('openai');
    }

    // Check Claude CLI
    try {
        execSync('which claude', { encoding: 'utf-8' });
        available.push('claude-cli');
    } catch {
        // Claude CLI not available
    }

    return available;
}

// Export functions
module.exports = {
    translate,
    translateArticle,
    getTranslatedArticles,
    getTranslatedArticle,
    checkProviders,
    TRANSLATION_PROMPT
};

// Run if called directly
if (require.main === module) {
    const providers = checkProviders();
    console.log('Available translation providers:', providers.length > 0 ? providers.join(', ') : 'None');

    if (providers.length === 0) {
        console.log('\nTo use translation providers:');
        console.log('  - Claude API: Set ANTHROPIC_API_KEY environment variable');
        console.log('  - OpenAI: Set OPENAI_API_KEY environment variable');
        console.log('  - Claude CLI: Install claude CLI tool');
    }
}
