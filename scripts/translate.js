/**
 * Multi-AI Translation Module for NoMeta.az Blog
 * Supports: Claude API, OpenAI API, Claude Code CLI
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const logger = require('./logger');

/**
 * Translation prompt template for Azerbaijani
 */
// Retry configuration for transient errors
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 5000; // 5 seconds
const API_TIMEOUT = 120000; // 2 minutes

/**
 * Sleep helper for retry delays
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if error is retryable (timeout, server error, rate limit)
 */
function isRetryableError(error) {
    const message = error.message || '';
    const status = error.status || error.statusCode || 0;

    // Cloudflare errors (520-530)
    if (status >= 520 && status <= 530) return true;
    // Server errors (500-599)
    if (status >= 500 && status < 600) return true;
    // Rate limiting
    if (status === 429) return true;
    // Timeout errors
    if (message.includes('timeout') || message.includes('ETIMEDOUT') || message.includes('ECONNRESET')) return true;
    // Cloudflare HTML error pages
    if (message.includes('524') || message.includes('Server error')) return true;

    return false;
}

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
 * Translate using Claude API (Anthropic SDK) with retry logic
 */
async function translateWithClaudeAPI(text, title) {
    const Anthropic = require('@anthropic-ai/sdk');

    // Try database first, fall back to environment variable
    db.initDb();
    const apiKey = db.getApiKey('claude-api') || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        const error = new Error('Claude API key not configured (check Settings or set ANTHROPIC_API_KEY)');
        logger.error('translate', 'Claude API key missing', { error: error.message });
        throw error;
    }

    const client = new Anthropic({
        apiKey,
        timeout: API_TIMEOUT
    });

    const prompt = TRANSLATION_PROMPT
        .replace('{{title}}', title)
        .replace('{{content}}', text);

    let lastError;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        logger.debug('translate', 'Sending to Claude API', {
            model: 'claude-sonnet-4-20250514',
            contentLength: text.length,
            attempt
        });

        try {
            const response = await client.messages.create({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 8192,
                messages: [
                    { role: 'user', content: prompt }
                ]
            });

            // Validate response structure
            if (!response.content || !response.content[0] || !response.content[0].text) {
                throw new Error('Invalid Claude API response: missing content');
            }

            logger.debug('translate', 'Claude API response received', {
                outputLength: response.content[0].text.length,
                attempt
            });

            return response.content[0].text;
        } catch (error) {
            lastError = error;
            logger.warn('translate', 'Claude API request failed', {
                error: error.message,
                status: error.status,
                attempt,
                maxRetries: MAX_RETRIES
            });

            if (attempt < MAX_RETRIES && isRetryableError(error)) {
                const delay = INITIAL_RETRY_DELAY * Math.pow(2, attempt - 1);
                logger.info('translate', `Retrying in ${delay / 1000}s...`, { attempt, delay });
                await sleep(delay);
            } else {
                break;
            }
        }
    }

    logger.error('translate', 'Claude API request failed after retries', {
        error: lastError.message,
        stack: lastError.stack
    });
    throw lastError;
}

/**
 * Translate using OpenAI API with retry logic
 */
async function translateWithOpenAI(text, title) {
    const OpenAI = require('openai');

    // Try database first, fall back to environment variable
    db.initDb();
    const apiKey = db.getApiKey('openai') || process.env.OPENAI_API_KEY;
    if (!apiKey) {
        const error = new Error('OpenAI API key not configured (check Settings or set OPENAI_API_KEY)');
        logger.error('translate', 'OpenAI API key missing', { error: error.message });
        throw error;
    }

    const client = new OpenAI({
        apiKey,
        timeout: API_TIMEOUT
    });

    const prompt = TRANSLATION_PROMPT
        .replace('{{title}}', title)
        .replace('{{content}}', text);

    let lastError;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        logger.debug('translate', 'Sending to OpenAI API', {
            model: 'gpt-4-turbo-preview',
            contentLength: text.length,
            attempt
        });

        try {
            const response = await client.chat.completions.create({
                model: 'gpt-4-turbo-preview',
                max_tokens: 8192,
                messages: [
                    { role: 'user', content: prompt }
                ]
            });

            // Validate response structure
            if (!response.choices || !response.choices[0] || !response.choices[0].message || !response.choices[0].message.content) {
                throw new Error('Invalid OpenAI API response: missing content');
            }

            logger.debug('translate', 'OpenAI API response received', {
                outputLength: response.choices[0].message.content.length,
                attempt
            });

            return response.choices[0].message.content;
        } catch (error) {
            lastError = error;
            logger.warn('translate', 'OpenAI API request failed', {
                error: error.message,
                status: error.status,
                attempt,
                maxRetries: MAX_RETRIES
            });

            if (attempt < MAX_RETRIES && isRetryableError(error)) {
                const delay = INITIAL_RETRY_DELAY * Math.pow(2, attempt - 1);
                logger.info('translate', `Retrying in ${delay / 1000}s...`, { attempt, delay });
                await sleep(delay);
            } else {
                break;
            }
        }
    }

    logger.error('translate', 'OpenAI API request failed after retries', {
        error: lastError.message,
        stack: lastError.stack
    });
    throw lastError;
}

