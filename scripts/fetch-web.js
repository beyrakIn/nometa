/**
 * Web Page Fetcher for NoMeta.az Blog
 * Scrapes article metadata from Next.js/Sanity CMS pages (e.g., Anthropic engineering/research)
 */

const logger = require('./logger');

// Lazy-load fetch-rss to avoid circular dependency (fetch-rss imports fetch-web)
let _fetchRss = null;
function getFetchRss() {
    if (!_fetchRss) _fetchRss = require('./fetch-rss');
    return _fetchRss;
}

const FETCH_TIMEOUT = 15000;
const USER_AGENT = 'NoMeta.az Blog Fetcher/1.0';

/**
 * Fetch articles from a web page feed (non-RSS)
 * @param {Object} feed - Feed object with name, url, sourceUrl, type
 * @returns {Object} { articles, error }
 */
async function fetchWebFeed(feed) {
    try {
        logger.debug('fetch-web', 'Fetching web feed', { source: feed.name, url: feed.url });

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

        let html;
        try {
            const response = await fetch(feed.url, {
                headers: { 'User-Agent': USER_AGENT },
                signal: controller.signal
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            html = await response.text();
        } finally {
            clearTimeout(timeout);
        }

        const payloads = extractRSCPayloads(html);

        if (payloads.length === 0) {
            logger.warn('fetch-web', 'No RSC payloads found', { source: feed.name });
            return { articles: [], error: 'No RSC payloads found on page' };
        }

        const rawArticles = parseAnthropicArticles(payloads, feed.url);

        const articles = [];
        let filtered = 0;

        for (const raw of rawArticles) {
            const article = {
                id: `${feed.name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                title: raw.title || 'Untitled',
                originalUrl: raw.url,
                source: feed.name,
                sourceUrl: feed.sourceUrl,
                publishedDate: raw.publishedOn || new Date().toISOString(),
                description: raw.summary || '',
                content: raw.summary || '',
                slug: getFetchRss().generateSlug(raw.title || 'untitled'),
                status: 'pending',
                fetchedAt: new Date().toISOString(),
                translatedAt: null,
                publishedAt: null,
                translationProvider: null
            };

            // Apply keyword filtering but skip content length check (web listings only have summaries)
            const titleLower = (article.title || '').toLowerCase();
            const contentLower = (article.content || '').toLowerCase().substring(0, 500);
            const combined = titleLower + ' ' + contentLower;

            let isFiltered = false;
            const { FILTER_KEYWORDS } = getFetchRss();
            for (const keyword of FILTER_KEYWORDS) {
                if (combined.includes(keyword.toLowerCase())) {
                    logger.debug('fetch-web', 'Article filtered', {
                        title: article.title,
                        reason: `Contains "${keyword}"`
                    });
                    isFiltered = true;
                    filtered++;
                    break;
                }
            }

            if (!isFiltered) {
                articles.push(article);
            }
        }

        logger.info('fetch-web', 'Web feed fetched', {
            source: feed.name,
            found: articles.length,
            filtered
        });

        return { articles, error: null };
    } catch (error) {
        logger.error('fetch-web', 'Web feed fetch failed', {
            source: feed.name,
            url: feed.url,
            error: error.message,
            stack: error.stack
        });
        return { articles: [], error: error.message };
    }
}

/**
 * Extract RSC (React Server Components) payloads from HTML
 * These are embedded in <script> tags as self.__next_f.push([1,"..."]) calls
 * @param {string} html - Full HTML of the page
 * @param {Object} [options] - Options
 * @param {boolean} [options.doubleUnescape=true] - Apply second unescape pass for double-encoded data.
 *   Set to false when you need to preserve JSON string escaping (e.g., for body content parsing).
 * @returns {string[]} Array of decoded payload strings
 */
function extractRSCPayloads(html, options = {}) {
    const { doubleUnescape = true } = options;
    const payloads = [];
    // Match self.__next_f.push([1,"..."]) patterns
    const regex = /self\.__next_f\.push\(\[1,"(.+?)"\]\)/gs;
    let match;

    while ((match = regex.exec(html)) !== null) {
        try {
            // The content is a JSON-encoded string (possibly double-escaped)
            const raw = match[1];
            // Unescape: \" -> ", \\ -> \, \n -> newline, \t -> tab, \u00xx -> char
            let unescaped = raw
                .replace(/\\"/g, '"')
                .replace(/\\n/g, '\n')
                .replace(/\\t/g, '\t')
                .replace(/\\\\/g, '\\')
                .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

            // Handle double-encoding: if \" sequences remain, unescape again
            // Skip this when preserving JSON string escaping for body content parsing
            if (doubleUnescape && unescaped.includes('\\"')) {
                unescaped = unescaped
                    .replace(/\\"/g, '"')
                    .replace(/\\n/g, '\n')
                    .replace(/\\t/g, '\t')
                    .replace(/\\\\/g, '\\');
            }
            payloads.push(unescaped);
        } catch (e) {
            // Skip malformed payloads
        }
    }

    return payloads;
}

/**
 * Parse Anthropic article data from RSC payloads
 * Engineering pages have _type:"engineeringArticle", Research pages have _type:"post"
 * @param {string[]} payloads - Decoded RSC payload strings
 * @param {string} feedUrl - The feed URL (used to determine article URL base)
 * @returns {Array} Array of { title, slug, publishedOn, summary, url }
 */
function parseAnthropicArticles(payloads, feedUrl) {
    const articles = [];
    const seenSlugs = new Set();

    // Determine the base path from the feed URL
    let basePath = '/engineering';
    try {
        const parsed = new URL(feedUrl);
        basePath = parsed.pathname.replace(/\/$/, '');
    } catch {}

    const baseUrl = 'https://www.anthropic.com';

    // Combine all payloads into one string to search through
    const combined = payloads.join('\n');

    // Strategy 1: Recursively walk JSON-parseable fragments to find article objects
    // This is robust against field reordering and nesting
    try {
        extractArticlesFromJson(combined, articles, seenSlugs, baseUrl, basePath);
    } catch {}

    // Strategy 2: Regex patterns as fallback (handles partial/non-standard JSON)
    if (articles.length === 0) {
        // Pattern 1: title first
        let match;
        const pattern1 = /"title"\s*:\s*"([^"]+)"[^}]*?"slug"\s*:\s*\{\s*"current"\s*:\s*"([^"]+)"\s*\}[^}]*?"publishedOn"\s*:\s*"([^"]+)"(?:[^}]*?"summary"\s*:\s*"([^"]*)")?/g;
        while ((match = pattern1.exec(combined)) !== null) {
            const [, title, slug, publishedOn, summary] = match;
            if (!seenSlugs.has(slug)) {
                seenSlugs.add(slug);
                articles.push({
                    title: unescapeJsonString(title),
                    slug,
                    publishedOn,
                    summary: summary ? unescapeJsonString(summary) : '',
                    url: `${baseUrl}${basePath}/${slug}`
                });
            }
        }

        // Pattern 2: slug first
        const pattern2 = /"slug"\s*:\s*\{\s*"current"\s*:\s*"([^"]+)"\s*\}[^}]*?"title"\s*:\s*"([^"]+)"[^}]*?"publishedOn"\s*:\s*"([^"]+)"(?:[^}]*?"summary"\s*:\s*"([^"]*)")?/g;
        while ((match = pattern2.exec(combined)) !== null) {
            const [, slug, title, publishedOn, summary] = match;
            if (!seenSlugs.has(slug)) {
                seenSlugs.add(slug);
                articles.push({
                    title: unescapeJsonString(title),
                    slug,
                    publishedOn,
                    summary: summary ? unescapeJsonString(summary) : '',
                    url: `${baseUrl}${basePath}/${slug}`
                });
            }
        }
    }

    // Strategy 3: Try parsing JSON arrays as a last resort
    if (articles.length === 0) {
        try {
            const jsonArrayRegex = /\[[\s\S]*?\{[^}]*?"title"[^}]*?"slug"[^}]*?\}[\s\S]*?\]/g;
            let jsonMatch;
            while ((jsonMatch = jsonArrayRegex.exec(combined)) !== null) {
                try {
                    const parsed = JSON.parse(jsonMatch[0]);
                    if (Array.isArray(parsed)) {
                        for (const item of parsed) {
                            if (item.title && item.slug) {
                                const slug = typeof item.slug === 'object' ? item.slug.current : item.slug;
                                if (slug && !seenSlugs.has(slug)) {
                                    seenSlugs.add(slug);
                                    articles.push({
                                        title: item.title,
                                        slug,
                                        publishedOn: item.publishedOn || item.date || '',
                                        summary: item.summary || item.description || '',
                                        url: `${baseUrl}${basePath}/${slug}`
                                    });
                                }
                            }
                        }
                    }
                } catch {}
            }
        } catch {}
    }

    return articles;
}

/**
 * Fetch full article content from an individual article page
 * Extracts Sanity body blocks from RSC data and converts to HTML
 * @param {string} articleUrl - URL of the article page
 * @returns {Object} { content, hasFullContent }
 */
async function fetchArticleContent(articleUrl) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    try {
        const response = await fetch(articleUrl, {
            headers: { 'User-Agent': USER_AGENT },
            signal: controller.signal
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const html = await response.text();

        // Use single-unescape to preserve JSON string escaping in body content.
        // Double-unescape breaks inner quotes like \"approve\" -> "approve" which
        // makes the body array unparseable as JSON.
        const payloads = extractRSCPayloads(html, { doubleUnescape: false });

        if (payloads.length === 0) {
            return { content: '', hasFullContent: false };
        }

        const combined = payloads.join('\n');

        // Try to find body blocks in the RSC data
        const blocks = extractSanityBlocks(combined);

        if (blocks.length > 0) {
            // Return markdown (compact, good for translation) as primary content
            const markdown = sanityBlocksToMarkdown(blocks);
            const htmlContent = sanityBlocksToHtml(blocks);
            return { content: markdown, htmlContent, hasFullContent: markdown.length > 200 };
        }

        // Fallback: extract text content from the page
        const textContent = extractTextFromHtml(html);
        return { content: textContent, hasFullContent: textContent.length > 500 };
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Extract Sanity CMS block array from RSC payload data
 * @param {string} data - Combined RSC payload string
 * @returns {Array} Array of Sanity block objects
 */
function extractSanityBlocks(data) {
    const blocks = [];

    // Find "body":[ and use bracket matching with string awareness to find the array end.
    // This is needed because the body array contains nested arrays/objects and the
    // simple regex approach fails to find the correct closing bracket.
    try {
        const bodyIdx = data.indexOf('"body":[');
        if (bodyIdx === -1) return blocks;

        const arrayStart = data.indexOf('[', bodyIdx);
        if (arrayStart === -1) return blocks;

        // Bracket-match respecting string boundaries
        let depth = 0, inString = false, escape = false, end = -1;
        for (let i = arrayStart; i < data.length; i++) {
            const ch = data[i];
            if (escape) { escape = false; continue; }
            if (ch === '\\') { escape = true; continue; }
            if (ch === '"') { inString = !inString; continue; }
            if (inString) continue;
            if (ch === '[') depth++;
            else if (ch === ']') { depth--; if (depth === 0) { end = i + 1; break; } }
        }

        if (end === -1) return blocks;

        let bodyStr = data.substring(arrayStart, end);
        // Fix invalid JSON escape sequences: after RSC unescaping, code blocks may contain
        // \<actual newline> which is not valid JSON. Replace with \\n (JSON newline escape).
        // Also fix \<actual tab> → \\t.
        bodyStr = bodyStr.replace(/\\\n/g, '\\n').replace(/\\\t/g, '\\t');
        const parsed = JSON.parse(bodyStr);
        if (Array.isArray(parsed) && parsed.length > 0 && parsed[0]._type) {
            blocks.push(...parsed);
        }
    } catch (e) {
        logger.debug('fetch-web', 'Sanity block extraction failed', { error: e.message });
    }

    return blocks;
}

/**
 * Convert Sanity CMS block array to HTML
 * Handles: paragraphs, headings, code blocks, lists, links, marks
 * @param {Array} blocks - Array of Sanity block objects
 * @returns {string} HTML string
 */
function sanityBlocksToHtml(blocks) {
    if (!Array.isArray(blocks) || blocks.length === 0) return '';

    const html = [];
    let currentList = null;

    for (const block of blocks) {
        if (!block || !block._type) continue;

        // Handle list items
        if (block.listItem) {
            const listTag = block.listItem === 'number' ? 'ol' : 'ul';
            if (currentList !== listTag) {
                if (currentList) html.push(`</${currentList}>`);
                html.push(`<${listTag}>`);
                currentList = listTag;
            }
            html.push(`<li>${renderBlockChildren(block)}</li>`);
            continue;
        }

        // Close any open list
        if (currentList) {
            html.push(`</${currentList}>`);
            currentList = null;
        }

        switch (block._type) {
            case 'block': {
                const style = block.style || 'normal';
                const content = renderBlockChildren(block);

                if (!content.trim()) continue;

                switch (style) {
                    case 'h1': html.push(`<h1>${content}</h1>`); break;
                    case 'h2': html.push(`<h2>${content}</h2>`); break;
                    case 'h3': html.push(`<h3>${content}</h3>`); break;
                    case 'h4': html.push(`<h4>${content}</h4>`); break;
                    case 'blockquote': html.push(`<blockquote>${content}</blockquote>`); break;
                    default: html.push(`<p>${content}</p>`);
                }
                break;
            }
            case 'code':
            case 'codeBlock': {
                const lang = block.language || '';
                const code = escapeHtml(block.code || '');
                html.push(`<pre><code class="language-${lang}">${code}</code></pre>`);
                break;
            }
            case 'image': {
                const alt = block.description || block.alt || '';
                const caption = extractCaptionText(block);
                if (block.url) {
                    html.push(`<figure><img src="${escapeHtml(block.url)}" alt="${escapeHtml(alt)}" />${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ''}</figure>`);
                } else if (block.asset && block.asset._ref) {
                    html.push(`<figure><img alt="${escapeHtml(alt)}" />${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ''}</figure>`);
                }
                break;
            }
            case 'table': {
                const rows = block.rows || [];
                if (rows.length > 0) {
                    html.push('<table>');
                    for (let ri = 0; ri < rows.length; ri++) {
                        html.push('<tr>');
                        const cells = rows[ri].cells || [];
                        for (const cell of cells) {
                            const tag = ri === 0 ? 'th' : 'td';
                            let cellText = '';
                            if (cell && cell._type === 'tableCell' && Array.isArray(cell.content)) {
                                // Sanity tableCell with content blocks
                                cellText = cell.content.map(b => renderBlockChildren(b)).join(' ');
                            } else if (Array.isArray(cell)) {
                                cellText = cell.map(b => renderBlockChildren(b)).join('');
                            } else if (typeof cell === 'string') {
                                cellText = escapeHtml(cell);
                            }
                            html.push(`<${tag}>${cellText}</${tag}>`);
                        }
                        html.push('</tr>');
                    }
                    html.push('</table>');
                }
                break;
            }
            default:
                // Skip unknown block types
                break;
        }
    }

    // Close any open list
    if (currentList) {
        html.push(`</${currentList}>`);
    }

    return html.join('\n');
}

/**
 * Convert Sanity CMS block array to Markdown (compact format for translation)
 * @param {Array} blocks - Array of Sanity block objects
 * @returns {string} Markdown string
 */
function sanityBlocksToMarkdown(blocks) {
    if (!Array.isArray(blocks) || blocks.length === 0) return '';

    const lines = [];
    let listCounter = 0;

    for (const block of blocks) {
        if (!block || !block._type) continue;

        // Handle list items
        if (block.listItem) {
            const text = renderBlockChildrenPlain(block);
            if (block.listItem === 'number') {
                listCounter++;
                lines.push(`${listCounter}. ${text}`);
            } else {
                lines.push(`- ${text}`);
            }
            continue;
        }
        listCounter = 0;

        switch (block._type) {
            case 'block': {
                const style = block.style || 'normal';
                const text = renderBlockChildrenPlain(block);
                if (!text.trim()) continue;

                switch (style) {
                    case 'h1': lines.push(`\n# ${text}\n`); break;
                    case 'h2': lines.push(`\n## ${text}\n`); break;
                    case 'h3': lines.push(`\n### ${text}\n`); break;
                    case 'h4': lines.push(`\n#### ${text}\n`); break;
                    case 'blockquote': lines.push(`\n> ${text}\n`); break;
                    default: lines.push(`\n${text}\n`);
                }
                break;
            }
            case 'code':
            case 'codeBlock': {
                const lang = block.language || '';
                lines.push(`\n\`\`\`${lang}\n${block.code || ''}\n\`\`\`\n`);
                break;
            }
            case 'image': {
                const alt = block.description || block.alt || '';
                const caption = extractCaptionText(block);
                const url = block.url || '';
                lines.push(`\n![${alt}](${url})`);
                if (caption) lines.push(`*${caption}*`);
                lines.push('');
                break;
            }
            case 'table': {
                const rows = block.rows || [];
                if (rows.length > 0) {
                    lines.push('');
                    for (let ri = 0; ri < rows.length; ri++) {
                        const cells = rows[ri].cells || [];
                        const cellTexts = cells.map(cell => {
                            if (cell && cell._type === 'tableCell' && Array.isArray(cell.content)) {
                                return cell.content.map(b => renderBlockChildrenPlain(b)).join(' ');
                            }
                            return typeof cell === 'string' ? cell : '';
                        });
                        lines.push(`| ${cellTexts.join(' | ')} |`);
                        if (ri === 0) {
                            lines.push(`| ${cellTexts.map(() => '---').join(' | ')} |`);
                        }
                    }
                    lines.push('');
                }
                break;
            }
        }
    }

    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Render block children as plain text with markdown inline formatting
 */
function renderBlockChildrenPlain(block) {
    if (!block.children || !Array.isArray(block.children)) return '';
    const markDefs = block.markDefs || [];

    return block.children.map(child => {
        if (!child || child._type !== 'span') return '';
        let text = child.text || '';
        if (!text) return '';

        const marks = child.marks || [];
        for (const mark of marks) {
            switch (mark) {
                case 'strong': text = `**${text}**`; break;
                case 'em': text = `*${text}*`; break;
                case 'code': text = `\`${text}\``; break;
                default: {
                    const def = markDefs.find(d => d._key === mark);
                    if (def && def._type === 'link' && def.href) {
                        text = `[${text}](${def.href})`;
                    }
                    break;
                }
            }
        }
        return text;
    }).join('');
}

/**
 * Extract caption text from a Sanity image block's caption array
 */
function extractCaptionText(block) {
    if (!block.caption || !Array.isArray(block.caption)) return '';
    return block.caption
        .map(b => renderBlockChildren(b))
        .join(' ')
        .trim();
}

/**
 * Render the children of a Sanity block (text spans with marks)
 * @param {Object} block - Sanity block object with children array
 * @returns {string} HTML string
 */
function renderBlockChildren(block) {
    if (!block.children || !Array.isArray(block.children)) return '';

    const markDefs = block.markDefs || [];

    return block.children.map(child => {
        if (!child || child._type !== 'span') return '';

        let text = child.text || '';
        if (!text) return '';

        text = escapeHtml(text);

        // Apply marks (bold, italic, code, links)
        const marks = child.marks || [];
        for (const mark of marks) {
            switch (mark) {
                case 'strong':
                    text = `<strong>${text}</strong>`;
                    break;
                case 'em':
                    text = `<em>${text}</em>`;
                    break;
                case 'code':
                    text = `<code>${text}</code>`;
                    break;
                default: {
                    // Check markDefs for links
                    const def = markDefs.find(d => d._key === mark);
                    if (def && def._type === 'link' && def.href) {
                        text = `<a href="${escapeHtml(def.href)}">${text}</a>`;
                    }
                    break;
                }
            }
        }

        return text;
    }).join('');
}

/**
 * Extract readable text content from HTML (fallback)
 * @param {string} html - Full HTML page
 * @returns {string} Extracted text content
 */
function extractTextFromHtml(html) {
    // Remove script and style tags
    let text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    // Take a reasonable chunk
    if (text.length > 5000) {
        text = text.substring(0, 5000);
    }

    return text;
}

/**
 * Extract article objects from JSON fragments found in RSC data
 * Recursively walks parsed JSON to find objects with title + slug fields
 * @param {string} data - Combined RSC payload string
 * @param {Array} articles - Array to push found articles into
 * @param {Set} seenSlugs - Set of already-seen slugs for dedup
 * @param {string} baseUrl - Base URL (e.g. https://www.anthropic.com)
 * @param {string} basePath - Base path (e.g. /engineering)
 */
function extractArticlesFromJson(data, articles, seenSlugs, baseUrl, basePath) {
    // Find JSON objects/arrays in the data by looking for { or [ starts
    const jsonStarts = [];
    for (let i = 0; i < data.length; i++) {
        if (data[i] === '[' || data[i] === '{') {
            jsonStarts.push(i);
        }
    }

    // Try parsing from each start position (largest fragments first)
    const parsedRanges = [];
    for (const start of jsonStarts) {
        // Skip if this position is inside an already-parsed range
        if (parsedRanges.some(([s, e]) => start >= s && start < e)) continue;

        // Find a matching end by trying progressively shorter substrings
        const bracket = data[start];
        const closeBracket = bracket === '[' ? ']' : '}';
        let depth = 0;
        let end = -1;

        for (let i = start; i < data.length && i < start + 100000; i++) {
            if (data[i] === bracket) depth++;
            else if (data[i] === closeBracket) depth--;
            if (depth === 0) {
                end = i + 1;
                break;
            }
        }

        if (end === -1) continue;

        try {
            const parsed = JSON.parse(data.substring(start, end));
            parsedRanges.push([start, end]);
            walkJsonForArticles(parsed, articles, seenSlugs, baseUrl, basePath);
        } catch {
            // Not valid JSON from this position
        }
    }
}

/**
 * Recursively walk a parsed JSON value looking for article-like objects
 */
function walkJsonForArticles(value, articles, seenSlugs, baseUrl, basePath) {
    if (!value || typeof value !== 'object') return;

    if (Array.isArray(value)) {
        for (const item of value) {
            walkJsonForArticles(item, articles, seenSlugs, baseUrl, basePath);
        }
        return;
    }

    // Check if this object looks like an article (has title + slug)
    if (value.title && value.slug) {
        const slug = typeof value.slug === 'object' ? value.slug.current : value.slug;
        if (slug && !seenSlugs.has(slug)) {
            seenSlugs.add(slug);
            articles.push({
                title: value.title,
                slug,
                publishedOn: value.publishedOn || value.date || '',
                summary: value.summary || value.description || '',
                url: `${baseUrl}${basePath}/${slug}`
            });
        }
    }

    // Recurse into object values
    for (const val of Object.values(value)) {
        if (val && typeof val === 'object') {
            walkJsonForArticles(val, articles, seenSlugs, baseUrl, basePath);
        }
    }
}

/**
 * Import a single article from any URL
 * For Anthropic URLs: extracts metadata from RSC payloads
 * For other URLs: extracts <title> and <meta description> from HTML
 * @param {string} url - Article URL to import
 * @returns {Object} Article object ready for db.insertArticle()
 */
async function importArticleFromUrl(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    try {
        const response = await fetch(url, {
            headers: { 'User-Agent': USER_AGENT },
            signal: controller.signal
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const html = await response.text();
        const parsedUrl = new URL(url);
        const hostname = parsedUrl.hostname.replace(/^www\./, '');
        const source = hostname.split('.')[0].charAt(0).toUpperCase() + hostname.split('.')[0].slice(1);

        let title = '';
        let description = '';
        let publishedDate = new Date().toISOString();

        if (hostname.includes('anthropic.com')) {
            // Use RSC payload extraction for Anthropic pages
            const payloads = extractRSCPayloads(html);
            const combined = payloads.join('\n');

            // Try to find article metadata from RSC data
            const articleData = extractSingleArticleFromRSC(combined);
            if (articleData.title) title = articleData.title;
            if (articleData.summary) description = articleData.summary;
            if (articleData.publishedOn) publishedDate = articleData.publishedOn;
        }

        // Fallback to HTML meta tags
        if (!title) {
            const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
            if (titleMatch) {
                title = titleMatch[1].trim()
                    .replace(/\s*[|\-–—\\]\s*.*$/, ''); // Strip site name suffix
            }
        }

        if (!description) {
            const descMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i)
                || html.match(/<meta\s+content=["']([^"']+)["']\s+name=["']description["']/i);
            if (descMatch) {
                description = descMatch[1].trim();
            }
        }

        if (!title) {
            throw new Error('Could not extract article title from page');
        }

        const slug = getFetchRss().generateSlug(title);

        return {
            id: `import-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            title,
            originalUrl: url,
            source,
            sourceUrl: `${parsedUrl.protocol}//${parsedUrl.hostname}`,
            publishedDate,
            description,
            content: description,
            slug,
            status: 'pending',
            fetchedAt: new Date().toISOString(),
            translatedAt: null,
            publishedAt: null,
            translationProvider: null
        };
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Extract article metadata from RSC payload data for a single article page
 * @param {string} data - Combined RSC payload string
 * @returns {Object} { title, summary, publishedOn }
 */
function extractSingleArticleFromRSC(data) {
    const result = { title: '', summary: '', publishedOn: '' };

    // Known Anthropic article _type values
    const ARTICLE_TYPES = ['engineeringArticle', 'post', 'researchArticle'];

    // Strategy 1: Look for known article _type markers and extract fields
    // RSC data often has non-standard escapes preventing full JSON parsing,
    // but metadata fields appear as simple key-value pairs within the article object.
    // Sanity CMS uses alphabetical field ordering, so "body" (which can be 100K+)
    // comes before "publishedOn", "slug", "summary", "title". We use "publishedOn"
    // as a reliable anchor since it never appears in body content, then search
    // near it for "title" and "summary".
    for (const articleType of ARTICLE_TYPES) {
        const typeMarker = `"_type":"${articleType}"`;
        const idx = data.indexOf(typeMarker);
        if (idx === -1) continue;

        // Search the entire data after _type for publishedOn (reliable anchor)
        const afterType = data.substring(idx);
        const dateMatch = afterType.match(/"publishedOn"\s*:\s*"([^"]+)"/);
        if (dateMatch) {
            result.publishedOn = dateMatch[1];

            // publishedOn, slug, summary, title are clustered together
            // (all after the body array). Search near publishedOn for them.
            const datePos = afterType.indexOf(dateMatch[0]);
            const clusterStart = Math.max(0, datePos - 500);
            const clusterEnd = Math.min(afterType.length, datePos + 5000);
            const cluster = afterType.substring(clusterStart, clusterEnd);

            const summaryMatch = cluster.match(/"summary"\s*:\s*"([^"]+)"/);
            if (summaryMatch) result.summary = summaryMatch[1];

            // Find title near the cluster — skip palette swatch color values
            const titleRegex = /"title"\s*:\s*"([^"]+)"/g;
            let titleMatch;
            while ((titleMatch = titleRegex.exec(cluster)) !== null) {
                const val = titleMatch[1];
                if (/^#[0-9a-fA-F]{3,8}$/.test(val)) continue;
                if (val.length < 5) continue;
                result.title = val;
                break;
            }
        }

        // Fallback: if no publishedOn found, search a wider window for title/summary
        if (!result.title) {
            const searchEnd = Math.min(afterType.length, 50000);
            const window = afterType.substring(0, searchEnd);

            const summaryMatch = window.match(/"summary"\s*:\s*"([^"]+)"/);
            if (summaryMatch && !result.summary) result.summary = summaryMatch[1];

            const titleRegex = /"title"\s*:\s*"([^"]+)"/g;
            let titleMatch;
            while ((titleMatch = titleRegex.exec(window)) !== null) {
                const val = titleMatch[1];
                if (/^#[0-9a-fA-F]{3,8}$/.test(val)) continue;
                if (val.length < 5) continue;
                result.title = val;
                break;
            }
        }

        if (result.title) break;
    }

    // Strategy 2: Try parsing standalone JSON fragments
    if (!result.title) {
        const jsonStarts = [];
        for (let i = 0; i < data.length; i++) {
            if (data[i] === '{') jsonStarts.push(i);
        }

        for (const start of jsonStarts) {
            if (result.title) break;

            let depth = 0;
            let end = -1;
            for (let i = start; i < data.length && i < start + 100000; i++) {
                if (data[i] === '{') depth++;
                else if (data[i] === '}') depth--;
                if (depth === 0) { end = i + 1; break; }
            }
            if (end === -1) continue;

            try {
                const parsed = JSON.parse(data.substring(start, end));
                if (parsed.title && typeof parsed.title === 'string'
                    && parsed._type && ARTICLE_TYPES.includes(parsed._type)) {
                    result.title = parsed.title;
                    if (parsed.summary) result.summary = parsed.summary;
                    if (parsed.publishedOn) result.publishedOn = parsed.publishedOn;
                }
            } catch {}
        }
    }

    return result;
}

/**
 * Unescape a JSON string value (handles common escapes)
 */
function unescapeJsonString(str) {
    if (!str) return '';
    return str
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text) {
    if (!text) return '';
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

module.exports = {
    fetchWebFeed,
    fetchArticleContent,
    importArticleFromUrl,
    extractRSCPayloads,
    parseAnthropicArticles,
    extractArticlesFromJson,
    extractSingleArticleFromRSC,
    sanityBlocksToHtml,
    sanityBlocksToMarkdown,
    extractSanityBlocks,
    renderBlockChildren,
    escapeHtml
};
