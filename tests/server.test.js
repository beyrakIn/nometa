import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const fs = require('fs');
const path = require('path');

describe('server.js code fixes verification', () => {
    const serverCode = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'server.js'), 'utf-8');

    describe('2.1 — execSync removed', () => {
        it('does not use execSync calls', () => {
            const lines = serverCode.split('\n');
            for (const line of lines) {
                if (line.includes('execSync(') || line.includes('execSync (')) {
                    throw new Error(`Found execSync call: ${line.trim()}`);
                }
            }
        });

        it('imports only execFileSync', () => {
            expect(serverCode).toContain("const { execFileSync } = require('child_process')");
            expect(serverCode).not.toContain('execSync,');
        });

        it('uses execFileSync for git add', () => {
            expect(serverCode).toContain("execFileSync('git', ['add', 'news/', 'sitemap.xml']");
        });

        it('uses execFileSync for git status', () => {
            expect(serverCode).toContain("execFileSync('git', ['status', '--porcelain', 'news/', 'sitemap.xml']");
        });
    });

    describe('2.4 — DB init before app.listen', () => {
        it('calls db.initDb() before app.listen()', () => {
            const initIndex = serverCode.indexOf('db.initDb()');
            const listenIndex = serverCode.indexOf('app.listen(');
            expect(initIndex).toBeLessThan(listenIndex);
        });

        it('db.initDb is not inside listen callback', () => {
            const listenStart = serverCode.indexOf('app.listen(');
            const afterListen = serverCode.substring(listenStart);
            expect(afterListen).not.toContain('db.initDb()');
        });
    });

    describe('3.6 — Bulk operations validation', () => {
        it('bulk-delete validates array size limit', () => {
            expect(serverCode).toContain('ids.length > 500');
        });

        it('bulk-delete validates id types', () => {
            expect(serverCode).toContain("ids.every(id => typeof id === 'string')");
        });

        it('size limit appears in both bulk endpoints', () => {
            const matches = serverCode.match(/ids\.length > 500/g);
            expect(matches.length).toBe(2);
        });

        it('type validation appears in both bulk endpoints', () => {
            const matches = serverCode.match(/ids\.every\(id => typeof id === 'string'\)/g);
            expect(matches.length).toBe(2);
        });
    });

    describe('5.3 — Body size limit', () => {
        it('sets express.json limit', () => {
            expect(serverCode).toContain("express.json({ limit: '5mb' })");
        });
    });
});

describe('translate.js code fixes verification', () => {
    const translateCode = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'translate.js'), 'utf-8');

    describe('3.7 — which uses execFileSync', () => {
        it('uses execFileSync for which command', () => {
            expect(translateCode).toContain("execFileSync('which', ['claude']");
        });

        it('does not use execSync', () => {
            expect(translateCode).not.toContain('execSync');
        });

        it('imports execFileSync', () => {
            expect(translateCode).toContain('execFileSync');
        });
    });

    describe('2.3 — TRANSLATION_PROMPT not exported', () => {
        it('does not export TRANSLATION_PROMPT', () => {
            const exportsSection = translateCode.substring(translateCode.lastIndexOf('module.exports'));
            expect(exportsSection).not.toContain('TRANSLATION_PROMPT');
        });
    });
});

describe('fetch-rss.js code fixes verification', () => {
    const fetchCode = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'fetch-rss.js'), 'utf-8');

    describe('2.2 — Parallel feed fetching', () => {
        it('uses Promise.allSettled for parallel fetching', () => {
            expect(fetchCode).toContain('Promise.allSettled');
        });

        it('does not use sequential for-of await pattern', () => {
            // Should not have: for (const feed of feeds) { ... await fetchFeed(feed
            expect(fetchCode).not.toMatch(/for\s*\(const feed of feeds\)\s*\{[\s\S]*?await fetchFeed/);
        });
    });

    describe('2.3 — Unused exports removed', () => {
        it('does not export getArticlesByStatus', () => {
            const exportsSection = fetchCode.substring(fetchCode.lastIndexOf('module.exports'));
            expect(exportsSection).not.toContain('getArticlesByStatus');
        });

        it('does not export getArticlesBySource', () => {
            const exportsSection = fetchCode.substring(fetchCode.lastIndexOf('module.exports'));
            expect(exportsSection).not.toContain('getArticlesBySource');
        });

        it('does not define getArticlesByStatus', () => {
            expect(fetchCode).not.toContain('function getArticlesByStatus');
        });

        it('does not define getArticlesBySource', () => {
            expect(fetchCode).not.toContain('function getArticlesBySource');
        });
    });
});

describe('generate-blog.js code fixes verification', () => {
    const genCode = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'generate-blog.js'), 'utf-8');

    describe('2.5 — marked.setOptions at module scope', () => {
        it('calls setOptions before function definitions', () => {
            const setOptionsIndex = genCode.indexOf('marked.setOptions');
            const markdownToHtmlIndex = genCode.indexOf('function markdownToHtml');
            expect(setOptionsIndex).toBeLessThan(markdownToHtmlIndex);
        });

        it('markdownToHtml does not call setOptions', () => {
            const funcStart = genCode.indexOf('function markdownToHtml');
            const funcEnd = genCode.indexOf('}', genCode.indexOf('return marked.parse', funcStart));
            const funcBody = genCode.substring(funcStart, funcEnd);
            expect(funcBody).not.toContain('setOptions');
        });
    });

    describe('4.3 — Template caching', () => {
        it('defines templateCache', () => {
            expect(genCode).toContain('const templateCache = new Map()');
        });

        it('loadTemplate checks cache', () => {
            expect(genCode).toContain('templateCache.has(name)');
            expect(genCode).toContain('templateCache.get(name)');
            expect(genCode).toContain('templateCache.set(name,');
        });
    });
});

describe('db.js code fixes verification', () => {
    const dbCode = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'db.js'), 'utf-8');

    describe('5.2 — API key masking shows only last 4', () => {
        it('does not reveal first chars of key', () => {
            expect(dbCode).not.toContain('key.substring(0, 4)');
        });

        it('only shows last 4 chars with prefix mask', () => {
            expect(dbCode).toContain("'****' + key.substring(key.length - 4)");
        });
    });
});

describe('2.3 — Dead code cleanup', () => {
    it('migrate-to-sqlite.js is deleted', () => {
        const exists = fs.existsSync(path.join(__dirname, '..', 'scripts', 'migrate-to-sqlite.js'));
        expect(exists).toBe(false);
    });

    it('package.json main points to server.js', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
        expect(pkg.main).toBe('scripts/server.js');
    });

    it('package.json has vitest as devDependency', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
        expect(pkg.devDependencies.vitest).toBeDefined();
    });

    it('package.json test script runs vitest', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
        expect(pkg.scripts.test).toBe('vitest run');
    });
});