/**
 * Translate using Claude Code CLI (local, no API key needed)
 * Uses spawn with stdin to avoid shell injection vulnerabilities
 */
async function translateWithClaudeCLI(text, title) {
    const CLI_TIMEOUT = 600000; // 10 minutes for large articles

    const attemptTranslation = () => new Promise((resolve, reject) => {
        const prompt = TRANSLATION_PROMPT
            .replace('{{title}}', title)
            .replace('{{content}}', text);

        logger.debug('translate', 'Sending to Claude CLI', {
            contentLength: text.length
        });

        // Use spawn with stdin to avoid shell injection (no temp file or shell command)
        const claudeProcess = spawn('claude', ['--print'], {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';
        let killed = false;

        // Set up manual timeout (spawn timeout option doesn't work reliably)
        const timeoutId = setTimeout(() => {
            killed = true;
            claudeProcess.kill('SIGTERM');
            logger.warn('translate', 'Claude CLI timed out, killing process', {
                timeout: CLI_TIMEOUT
            });
        }, CLI_TIMEOUT);

        claudeProcess.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        claudeProcess.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        claudeProcess.on('error', (error) => {
            clearTimeout(timeoutId);
            logger.error('translate', 'Claude CLI spawn failed', {
                error: error.message,
                stack: error.stack
            });
            reject(new Error(`Claude CLI error: ${error.message}`));
        });

        claudeProcess.on('close', (code, signal) => {
            clearTimeout(timeoutId);

            // Handle process killed by signal (code is null)
            if (code === null) {
                const reason = killed ? 'timeout' : (signal || 'unknown signal');
                logger.error('translate', 'Claude CLI was killed', {
                    signal,
                    reason,
                    stdoutLength: stdout.length,
                    stderr
                });
                reject(new Error(`Claude CLI was killed (${reason}). Try using claude-api instead for large articles.`));
                return;
            }

            if (code !== 0) {
                logger.error('translate', 'Claude CLI execution failed', {
                    exitCode: code,
                    stderr
                });
                reject(new Error(`Claude CLI exited with code ${code}: ${stderr}`));
                return;
            }

            if (!stdout.trim()) {
                logger.error('translate', 'Claude CLI returned empty response');
                reject(new Error('Claude CLI returned empty response'));
                return;
            }

            logger.debug('translate', 'Claude CLI response received', {
                outputLength: stdout.trim().length
            });

            resolve(stdout.trim());
        });

        // Write prompt to stdin and close it
        claudeProcess.stdin.write(prompt);
        claudeProcess.stdin.end();
    });

    // Retry logic for CLI
    let lastError;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            logger.info('translate', 'Claude CLI attempt', { attempt, maxRetries: MAX_RETRIES });
            return await attemptTranslation();
        } catch (error) {
            lastError = error;
            logger.warn('translate', 'Claude CLI attempt failed', {
                attempt,
                error: error.message
            });

            if (attempt < MAX_RETRIES) {
                const delay = INITIAL_RETRY_DELAY * Math.pow(2, attempt - 1);
                logger.info('translate', `Retrying CLI in ${delay / 1000}s...`, { attempt, delay });
                await sleep(delay);
            }
        }
    }

    throw lastError;
}

/**
 * Main translation function with provider selection
 */
async function translate(text, title, provider = 'claude-api') {
    logger.info('translate', 'Starting translation', {
        provider,
        contentLength: text.length
    });

    switch (provider) {
        case 'claude-api':
            return await translateWithClaudeAPI(text, title);
        case 'openai':
            return await translateWithOpenAI(text, title);
        case 'claude-cli':
            return await translateWithClaudeCLI(text, title);
        default:
            const error = new Error(`Unknown translation provider: ${provider}`);
            logger.error('translate', 'Unknown provider', { provider });
            throw error;
    }
}

/**
 * Clean content by removing translation artifacts at the start
 * Handles cases like "Məzmun: ...", "Content: ...", or repeated title prefixes
 */
