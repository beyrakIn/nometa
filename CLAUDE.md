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

# Image generation
node generate-images.js        # Generate favicon/OG images from SVG
```

No test framework configured.

## Environment Variables

```bash
# Translation providers (at least one required for translation)
ANTHROPIC_API_KEY              # Claude API key (preferred)
OPENAI_API_KEY                 # OpenAI API key (fallback)

# Server configuration
PORT=3000                      # Admin panel port (default: 3000)

# Logging
LOG_LEVEL=info                 # debug | info | warn | error
LOG_FORMAT=json                # Set for JSON output (auto-enabled in CI)
```

## Architecture

### Main Site
- `index.html` - Main educational page with Schema.org structured data
- `assets/css/styles.css` - All styling (dark mode, responsive, animations)

### Blog System (`scripts/`)
The blog system fetches articles from tech blogs, translates them to Azerbaijani, and generates static HTML.

**Pipeline**: RSS feeds → SQLite DB (`content/nometa.db`) → Translation → `news/` HTML

**Article statuses**: `pending` | `saved` | `translated` | `published` | `disabled`

- `scripts/fetch-rss.js` - Fetches articles from configured RSS feeds (managed via admin panel); filters promotional content
- `scripts/translate.js` - Multi-provider translation (Claude API, OpenAI, Claude CLI)
- `scripts/generate-blog.js` - Generates HTML pages, RSS feed, updates sitemap
- `scripts/server.js` - Express admin panel for managing articles
- `scripts/db.js` - SQLite database wrapper (better-sqlite3)
- `scripts/logger.js` - Structured logging with log levels and JSON output for CI

**Translation providers** (in order of preference):
1. `claude-api` - Requires `ANTHROPIC_API_KEY` (env var or Settings tab)
2. `openai` - Requires `OPENAI_API_KEY` (env var or Settings tab)
3. `claude-cli` - Uses local Claude Code CLI (no API key needed)

**Admin panel workflow**: Run `npm run admin`, open browser at http://localhost:3000. Use the UI to fetch articles, translate them, and publish. Publishing auto-generates HTML and pushes to GitHub (triggering deploy). API keys can be configured via the Settings tab (stored in SQLite) or environment variables.

### Content & Output Directories
- `content/nometa.db` - SQLite database (single source of truth for articles)
- `news/` - Generated blog HTML (index + individual articles)
- `templates/` - Blog HTML templates (`blog-index.html`, `blog-article.html`)
- `admin/` - Local-only admin panel (removed before deployment)

### CSS Design System
CSS custom properties: `--bg-color`, `--text-color`, `--bad-color` (#9a3a3a), `--good-color` (#2d7a4f)
Dark mode via `prefers-color-scheme` media query
Mobile breakpoint at 600px

### SEO & Structured Data
- Keep FAQ structured data in sync with HTML `<details>` elements
- Update `dateModified` timestamps in index.html (see comment at top for locations)
- Blog generation auto-updates sitemap.xml

## Key Conventions

1. **Cache busting**: Update version in CSS links: `styles.css?v=YYYYMMDDNN`. For blog pages, update the `CSS_VERSION` constant in `scripts/generate-blog.js:18`
2. **Accessibility**: Maintain ARIA labels, focus-visible patterns, reduced-motion support
3. **No frameworks**: Vanilla HTML/CSS/JS only
4. **robots.txt**: Blocks AI training bots (GPTBot, CCBot, Claude-Web, anthropic-ai)
