# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

NoMeta.az is an educational static website teaching developers to avoid "meta questions" in online chats (Discord, Telegram, Slack, forums). It demonstrates proper vs improper ways to ask questions through interactive chat comparisons.

- **Language**: Azerbaijani (English version at nometa.xyz)
- **Type**: Single-page static HTML/CSS site
- **Deployment**: GitHub Pages (automatic via GitHub Actions on push to main)

## Development Commands

```bash
# Generate favicon and OG images from SVG sources
node generate-images.js

# Local development - just open index.html in a browser
# No build step required
```

There is no test framework or linting configured. The project intentionally avoids build complexity.

## Architecture

### File Structure
- `index.html` - Single page with all content, semantic HTML5, extensive Schema.org structured data
- `assets/css/styles.css` - All styling including dark mode, responsive design, animations
- `assets/images/` - Favicons (SVG, PNG) and OG images
- `generate-images.js` - Node.js script using Sharp to convert SVG to PNG (outputs to assets/images/)

### CSS Design System
CSS custom properties define the theme:
- Colors: `--bg-color`, `--text-color`, `--bad-color` (#9a3a3a), `--good-color` (#2d7a4f)
- Shadows: `--shadow-sm`, `--shadow-md`, `--shadow-lg`
- Dark mode via `prefers-color-scheme` media query

Key component patterns:
- `.chat-scenario.bad-scenario` / `.chat-scenario.good-scenario` - comparison containers
- `.chat-bubble.good` / `.chat-bubble.bad` - message styling
- `.faq-item` with native `<details>` elements for accordion

### SEO & Structured Data
The HTML head contains extensive JSON-LD Schema.org markup (WebPage, FAQPage, Course, HowTo, etc.). When modifying content:
- Keep FAQ structured data in sync with HTML `<details>` elements
- Update meta tags when changing descriptions
- **Date updates**: When content changes, update `dateModified` in 6 locations and CSS cache buster in 2 locations (see HTML comment at top of `index.html` for exact line numbers)

## Key Conventions

1. **Cache busting**: When changing styles, update the version query param: `assets/css/styles.css?v=YYYYMMDDNN`
2. **Accessibility**: Maintain ARIA labels, focus-visible patterns, and reduced-motion support
3. **Responsive**: Mobile breakpoint at 600px; test at both mobile and desktop widths
4. **No frameworks**: Keep it vanilla HTML/CSS/JS - minimal JavaScript for dynamic year only
5. **robots.txt**: Currently allows all bots (`Allow: /`)
