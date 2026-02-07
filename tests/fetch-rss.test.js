import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { shouldFilterArticle } = require('../scripts/fetch-rss');

describe('shouldFilterArticle', () => {
    it('filters articles with promotional keywords in title', () => {
        const result = shouldFilterArticle({
            title: 'Announcing our new feature',
            content: 'x'.repeat(1100)
        });
        expect(result.filtered).toBe(true);
        expect(result.reason).toContain('new feature');
    });

    it('filters articles with promotional keywords in content', () => {
        const result = shouldFilterArticle({
            title: 'Update',
            content: 'Join our upcoming webinar about testing' + 'x'.repeat(1100)
        });
        expect(result.filtered).toBe(true);
        expect(result.reason).toContain('webinar');
    });

    it('filters articles with short content', () => {
        const result = shouldFilterArticle({
            title: 'Good Article',
            content: 'Too short'
        });
        expect(result.filtered).toBe(true);
        expect(result.reason).toContain('Content too short');
    });

    it('passes valid tech articles', () => {
        const result = shouldFilterArticle({
            title: 'How to Build Microservices',
            content: 'x'.repeat(1500)
        });
        expect(result.filtered).toBe(false);
    });

    it('handles missing title/content', () => {
        const result = shouldFilterArticle({});
        expect(result.filtered).toBe(true);
        expect(result.reason).toContain('Content too short');
    });

    it('filters release notes', () => {
        const result = shouldFilterArticle({
            title: 'Release notes for v15.0',
            content: 'x'.repeat(2000)
        });
        expect(result.filtered).toBe(true);
    });

    it('filters career/hiring posts', () => {
        const result = shouldFilterArticle({
            title: 'Join our team - We are hiring!',
            content: 'x'.repeat(2000)
        });
        expect(result.filtered).toBe(true);
    });

    it('is case-insensitive', () => {
        const result = shouldFilterArticle({
            title: 'ANNOUNCING New Release',
            content: 'x'.repeat(2000)
        });
        expect(result.filtered).toBe(true);
    });
});
