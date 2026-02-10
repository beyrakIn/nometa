import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const path = require('path');
const fs = require('fs');

let db;

describe('db module', () => {
    beforeAll(() => {
        db = require('../scripts/db');
    });

    afterAll(() => {
        try {
            db.closeDb();
        } catch {}
    });

    describe('database operations', () => {
        it('DB_PATH is defined', () => {
            expect(db.DB_PATH).toBeDefined();
            expect(db.DB_PATH).toContain('nometa.db');
        });

        it('initializes database successfully', () => {
            const result = db.initDb();
            expect(result).toBeDefined();
        });

        it('inserts and retrieves an article', () => {
            const article = {
                id: 'test-audit-1',
                title: 'Test Article',
                originalUrl: 'https://example.com/audit-test-1',
                source: 'AuditTest',
                sourceUrl: 'https://example.com',
                publishedDate: '2024-01-15T10:00:00Z',
                description: 'A test article',
                content: 'Full content here',
                slug: 'audit-test-article-' + Date.now(),
                status: 'pending',
                fetchedAt: new Date().toISOString(),
                translatedTitle: null,
                translatedContent: null,
                translatedAt: null,
                translationProvider: null,
                publishedAt: null
            };

            const inserted = db.insertArticle(article);
            expect(inserted).toBe(true);

            const retrieved = db.getArticleById('test-audit-1');
            expect(retrieved).toBeDefined();
            expect(retrieved.title).toBe('Test Article');
            expect(retrieved.source).toBe('AuditTest');
        });

        it('skips duplicate articles by URL', () => {
            const article = {
                id: 'test-audit-dup',
                title: 'Duplicate',
                originalUrl: 'https://example.com/audit-test-1',
                source: 'AuditTest',
                sourceUrl: 'https://example.com',
                publishedDate: '2024-01-15T10:00:00Z',
                description: 'Dup',
                content: 'Dup content',
                slug: 'audit-test-dup-' + Date.now(),
                status: 'pending',
                fetchedAt: new Date().toISOString()
            };

            const inserted = db.insertArticle(article);
            expect(inserted).toBe(false);
        });

        it('updates article fields', () => {
            const updated = db.updateArticle('test-audit-1', {
                status: 'translated',
                translatedTitle: 'Translated Title',
                translatedContent: 'Translated content'
            });
            expect(updated).toBeDefined();
            expect(updated.status).toBe('translated');
            expect(updated.title).toBe('Translated Title');
        });

        it('returns null when updating non-existent article', () => {
            const result = db.updateArticle('non-existent-audit', { status: 'published' });
            expect(result).toBeNull();
        });

        it('manages metadata key-value store', () => {
            db.setMetadata('audit_test_key', 'test_value');
            expect(db.getMetadata('audit_test_key')).toBe('test_value');

            db.setMetadata('audit_test_key', 'updated_value');
            expect(db.getMetadata('audit_test_key')).toBe('updated_value');
        });

        it('returns null for non-existent metadata', () => {
            expect(db.getMetadata('nonexistent_audit_key')).toBeNull();
        });

        it('5.2 fix: API key masking shows only last 4 chars', () => {
            db.setApiKey('audit-test-provider', 'sk-ant-api03-ABCDEF123456', true);

            const keys = db.getAllApiKeys(false);
            const testKey = keys.find(k => k.provider === 'audit-test-provider');
            expect(testKey).toBeDefined();
            expect(testKey.apiKey).toBe('****3456');
            expect(testKey.apiKey).not.toContain('sk-a');
            expect(testKey.apiKey).not.toContain('sk-ant');

            // Clean up
            db.deleteApiKey('audit-test-provider');
        });

        it('manages API key lifecycle', () => {
            db.setApiKey('audit-lifecycle', 'test-key-xyz', true);
            expect(db.getApiKey('audit-lifecycle')).toBe('test-key-xyz');

            db.toggleApiKey('audit-lifecycle', false);
            expect(db.getApiKey('audit-lifecycle')).toBeNull();

            db.toggleApiKey('audit-lifecycle', true);
            expect(db.getApiKey('audit-lifecycle')).toBe('test-key-xyz');

            expect(db.deleteApiKey('audit-lifecycle')).toBe(true);
            expect(db.deleteApiKey('audit-lifecycle')).toBe(false);
        });

        it('cleans up test article', () => {
            expect(db.deleteArticle('test-audit-1')).toBe(true);
            expect(db.getArticleById('test-audit-1')).toBeNull();
        });
    });

    describe('feed type support', () => {
        let testFeedId;

        it('inserts feed with type web', () => {
            const feed = db.insertFeed({
                name: 'Test Web Feed',
                url: 'https://example.com/web-test-' + Date.now(),
                sourceUrl: 'https://example.com',
                type: 'web'
            });
            expect(feed).toBeDefined();
            expect(feed.type).toBe('web');
            testFeedId = feed.id;
        });

        it('retrieves feed with correct type', () => {
            const feed = db.getFeedById(testFeedId);
            expect(feed).toBeDefined();
            expect(feed.type).toBe('web');
        });

        it('existing feeds default to type rss', () => {
            const feeds = db.getAllFeeds();
            const rssFeeds = feeds.filter(f => f.type === 'rss');
            expect(rssFeeds.length).toBeGreaterThan(0);
        });

        it('updates feed type', () => {
            const updated = db.updateFeed(testFeedId, { type: 'rss' });
            expect(updated.type).toBe('rss');
        });

        it('cleans up test feed', () => {
            expect(db.deleteFeed(testFeedId)).toBe(true);
        });
    });
});
