# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

NoMeta.az is an educational static website teaching developers to avoid "meta questions" in online chats (Discord, Telegram, Slack, forums). It also includes a news/blog section with translated tech articles.

- **Language**: Azerbaijani (English version at nometa.xyz)
- **Type**: Static HTML/CSS site with Node.js tooling for blog generation
- **Deployment**: GitHub Pages (automatic via GitHub Actions on push to main; `admin/`, `scripts/`, `templates/`, `content/` are excluded from deploy)

## Development Commands

```bash
npm install                    # Install dependencies

# Blog system
npm run admin                  # Start local admin panel (PORT=3000 by default)
npm run fetch                  # Fetch articles from RSS feeds
npm run translate              # Check available translation providers
npm run generate               # Generate blog HTML from translated articles
npm run build                  # Alias for generate

# Testing (Vitest)
npm test                       # Run all tests (vitest run)
npx vitest run tests/db.test.js          # Run a single test file
npx vitest run -t "test name"            # Run a specific test by name

# Image generation
node generate-images.js        # Generate favicon/OG images from SVG
```

## Testing

- **Framework**: Vitest 4.x with `vitest.config.mjs` (must be `.mjs`, not `.js`, because the project is CommonJS)
- **Test files**: `tests/` directory — `db.test.js`, `server.test.js`, `fetch-rss.test.js`, `fetch-web.test.js`, `generate-blog.test.js`
- **CJS/ESM bridge**: Test files use ESM `import` syntax with `createRequire(import.meta.url)` to require CommonJS source modules
- **Database tests**: Use the real SQLite database (`content/nometa.db`) — tests clean up after themselves
- **Globals**: Vitest globals are enabled (`describe`, `it`, `expect` available without import, though test files import them explicitly)

## Environment Variables

```bash
# Translation providers (at least one required for translation)
ANTHROPIC_API_KEY              # Claude API key (preferred)
OPENAI_API_KEY                 # OpenAI API key (fallback)

# Server configuration
PORT=3000                      # Admin panel port (default: 3000)

# Error monitoring
SENTRY_DSN                     # Sentry DSN for admin panel error tracking (optional)

# Logging
LOG_LEVEL=info                 # debug | info | warn | error
LOG_FORMAT=json                # Set for JSON output (auto-enabled in CI)
```

## Architecture

### Main Site
- `index.html` - Main educational page with Schema.org structured data (WebPage, Article, FAQPage)
- `assets/css/styles.css` - All styling (dark mode, responsive, animations)

### Blog System (`scripts/`)
The blog system fetches articles from tech blogs, translates them to Azerbaijani, and generates static HTML.

**Pipeline**: RSS feeds → SQLite DB (`content/nometa.db`) → Translation → `news/` HTML

**Article status lifecycle**: `pending` → `saved` → `translated` → `published` (or `disabled` at any point)

- `scripts/fetch-rss.js` - Fetches articles from configured RSS feeds (managed via admin panel); filters promotional content via keyword list (substring match, case-insensitive, first match wins); minimum content length 1000 chars; slug generation from title (80-char limit)
- `scripts/translate.js` - Multi-provider translation (Claude API, OpenAI, Claude CLI) with retry logic (3 retries, exponential backoff from 5s, 2-min API timeout)
- `scripts/generate-blog.js` - Generates HTML pages, RSS feed, updates sitemap, injects recent articles into homepage. Related articles prefer same-source (up to 3). Contextual links: max 3 per article, first occurrence only, longest phrase matched first.
- `scripts/server.js` - Express admin panel for managing articles; publishing auto-commits `news/` and `sitemap.xml` then pushes to GitHub; sends IndexNow notification after push (non-blocking)
- `scripts/db.js` - SQLite database wrapper (better-sqlite3, WAL mode); all queries use prepared statements; lazy-initialized singleton connection (`getDb()`/`initDb()`); auto-seeds default feeds on first init; `updateArticle()` only updates fields present in the data object (partial updates); `setMetadata()`/`setApiKey()` use upsert semantics
- `scripts/logger.js` - Structured logging: `logger.info('component', 'message', { meta })`

