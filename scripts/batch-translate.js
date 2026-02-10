/**
 * Batch translation script for NoMeta.az
 * Translates articles by URL, auto-splitting large articles.
 * Usage: node scripts/batch-translate.js <url1> <url2> ...
 */
const db = require('./db');
const { translate } = require('./translate');

const MAX_CHUNK = 18000; // Max chars per translation chunk

function cleanTranslation(text) {
    let c = text;
    // Remove preamble
    c = c.replace(/^Here(?:'s| is) the translat(?:ed article|ion):?\s*\n*/i, '');
    c = c.replace(/^I'll translate.*?\n+/i, '');
    c = c.replace(/^I need to.*?\n+/i, '');
    c = c.replace(/^Let me translate.*?\n+/i, '');
    // Remove --- separators at start/end
    c = c.replace(/^---\s*\n*/m, '');
    c = c.replace(/\n---\s*$/m, '');
    // Remove trailing notes about truncation
    const lastDash = c.lastIndexOf('\n---');
    if (lastDash !== -1 && c.length - lastDash < 300) {
        const after = c.substring(lastDash + 4).trim();
        if (after.includes('kəsilib') || after.includes('truncat') || after.includes('Qeyd') || after.length < 200) {
            c = c.substring(0, lastDash);
        }
    }
    return c.trim();
}

function extractTitle(text) {
    // Try **Title:** or **Başlıq:** pattern
    const m = text.match(/^\*{0,2}(?:Title|Başlıq)\s*:\s*\*{0,2}\s*(.+?)(?:\*{0,2})\s*$/m);
    if (m) {
        const title = m[1].trim().replace(/^\*+|\*+$/g, '').replace(/\s*\(\d+-[cı]i hissə\)/, '');
        const content = text.replace(m[0], '').trim();
        return { title, content };
    }
    // Try # Title at start
    const h = text.match(/^#\s+(.+)\n/);
    if (h) {
        return { title: h[1].trim(), content: text.replace(h[0], '').trim() };
    }
    return { title: '', content: text };
}

function findSplitPoint(content, targetPos) {
    // Find nearest heading boundary
    const headingRegex = /\n#{2,3} /g;
    let best = targetPos;
    let m;
    while ((m = headingRegex.exec(content)) !== null) {
        if (Math.abs(m.index - targetPos) < Math.abs(best - targetPos)) {
            best = m.index;
        }
    }
    // If no heading near target, split at paragraph boundary
    if (best === targetPos) {
        const para = content.lastIndexOf('\n\n', targetPos);
        if (para > targetPos * 0.5) best = para;
    }
    return best;
}

async function translateArticle(url) {
    const a = db.getArticleByUrl(url);
    if (!a) { console.error('NOT FOUND:', url); return false; }
    if (!a.content || a.content.length < 100) { console.error('NO CONTENT:', a.title); return false; }

    const content = a.content;
    const title = a.title;

    console.log(`Translating: ${title} (${content.length} chars)`);

    let translated;
    if (content.length <= MAX_CHUNK) {
        // Single chunk
        const raw = await translate(content, title, 'claude-cli');
        translated = cleanTranslation(raw);
    } else {
        // Split into chunks
        const chunks = [];
        let remaining = content;
        let partNum = 1;
        while (remaining.length > MAX_CHUNK) {
            const split = findSplitPoint(remaining, MAX_CHUNK);
            chunks.push(remaining.substring(0, split));
            remaining = remaining.substring(split);
            partNum++;
        }
        chunks.push(remaining);

        console.log(`  Split into ${chunks.length} parts: ${chunks.map(c => c.length).join(', ')}`);

        const parts = [];
        for (let i = 0; i < chunks.length; i++) {
            console.log(`  Translating part ${i + 1}/${chunks.length}...`);
            const raw = await translate(chunks[i], `${title} (Part ${i + 1})`, 'claude-cli');
            parts.push(cleanTranslation(raw));
        }
        translated = parts.join('\n\n');
    }

    // Remove Content: line
    translated = translated.replace(/^\*{0,2}Content:\*{0,2}\s*\n*/m, '').trim();

    // Extract title
    const { title: azTitle, content: azContent } = extractTitle(translated);

    db.updateArticle(a.id, {
        translatedTitle: azTitle || title,
        translatedContent: azContent || translated,
        translatedAt: new Date().toISOString(),
        translationProvider: 'claude-cli',
        status: 'translated'
    });

    console.log(`  Done: "${azTitle || title}" (${(azContent || translated).length} chars)`);
    return true;
}

(async () => {
    const urls = process.argv.slice(2);
    if (urls.length === 0) { console.error('Usage: node batch-translate.js <url1> <url2> ...'); process.exit(1); }

    let ok = 0, fail = 0;
    for (const url of urls) {
        try {
            const success = await translateArticle(url);
            if (success) ok++; else fail++;
        } catch (e) {
            console.error(`FAILED ${url}: ${e.message}`);
            fail++;
        }
    }
    console.log(`\nBatch done: ${ok} translated, ${fail} failed`);
})();