function cleanTranslatedContent(content) {
    let cleaned = content;

    // Remove "Məzmun:" / "Content:" prefix at start (with or without markdown heading)
    cleaned = cleaned.replace(/^#+\s*(Məzmun|Content)\s*:\s*/i, '');
    cleaned = cleaned.replace(/^(Məzmun|Content)\s*:\s*/i, '');

    // Remove any remaining title prefixes at the very start
    cleaned = cleaned.replace(/^(Başlıq|Title|Sərlövhə)\s*:\s*[^\n]+\n*/i, '');

    return cleaned.trim();
}

/**
 * Extract translated title from translated content and strip title line
 * Looks for patterns like "# Title", "# Başlıq: Title", or "Başlıq: Title" at the start
 * Returns { title, content } where content has the title line removed
 */
function extractTitleFromContent(translatedContent, originalTitle) {
    const lines = translatedContent.split('\n');
    let titleLineIndex = -1;

    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (!trimmed) continue;

        let title = null;

        // Check for markdown heading
        const headingMatch = trimmed.match(/^#+\s*(.+)$/);
        if (headingMatch) {
            title = headingMatch[1].trim();
            titleLineIndex = i;
        }

        // Check for plain text title with prefix (no markdown heading)
        // e.g., "Başlıq: Some Title" or "Title: Some Title"
        if (!title) {
            const plainTitleMatch = trimmed.match(/^(Başlıq|Title|Sərlövhə)\s*:\s*(.+)$/i);
            if (plainTitleMatch) {
                title = plainTitleMatch[2].trim();
                titleLineIndex = i;
            }
        }

        if (title) {
            // Remove common prefixes like "Başlıq:" or "Title:" (for markdown headings)
            title = title.replace(/^(Başlıq|Title|Sərlövhə)\s*:\s*/i, '');

            // Sanity check: title should be reasonable length and not look like content
            if (title.length > 0 && title.length < 200 && !title.includes('<p>')) {
                // Strip the title line from content
                const contentLines = [...lines];
                contentLines.splice(titleLineIndex, 1);
                // Remove leading empty lines
                while (contentLines.length > 0 && !contentLines[0].trim()) {
                    contentLines.shift();
                }
                // Clean the remaining content of any translation artifacts
                const cleanedContent = cleanTranslatedContent(contentLines.join('\n'));
                return { title, content: cleanedContent };
            }
        }

        // If first non-empty line isn't a heading or title prefix, stop looking
        break;
    }

    // Fallback: return original title if extraction fails, but still clean content
    logger.warn('translate', 'Could not extract title from content, using original', {
        originalTitle,
        firstLine: lines[0]?.substring(0, 100)
    });
    return { title: originalTitle, content: cleanTranslatedContent(translatedContent) };
}

/**
 * Translate an article and save to database
 */
async function translateArticle(article, provider = 'claude-api') {
    const endTimer = logger.timer('translate', 'Article translation');

    logger.info('translate', 'Starting article translation', {
        articleId: article.id,
        title: article.title,
        source: article.source,
        provider
    });

    try {
        // Initialize database
        db.initDb();

        // Get the original content (use originalContent if available, otherwise content)
        const originalContent = article.originalContent || article.content;
        const originalTitle = article.originalTitle || article.title;

        // Translate content (includes title in the translation)
        const rawTranslatedContent = await translate(originalContent, originalTitle, provider);

        // Extract translated title from the content and strip title line
        // (avoids separate API call and ensures consistency)
        const { title: translatedTitle, content: translatedContent } = extractTitleFromContent(rawTranslatedContent, originalTitle);

        // Update article in database
        const translatedAt = new Date().toISOString();
        const updatedArticle = db.updateArticle(article.id, {
            translatedTitle: translatedTitle,
            translatedContent: translatedContent,
            translatedAt: translatedAt,
            translationProvider: provider,
            status: 'translated'
        });

        endTimer({
            articleId: article.id,
            provider,
            inputLength: originalContent.length,
            outputLength: translatedContent.length
        });

        return updatedArticle;
    } catch (error) {
        logger.error('translate', 'Article translation failed', {
            articleId: article.id,
            title: article.title,
            provider,
            error: error.message,
            stack: error.stack
        });
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
 * Checks database first, falls back to environment variables
 */
function checkProviders() {
    db.initDb();
    const available = [];

    // Check Claude API (database first, then env)
    if (db.getApiKey('claude-api') || process.env.ANTHROPIC_API_KEY) {
        available.push('claude-api');
    }

    // Check OpenAI API (database first, then env)
    if (db.getApiKey('openai') || process.env.OPENAI_API_KEY) {
        available.push('openai');
    }

    // Check Claude CLI
    try {
        execSync('which claude', { encoding: 'utf-8' });
        available.push('claude-cli');
    } catch {
        logger.debug('translate', 'Claude CLI not available');
    }

    logger.debug('translate', 'Providers checked', { available });
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
        console.log('  - Configure API keys via Admin Panel (Settings tab)');
        console.log('  - Or set environment variables: ANTHROPIC_API_KEY, OPENAI_API_KEY');
        console.log('  - Claude CLI: Install claude CLI tool');
    }
}
