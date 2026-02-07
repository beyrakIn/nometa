import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const {
    formatDate,
    formatDateISO,
    renderTemplate,
    markdownToHtml,
    escapeForJson,
    extractPlainText,
    extractKeywords,
    truncateTitle,
    removeDuplicateTitle,
    calculateReadingTime
} = require('../scripts/generate-blog');

describe('formatDate', () => {
    it('formats date in Azerbaijani', () => {
        expect(formatDate('2024-01-15')).toBe('15 Yanvar 2024');
        expect(formatDate('2024-06-01')).toBe('1 İyun 2024');
        expect(formatDate('2024-12-25')).toBe('25 Dekabr 2024');
    });

    it('handles all months', () => {
        const months = [
            'Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'İyun',
            'İyul', 'Avqust', 'Sentyabr', 'Oktyabr', 'Noyabr', 'Dekabr'
        ];
        for (let i = 0; i < 12; i++) {
            const date = `2024-${String(i + 1).padStart(2, '0')}-10`;
            expect(formatDate(date)).toContain(months[i]);
        }
    });
});

describe('formatDateISO', () => {
    it('returns ISO date string (YYYY-MM-DD)', () => {
        expect(formatDateISO('2024-03-15T10:30:00Z')).toBe('2024-03-15');
    });
});

describe('renderTemplate', () => {
    it('replaces simple variables', () => {
        const template = '<h1>{{title}}</h1><p>{{body}}</p>';
        const result = renderTemplate(template, { title: 'Hello', body: 'World' });
        expect(result).toBe('<h1>Hello</h1><p>World</p>');
    });

    it('replaces multiple occurrences of same variable', () => {
        const template = '{{name}} says hi to {{name}}';
        const result = renderTemplate(template, { name: 'Alice' });
        expect(result).toBe('Alice says hi to Alice');
    });

    it('leaves unreferenced placeholders intact', () => {
        const template = '{{title}} - {{missing}}';
        const result = renderTemplate(template, { title: 'Test' });
        expect(result).toBe('Test - {{missing}}');
    });

    it('handles null/undefined values', () => {
        const template = '{{a}}|{{b}}';
        const result = renderTemplate(template, { a: null, b: undefined });
        expect(result).toBe('|');
    });
});

describe('markdownToHtml', () => {
    it('converts markdown headings', () => {
        const result = markdownToHtml('# Hello');
        expect(result).toContain('<h1');
        expect(result).toContain('Hello');
    });

    it('converts markdown lists', () => {
        const result = markdownToHtml('- item 1\n- item 2');
        expect(result).toContain('<ul>');
        expect(result).toContain('<li>');
    });

    it('converts code blocks', () => {
        const result = markdownToHtml('```js\nconst x = 1;\n```');
        expect(result).toContain('<code');
    });
});

describe('escapeForJson', () => {
    it('escapes double quotes', () => {
        expect(escapeForJson('say "hello"')).toBe('say \\"hello\\"');
    });

    it('escapes backslashes', () => {
        expect(escapeForJson('path\\to\\file')).toBe('path\\\\to\\\\file');
    });

    it('replaces newlines and tabs', () => {
        expect(escapeForJson('line1\nline2\ttab')).toBe('line1 line2 tab');
    });

    it('replaces smart/curly quotes', () => {
        expect(escapeForJson('\u201CHello\u201D')).toBe('\\"Hello\\"');
    });

    it('collapses multiple spaces', () => {
        expect(escapeForJson('too   many   spaces')).toBe('too many spaces');
    });

    it('handles empty/null input', () => {
        expect(escapeForJson('')).toBe('');
        expect(escapeForJson(null)).toBe('');
        expect(escapeForJson(undefined)).toBe('');
    });
});

describe('extractPlainText', () => {
    it('strips HTML tags', () => {
        expect(extractPlainText('<p>Hello <strong>world</strong></p>')).toBe('Hello world');
    });

    it('strips markdown symbols', () => {
        expect(extractPlainText('## Hello **world**')).toBe('Hello world');
    });

    it('truncates at maxLength', () => {
        const longText = 'word '.repeat(200);
        const result = extractPlainText(longText, 50);
        expect(result.length).toBeLessThanOrEqual(54);
        expect(result).toContain('...');
    });

    it('removes translation artifact prefixes', () => {
        expect(extractPlainText('Başlıq: Some Title Here')).toBe('Some Title Here');
        expect(extractPlainText('Content: Some content')).toBe('Some content');
    });

    it('returns full text if under maxLength', () => {
        expect(extractPlainText('Short text', 500)).toBe('Short text');
    });
});

describe('extractKeywords', () => {
    it('includes source in keywords', () => {
        const result = extractKeywords('Test', 'GitLab', 'some content');
        expect(result).toContain('GitLab');
    });

    it('finds tech keywords in content', () => {
        const result = extractKeywords('API Guide', 'Blog', 'Using JavaScript and Docker for deployment');
        expect(result).toContain('API');
        expect(result).toContain('JavaScript');
        expect(result).toContain('Docker');
    });

    it('limits to 5 found keywords plus source', () => {
        const content = 'JavaScript Python React Node.js Docker Kubernetes AWS Cloud DevOps';
        const result = extractKeywords('All tech', 'Source', content);
        const parts = result.split(', ');
        expect(parts.length).toBeLessThanOrEqual(6);
    });
});

describe('truncateTitle', () => {
    it('returns short titles unchanged', () => {
        expect(truncateTitle('Short', 50)).toBe('Short');
    });

    it('truncates long titles at word boundary', () => {
        const long = 'This is a very long title that should be truncated at some point';
        const result = truncateTitle(long, 30);
        expect(result.length).toBeLessThanOrEqual(34);
        expect(result).toContain('...');
    });

    it('uses default maxLength of 50', () => {
        const title = 'A'.repeat(60);
        const result = truncateTitle(title);
        expect(result).toContain('...');
    });
});

describe('removeDuplicateTitle', () => {
    it('removes first h1 tag', () => {
        const html = '<h1>Title</h1>\n<p>Content</p>';
        expect(removeDuplicateTitle(html)).toBe('<p>Content</p>');
    });

    it('only removes first h1', () => {
        const html = '<h1>First</h1>\n<h1>Second</h1>';
        const result = removeDuplicateTitle(html);
        expect(result).not.toContain('First');
        expect(result).toContain('Second');
    });

    it('leaves content without h1 unchanged', () => {
        const html = '<h2>Subtitle</h2><p>Text</p>';
        expect(removeDuplicateTitle(html)).toBe(html);
    });
});

describe('calculateReadingTime', () => {
    it('calculates reading time based on word count', () => {
        const text = 'word '.repeat(400);
        const { wordCount, readingTime } = calculateReadingTime(text);
        expect(wordCount).toBe(400);
        expect(readingTime).toBe(2);
    });

    it('returns minimum 1 minute', () => {
        const { readingTime } = calculateReadingTime('short');
        expect(readingTime).toBe(1);
    });

    it('strips HTML before counting', () => {
        const text = '<p>one</p> <strong>two</strong> <em>three</em>';
        const { wordCount } = calculateReadingTime(text);
        expect(wordCount).toBe(3);
    });
});