**Translation providers** (in order of preference):
1. `claude-api` - Uses `claude-sonnet-4-20250514`, requires `ANTHROPIC_API_KEY` (env var or Settings tab)
2. `openai` - Uses `gpt-4-turbo-preview`, requires `OPENAI_API_KEY` (env var or Settings tab)
3. `claude-cli` - Uses local Claude Code CLI (no API key needed, 10-min timeout)

API keys stored in the `api_keys` DB table take precedence over environment variables.

**Admin panel workflow**: Run `npm run admin`, open browser at http://localhost:3000. Use the UI to fetch articles, translate them, and publish. Publishing auto-generates HTML and pushes to GitHub (triggering deploy). API keys can be configured via the Settings tab (stored in SQLite) or environment variables.

### Database Schema (`content/nometa.db`)

Key tables:
- `articles` - Core data: `id`, `title`, `original_url`, `source`, `slug` (unique), `status`, `content`, `translated_title`, `translated_content`, `translation_provider`
- `rss_feeds` - Feed sources: `name`, `url` (unique), `source_url`, `enabled`, `type` (`'rss'` default or `'web'` for HTML scraping)
- `api_keys` - Provider credentials: `provider` (primary key), `api_key`, `enabled`
- `metadata` - Key-value store (e.g., `last_fetched` timestamp)

The `db.js` module converts snake_case DB columns to camelCase JS objects via `rowToArticle()`. Duplicate articles are rejected silently via `original_url` UNIQUE constraint.

### Templates
- `templates/blog-article.html` and `templates/blog-index.html` use `{{variableName}}` placeholders replaced by `generate-blog.js`
- Templates include full SEO markup: JSON-LD Schema.org, OpenGraph, Twitter Card, breadcrumbs
- Key generation helpers: `escapeForJson()` for JSON-LD safety, `removeDuplicateTitle()` to strip first h1 from content, `formatDate()` with Azerbaijani month names, `extractKeywords()` for meta tags

### Content & Output Directories
- `content/nometa.db` - SQLite database (single source of truth for articles); git-tracked despite `.gitignore` entry (was added before the rule)
- `news/` - Generated blog HTML (index + individual articles at `news/{slug}/index.html`)
- `news/feed.xml` - Auto-generated RSS feed (top 20 articles)
- `sitemap.xml` - Auto-generated sitemap (all published articles + main pages)
- `admin/` - Local-only admin panel (removed before deployment)

### CSS Design System
CSS custom properties: `--bg-color`, `--text-color`, `--bad-color` (#9a3a3a), `--good-color` (#2d7a4f)
Dark mode via `prefers-color-scheme` media query
Mobile breakpoint at 600px
Font: Inter, system-ui stack

## Key Conventions

1. **Cache busting**: Update version in CSS links: `styles.css?v=YYYYMMDDNN`. For blog pages, update the `CSS_VERSION` constant in `scripts/generate-blog.js:18`
2. **Homepage markers**: `index.html` contains `<!-- RECENT_ARTICLES_START -->` / `<!-- RECENT_ARTICLES_END -->` markers that `generate-blog.js` uses to inject the 3 most recent articles. Do not remove these comments.
3. **dateModified in index.html**: When main page content changes, update 8 locations total (see comment block at top of `index.html` for exact line numbers): 6 dates (`article:modified_time`, `og:updated_time`, two `itemprop="dateModified"` tags, two JSON-LD `dateModified` fields) + 2 CSS cache-buster versions on the preload and stylesheet links.
4. **FAQ structured data**: Keep JSON-LD FAQ schema in sync with HTML `<details>` elements in `index.html`
5. **Accessibility**: Maintain ARIA labels, focus-visible patterns, reduced-motion support
6. **No frameworks**: Vanilla HTML/CSS/JS only
7. **Security patterns**: Shell commands use `execFileSync()` (not `exec`) to prevent injection; DB uses prepared statements; API keys are masked in responses
8. **robots.txt**: Blocks AI training bots (GPTBot, CCBot, Claude-Web, anthropic-ai)
