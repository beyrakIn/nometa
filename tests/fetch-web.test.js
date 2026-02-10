import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const {
    extractRSCPayloads,
    parseAnthropicArticles,
    extractArticlesFromJson,
    extractSingleArticleFromRSC,
    sanityBlocksToHtml,
    renderBlockChildren,
    escapeHtml
} = require('../scripts/fetch-web');

describe('fetch-web module', () => {
    describe('extractRSCPayloads', () => {
        it('extracts payloads from self.__next_f.push calls', () => {
            const html = `
                <html><body>
                <script>self.__next_f.push([1,"hello world"])</script>
                <script>self.__next_f.push([1,"second payload"])</script>
                </body></html>
            `;
            const payloads = extractRSCPayloads(html);
            expect(payloads).toHaveLength(2);
            expect(payloads[0]).toBe('hello world');
            expect(payloads[1]).toBe('second payload');
        });

        it('unescapes double-encoded JSON strings', () => {
            const html = `<script>self.__next_f.push([1,"she said \\"hello\\" and \\n left"])</script>`;
            const payloads = extractRSCPayloads(html);
            expect(payloads).toHaveLength(1);
            expect(payloads[0]).toContain('"hello"');
            expect(payloads[0]).toContain('\n');
        });

        it('handles unicode escapes', () => {
            const html = `<script>self.__next_f.push([1,"caf\\u00e9"])</script>`;
            const payloads = extractRSCPayloads(html);
            expect(payloads[0]).toBe('caf\u00e9');
        });

        it('returns empty array for HTML without RSC payloads', () => {
            const html = '<html><body><p>No scripts here</p></body></html>';
            const payloads = extractRSCPayloads(html);
            expect(payloads).toHaveLength(0);
        });

        it('returns empty array for empty string', () => {
            expect(extractRSCPayloads('')).toHaveLength(0);
        });

        it('handles double-escaped RSC data (Anthropic-style)', () => {
            // Simulates what Anthropic pages produce: the HTML source has \\\"title\\\"
            // which after first regex capture gives us \"title\" (still escaped)
            // After first unescape: \"title\" -> needs second pass
            const html = `<script>self.__next_f.push([1,"{\\\\\\"title\\\\\\":\\\\\\"Building Agents\\\\\\"}"])</script>`;
            const payloads = extractRSCPayloads(html);
            expect(payloads).toHaveLength(1);
            // After full unescaping, quotes should be clean
            expect(payloads[0]).not.toContain('\\"');
        });

        it('handles double-escaped strings with backslash-quote patterns', () => {
            // Simpler test: input that after first unescape still has \"
            // In the HTML: \\"title\\" -> first unescape gives "title" (correct, single-escaped)
            // But \\\\\"title\\\\\" -> first unescape gives \\"title\\" -> second gives "title"
            const html = `<script>self.__next_f.push([1,"\\\\\\"hello\\\\\\""])</script>`;
            const payloads = extractRSCPayloads(html);
            expect(payloads).toHaveLength(1);
            expect(payloads[0]).toContain('"hello"');
        });
    });

    describe('parseAnthropicArticles', () => {
        it('extracts articles with title, slug, and publishedOn (title first pattern)', () => {
            const payloads = [
                `{"_type":"engineeringArticle","title":"Building Safe AI","slug":{"current":"building-safe-ai"},"publishedOn":"2025-03-15","summary":"How we build safe systems"}`
            ];
            const articles = parseAnthropicArticles(payloads, 'https://www.anthropic.com/engineering');
            expect(articles).toHaveLength(1);
            expect(articles[0].title).toBe('Building Safe AI');
            expect(articles[0].slug).toBe('building-safe-ai');
            expect(articles[0].publishedOn).toBe('2025-03-15');
            expect(articles[0].summary).toBe('How we build safe systems');
            expect(articles[0].url).toBe('https://www.anthropic.com/engineering/building-safe-ai');
        });

        it('extracts articles with slug before title', () => {
            const payloads = [
                `{"_type":"post","slug":{"current":"constitutional-ai"},"title":"Constitutional AI","publishedOn":"2025-01-10","summary":"Our approach to alignment"}`
            ];
            const articles = parseAnthropicArticles(payloads, 'https://www.anthropic.com/research');
            expect(articles).toHaveLength(1);
            expect(articles[0].title).toBe('Constitutional AI');
            expect(articles[0].url).toBe('https://www.anthropic.com/research/constitutional-ai');
        });

        it('deduplicates articles by slug', () => {
            const payloads = [
                `{"title":"Article One","slug":{"current":"article-one"},"publishedOn":"2025-01-01","summary":"First"}`,
                `{"title":"Article One Again","slug":{"current":"article-one"},"publishedOn":"2025-01-01","summary":"Dup"}`
            ];
            const articles = parseAnthropicArticles(payloads, 'https://www.anthropic.com/engineering');
            expect(articles).toHaveLength(1);
            expect(articles[0].title).toBe('Article One');
        });

        it('returns empty array for payloads without article data', () => {
            const payloads = ['just some random text with no article data'];
            const articles = parseAnthropicArticles(payloads, 'https://www.anthropic.com/engineering');
            expect(articles).toHaveLength(0);
        });

        it('returns empty array for empty payloads', () => {
            const articles = parseAnthropicArticles([], 'https://www.anthropic.com/engineering');
            expect(articles).toHaveLength(0);
        });

        it('handles multiple articles in combined payload', () => {
            const payloads = [
                `[{"title":"First Post","slug":{"current":"first-post"},"publishedOn":"2025-01-01","summary":"First"},` +
                `{"title":"Second Post","slug":{"current":"second-post"},"publishedOn":"2025-02-01","summary":"Second"}]`
            ];
            const articles = parseAnthropicArticles(payloads, 'https://www.anthropic.com/research');
            expect(articles.length).toBeGreaterThanOrEqual(2);
        });

        it('extracts articles from deeply nested JSON structures', () => {
            const payloads = [
                `{"data":{"items":[{"title":"Nested Article","slug":{"current":"nested-article"},"publishedOn":"2025-06-01","summary":"Found deep"}]}}`
            ];
            const articles = parseAnthropicArticles(payloads, 'https://www.anthropic.com/engineering');
            expect(articles).toHaveLength(1);
            expect(articles[0].title).toBe('Nested Article');
            expect(articles[0].slug).toBe('nested-article');
        });

        it('handles articles with slug as plain string (not object)', () => {
            const payloads = [
                `{"title":"Plain Slug","slug":"plain-slug","publishedOn":"2025-04-01"}`
            ];
            const articles = parseAnthropicArticles(payloads, 'https://www.anthropic.com/engineering');
            expect(articles).toHaveLength(1);
            expect(articles[0].slug).toBe('plain-slug');
        });
    });

    describe('extractArticlesFromJson', () => {
        it('finds articles in valid JSON fragments', () => {
            const data = `some text before {"title":"Test","slug":{"current":"test-slug"},"publishedOn":"2025-01-01"} some text after`;
            const articles = [];
            const seenSlugs = new Set();
            extractArticlesFromJson(data, articles, seenSlugs, 'https://www.anthropic.com', '/engineering');
            expect(articles).toHaveLength(1);
            expect(articles[0].title).toBe('Test');
        });

        it('finds articles in JSON arrays', () => {
            const data = `prefix [{"title":"A","slug":{"current":"a"}},{"title":"B","slug":{"current":"b"}}] suffix`;
            const articles = [];
            const seenSlugs = new Set();
            extractArticlesFromJson(data, articles, seenSlugs, 'https://www.anthropic.com', '/research');
            expect(articles).toHaveLength(2);
        });

        it('deduplicates by slug', () => {
            const data = `{"title":"Dup","slug":{"current":"dup"}} {"title":"Dup Again","slug":{"current":"dup"}}`;
            const articles = [];
            const seenSlugs = new Set();
            extractArticlesFromJson(data, articles, seenSlugs, 'https://www.anthropic.com', '/eng');
            expect(articles).toHaveLength(1);
        });

        it('handles data with no valid JSON', () => {
            const articles = [];
            const seenSlugs = new Set();
            extractArticlesFromJson('no json here at all', articles, seenSlugs, 'https://x.com', '/');
            expect(articles).toHaveLength(0);
        });
    });

    describe('extractSingleArticleFromRSC', () => {
        it('extracts article metadata from engineeringArticle type', () => {
            // Simulates RSC data with palette swatches before the article title
            const data = '"_type":"engineeringArticle","body":[...],"title":"#fff","title":"#000","publishedOn":"2026-02-05","summary":"We built a compiler","title":"Building a C compiler"';

            const result = extractSingleArticleFromRSC(data);
            expect(result.title).toBe('Building a C compiler');
            expect(result.title).not.toBe('#fff');
            expect(result.summary).toBe('We built a compiler');
            expect(result.publishedOn).toBe('2026-02-05');
        });

        it('extracts from post type', () => {
            const data = '"_type":"post","publishedOn":"2025-06-01","summary":"Research summary","title":"AI Research Paper"';
            const result = extractSingleArticleFromRSC(data);
            expect(result.title).toBe('AI Research Paper');
            expect(result.publishedOn).toBe('2025-06-01');
        });

        it('skips color values when searching for title', () => {
            const data = '"_type":"engineeringArticle","title":"#fff","title":"#abcdef","title":"Real Title Here","publishedOn":"2025-01-01"';
            const result = extractSingleArticleFromRSC(data);
            expect(result.title).toBe('Real Title Here');
        });

        it('returns empty strings when no article type found', () => {
            const data = '{"_type":"page","title":"Not Found","slug":{"current":"not-found"}}';
            const result = extractSingleArticleFromRSC(data);
            expect(result.title).toBe('');
        });

        it('handles fallback to JSON parsing for standalone objects', () => {
            const data = '{"_type":"engineeringArticle","title":"Standalone Article","publishedOn":"2025-03-01","summary":"A summary"}';
            const result = extractSingleArticleFromRSC(data);
            expect(result.title).toBe('Standalone Article');
            expect(result.summary).toBe('A summary');
        });
    });

    describe('sanityBlocksToHtml', () => {
        it('converts a normal paragraph block', () => {
            const blocks = [{
                _type: 'block',
                style: 'normal',
                children: [{ _type: 'span', text: 'Hello world', marks: [] }],
                markDefs: []
            }];
            const html = sanityBlocksToHtml(blocks);
            expect(html).toContain('<p>Hello world</p>');
        });

        it('converts heading blocks', () => {
            const blocks = [
                { _type: 'block', style: 'h2', children: [{ _type: 'span', text: 'Section Title', marks: [] }], markDefs: [] },
                { _type: 'block', style: 'h3', children: [{ _type: 'span', text: 'Subsection', marks: [] }], markDefs: [] },
                { _type: 'block', style: 'h4', children: [{ _type: 'span', text: 'Detail', marks: [] }], markDefs: [] }
            ];
            const html = sanityBlocksToHtml(blocks);
            expect(html).toContain('<h2>Section Title</h2>');
            expect(html).toContain('<h3>Subsection</h3>');
            expect(html).toContain('<h4>Detail</h4>');
        });

        it('converts code blocks', () => {
            const blocks = [{
                _type: 'code',
                language: 'python',
                code: 'print("hello")'
            }];
            const html = sanityBlocksToHtml(blocks);
            expect(html).toContain('<pre><code class="language-python">');
            expect(html).toContain('print(&quot;hello&quot;)');
        });

        it('converts bullet list items', () => {
            const blocks = [
                { _type: 'block', listItem: 'bullet', children: [{ _type: 'span', text: 'Item 1', marks: [] }], markDefs: [] },
                { _type: 'block', listItem: 'bullet', children: [{ _type: 'span', text: 'Item 2', marks: [] }], markDefs: [] }
            ];
            const html = sanityBlocksToHtml(blocks);
            expect(html).toContain('<ul>');
            expect(html).toContain('<li>Item 1</li>');
            expect(html).toContain('<li>Item 2</li>');
            expect(html).toContain('</ul>');
        });

        it('converts numbered list items', () => {
            const blocks = [
                { _type: 'block', listItem: 'number', children: [{ _type: 'span', text: 'Step 1', marks: [] }], markDefs: [] },
                { _type: 'block', listItem: 'number', children: [{ _type: 'span', text: 'Step 2', marks: [] }], markDefs: [] }
            ];
            const html = sanityBlocksToHtml(blocks);
            expect(html).toContain('<ol>');
            expect(html).toContain('<li>Step 1</li>');
            expect(html).toContain('</ol>');
        });

        it('applies bold and italic marks', () => {
            const blocks = [{
                _type: 'block',
                style: 'normal',
                children: [
                    { _type: 'span', text: 'bold text', marks: ['strong'] },
                    { _type: 'span', text: ' and ', marks: [] },
                    { _type: 'span', text: 'italic text', marks: ['em'] }
                ],
                markDefs: []
            }];
            const html = sanityBlocksToHtml(blocks);
            expect(html).toContain('<strong>bold text</strong>');
            expect(html).toContain('<em>italic text</em>');
        });

        it('applies inline code marks', () => {
            const blocks = [{
                _type: 'block',
                style: 'normal',
                children: [
                    { _type: 'span', text: 'Use ', marks: [] },
                    { _type: 'span', text: 'console.log()', marks: ['code'] }
                ],
                markDefs: []
            }];
            const html = sanityBlocksToHtml(blocks);
            expect(html).toContain('<code>console.log()</code>');
        });

        it('converts links via markDefs', () => {
            const blocks = [{
                _type: 'block',
                style: 'normal',
                children: [
                    { _type: 'span', text: 'click here', marks: ['link1'] }
                ],
                markDefs: [
                    { _key: 'link1', _type: 'link', href: 'https://example.com' }
                ]
            }];
            const html = sanityBlocksToHtml(blocks);
            expect(html).toContain('<a href="https://example.com">click here</a>');
        });

        it('converts blockquotes', () => {
            const blocks = [{
                _type: 'block',
                style: 'blockquote',
                children: [{ _type: 'span', text: 'A wise saying', marks: [] }],
                markDefs: []
            }];
            const html = sanityBlocksToHtml(blocks);
            expect(html).toContain('<blockquote>A wise saying</blockquote>');
        });

        it('closes list before non-list block', () => {
            const blocks = [
                { _type: 'block', listItem: 'bullet', children: [{ _type: 'span', text: 'Item', marks: [] }], markDefs: [] },
                { _type: 'block', style: 'normal', children: [{ _type: 'span', text: 'Paragraph', marks: [] }], markDefs: [] }
            ];
            const html = sanityBlocksToHtml(blocks);
            const ulClose = html.indexOf('</ul>');
            const pOpen = html.indexOf('<p>Paragraph</p>');
            expect(ulClose).toBeLessThan(pOpen);
        });

        it('returns empty string for empty blocks', () => {
            expect(sanityBlocksToHtml([])).toBe('');
            expect(sanityBlocksToHtml(null)).toBe('');
        });

        it('skips blocks without content', () => {
            const blocks = [
                { _type: 'block', style: 'normal', children: [{ _type: 'span', text: '', marks: [] }], markDefs: [] },
                { _type: 'block', style: 'normal', children: [{ _type: 'span', text: 'Has content', marks: [] }], markDefs: [] }
            ];
            const html = sanityBlocksToHtml(blocks);
            expect(html).not.toContain('<p></p>');
            expect(html).toContain('<p>Has content</p>');
        });
    });

    describe('escapeHtml', () => {
        it('escapes HTML special characters', () => {
            expect(escapeHtml('<script>alert("xss")</script>')).toBe(
                '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
            );
        });

        it('escapes ampersands', () => {
            expect(escapeHtml('foo & bar')).toBe('foo &amp; bar');
        });

        it('returns empty string for null/undefined', () => {
            expect(escapeHtml(null)).toBe('');
            expect(escapeHtml(undefined)).toBe('');
            expect(escapeHtml('')).toBe('');
        });
    });

    describe('renderBlockChildren', () => {
        it('renders children with mixed marks', () => {
            const block = {
                children: [
                    { _type: 'span', text: 'Hello ', marks: [] },
                    { _type: 'span', text: 'bold', marks: ['strong'] },
                    { _type: 'span', text: ' world', marks: [] }
                ],
                markDefs: []
            };
            const result = renderBlockChildren(block);
            expect(result).toBe('Hello <strong>bold</strong> world');
        });

        it('returns empty string for block without children', () => {
            expect(renderBlockChildren({})).toBe('');
            expect(renderBlockChildren({ children: null })).toBe('');
        });
    });
});
