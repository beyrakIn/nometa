/**
 * NoMeta.az Admin Panel JavaScript
 * Handles article management, translation, and publishing
 */

const API_BASE = `${window.location.origin}/api`;

// State
let currentArticle = null;
let articles = [];
let translatedArticles = [];
let providers = [];
let confirmCallback = null;
let selectedArticles = new Set();
let translatingArticleId = null; // Track which article is being translated
let savedArticles = [];
let previewMode = 'raw'; // 'raw' or 'preview'

// DOM Elements
const articlesView = document.getElementById('articles-view');
const translatedView = document.getElementById('translated-view');
const settingsView = document.getElementById('settings-view');
const articlesList = document.getElementById('articles-list');
const translatedList = document.getElementById('translated-list');
const sourceFilter = document.getElementById('source-filter');
const statusFilter = document.getElementById('status-filter');
const modal = document.getElementById('article-modal');
const confirmDialog = document.getElementById('confirm-dialog');
const toastContainer = document.getElementById('toast-container');
const bulkActionsBar = document.getElementById('bulk-actions-bar');
const selectAllCheckbox = document.getElementById('select-all-checkbox');
const selectionCountEl = document.getElementById('selection-count');
const savedView = document.getElementById('saved-view');
const savedList = document.getElementById('saved-list');

/**
 * Safely parse JSON from a fetch response
 * Handles non-JSON responses (HTML error pages, timeouts, etc.)
 */
async function safeJsonParse(response) {
    const text = await response.text();

    // Check if response looks like HTML (error page from proxy/server)
    if (text.startsWith('<!') || text.startsWith('<html')) {
        throw new Error(`Server returned HTML error page (status: ${response.status})`);
    }

    // Empty response
    if (!text || text.trim() === '') {
        throw new Error('Server returned empty response');
    }

    // Try to parse JSON
    try {
        return JSON.parse(text);
    } catch (e) {
        // Show first 100 chars of response for debugging
        const preview = text.substring(0, 100);
        throw new Error(`Invalid JSON response: ${preview}...`);
    }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    initNavigation();
    loadArticles();
    loadTranslatedArticles();
    loadSavedArticles();
    loadProviders();
    loadStats();
    loadApiKeys();
    loadRSSFeeds();
    initModalHandlers();
    initConfirmDialog();
    initBulkActions();
    initKeyboardShortcuts();
    initApiKeyHandlers();
    initFeedHandlers();
    initPreviewToggle();
});

/**
 * Navigation handling
 */
function initNavigation() {
    const navBtns = document.querySelectorAll('.nav-btn');
    const views = document.querySelectorAll('.view');

    navBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const viewName = btn.dataset.view;

            navBtns.forEach(b => b.classList.remove('active'));
            views.forEach(v => v.classList.remove('active'));

            btn.classList.add('active');
            document.getElementById(`${viewName}-view`).classList.add('active');

            // Load saved articles when switching to saved tab
            if (viewName === 'saved') {
                loadSavedArticles();
            }
        });
    });

    // Fetch button
    document.getElementById('fetch-btn').addEventListener('click', fetchArticles);

    // Generate button
    document.getElementById('generate-btn').addEventListener('click', generateBlog);

    // Source filter
    sourceFilter.addEventListener('change', () => {
        renderArticles(filterArticles());
    });

    // Status filter
    statusFilter.addEventListener('change', () => {
        renderArticles(filterArticles());
    });
}

/**
 * Load stats from API
 */
async function loadStats() {
    try {
        const response = await fetch(`${API_BASE}/stats`);
        const stats = await response.json();

        document.getElementById('stat-total').textContent = stats.total || 0;
        document.getElementById('stat-pending').textContent = stats.pending || 0;
        document.getElementById('stat-saved').textContent = stats.saved || 0;
        document.getElementById('stat-translated').textContent = stats.translated || 0;
        document.getElementById('stat-published').textContent = stats.published || 0;
        document.getElementById('stat-disabled').textContent = stats.disabled || 0;
    } catch (error) {
        console.error('Failed to load stats:', error);
    }
}

/**
 * Load articles from API
 */
async function loadArticles() {
    try {
        articlesList.innerHTML = '<p class="loading">Loading articles...</p>';

        const response = await fetch(`${API_BASE}/articles`);
        const data = await response.json();

        articles = data.articles || [];
        populateSourceFilter(data.sources || []);
        renderArticles(filterArticles());
        loadStats();
    } catch (error) {
        articlesList.innerHTML = `<p class="loading">Error loading articles: ${error.message}</p>`;
        showToast('Failed to load articles', 'error');
    }
}

/**
 * Fetch new articles from RSS feeds
 */
async function fetchArticles() {
    const btn = document.getElementById('fetch-btn');
    btn.disabled = true;
    btn.textContent = 'Fetching...';

    try {
        const response = await fetch(`${API_BASE}/fetch`, { method: 'POST' });
        const data = await response.json();

        if (data.success) {
            showToast(`Fetched ${data.newArticles} new articles`, 'success');
            await loadArticles();
        } else {
            throw new Error(data.error || 'Failed to fetch');
        }
    } catch (error) {
        showToast(`Fetch failed: ${error.message}`, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Fetch New';
    }
}

/**
 * Load saved articles
 */
async function loadSavedArticles() {
    try {
        savedList.innerHTML = '<p class="loading">Loading saved articles...</p>';

        const response = await fetch(`${API_BASE}/articles`);
        const data = await response.json();

        // Filter only saved articles
        savedArticles = (data.articles || []).filter(a => a.status === 'saved');
        renderSavedArticles(savedArticles);
    } catch (error) {
        savedList.innerHTML = `<p class="loading">Error loading saved articles: ${error.message}</p>`;
    }
}

/**
 * Render saved articles list
 */
function renderSavedArticles(items) {
    if (!items.length) {
        savedList.innerHTML = '<div class="empty-state"><p>No saved articles.</p><p>Star articles you want to read later.</p></div>';
        return;
    }

    savedList.innerHTML = items.map(article => {
        const isTranslating = translatingArticleId === article.id;

        return `
        <div class="article-card saved" data-id="${article.id}">
            <div class="article-card-header">
                <div class="article-card-info" data-action="open">
                    <h3 class="article-card-title">${escapeHtml(article.title)}</h3>
                    <div class="article-card-meta">
                        <span>${article.source}</span>
                        <span>${formatDate(article.publishedDate)}</span>
                    </div>
                </div>
                <div class="article-card-actions">
                    <span class="article-card-status status-saved">saved</span>
                    <button class="btn btn-ghost btn-sm btn-translate ${isTranslating ? 'translating' : ''}"
                            data-action="translate"
                            title="Translate"
                            ${isTranslating ? 'disabled' : ''}>
                        ${isTranslating ? 'Translating...' : 'Translate'}
                    </button>
                    <button class="btn btn-ghost btn-icon btn-saved" data-action="unsave" title="Unsave">
                        ★
                    </button>
                    <button class="btn btn-ghost btn-icon btn-danger-ghost" data-action="delete" title="Delete">
                        &#128465;
                    </button>
                </div>
            </div>
            <p class="article-card-excerpt" data-action="open">${escapeHtml(article.description || '')}</p>
        </div>
    `}).join('');

    // Add click handlers
    savedList.querySelectorAll('.article-card').forEach(card => {
        const articleId = card.dataset.id;
        const article = savedArticles.find(a => a.id === articleId);

        // Open modal on card info click
        card.querySelectorAll('[data-action="open"]').forEach(el => {
            el.addEventListener('click', () => {
                if (article) openArticleModal(article);
            });
        });

        // Unsave button
        const unsaveBtn = card.querySelector('[data-action="unsave"]');
        if (unsaveBtn) {
            unsaveBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleSaveArticle(articleId).then(() => loadSavedArticles());
            });
        }

        // Translate button
        const translateBtn = card.querySelector('[data-action="translate"]');
        if (translateBtn) {
            translateBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                translateArticleFromCard(articleId);
            });
        }

        // Delete button
        const deleteBtn = card.querySelector('[data-action="delete"]');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                confirmDeleteArticle(articleId, article?.title);
            });
        }
    });
}

/**
 * Load translated articles
 */
async function loadTranslatedArticles() {
    try {
        translatedList.innerHTML = '<p class="loading">Loading translated articles...</p>';

        const response = await fetch(`${API_BASE}/translated`);
        translatedArticles = await response.json();

        renderTranslatedArticles(translatedArticles);
    } catch (error) {
        translatedList.innerHTML = `<p class="loading">Error: ${error.message}</p>`;
    }
}

/**
 * Load available translation providers
 */
async function loadProviders() {
    try {
        const response = await fetch(`${API_BASE}/providers`);
        providers = await response.json();

        renderProviders(providers);
        updateProviderSelects(providers);
    } catch (error) {
        console.error('Failed to load providers:', error);
    }
}

/**
 * Populate source filter dropdown
 */
function populateSourceFilter(sources) {
    sourceFilter.innerHTML = '<option value="">All Sources</option>';
    sources.forEach(source => {
        const option = document.createElement('option');
        option.value = source;
        option.textContent = source;
        sourceFilter.appendChild(option);
    });
}

/**
 * Filter articles by selected source and status
 */
function filterArticles() {
    const selectedSource = sourceFilter.value;
    const selectedStatus = statusFilter.value;

    return articles.filter(a => {
        const matchSource = !selectedSource || a.source === selectedSource;
        const matchStatus = !selectedStatus || a.status === selectedStatus;
        return matchSource && matchStatus;
    });
}

/**
 * Render articles list
 */
function renderArticles(items) {
    // Show/hide bulk actions bar
    bulkActionsBar.classList.toggle('hidden', items.length === 0);

    // Clear selection when re-rendering
    selectedArticles.clear();
    updateSelectionUI();

    if (!items.length) {
        articlesList.innerHTML = '<div class="empty-state"><p>No articles found.</p><p>Try changing filters or click "Fetch New" to get articles.</p></div>';
        return;
    }

    articlesList.innerHTML = items.map(article => {
        const isTranslating = translatingArticleId === article.id;
        const isSaved = article.status === 'saved';
        const isTranslated = article.status === 'translated';
        const isPublished = article.status === 'published';
        const canTranslate = article.status === 'pending' || article.status === 'saved';
        const hasTranslation = isTranslated || isPublished;

        // For translated articles, show translated title with original as subtitle
        const displayTitle = hasTranslation && article.translatedTitle ? article.translatedTitle : article.title;
        const originalTitle = hasTranslation && article.translatedTitle ? article.originalTitle : null;

        // Card classes
        const cardClasses = [
            'article-card',
            article.status === 'disabled' ? 'disabled' : '',
            isSaved ? 'saved' : '',
            hasTranslation ? 'has-translation' : ''
        ].filter(Boolean).join(' ');

        return `
        <div class="${cardClasses}" data-id="${article.id}">
            <div class="article-card-header">
                <div class="checkbox-wrapper" data-action="select">
                    <input type="checkbox" data-article-id="${article.id}" ${selectedArticles.has(article.id) ? 'checked' : ''}>
                </div>
                <div class="article-card-info" data-action="open">
                    <h3 class="article-card-title">${escapeHtml(displayTitle)}</h3>
                    ${originalTitle ? `<p class="article-card-original-title">${escapeHtml(originalTitle)}</p>` : ''}
                    <div class="article-card-meta">
                        <span>${article.source}</span>
                        <span>${formatDate(article.publishedDate)}</span>
                        ${hasTranslation ? `<span class="translation-badge">Translated</span>` : ''}
                    </div>
                </div>
                <div class="article-card-actions">
                    <span class="article-card-status status-${article.status}">${article.status}</span>
                    ${canTranslate ? `
                    <button class="btn btn-ghost btn-sm btn-translate ${isTranslating ? 'translating' : ''}"
                            data-action="translate"
                            title="Translate"
                            ${isTranslating ? 'disabled' : ''}>
                        ${isTranslating ? 'Translating...' : 'Translate'}
                    </button>
                    ` : ''}
                    ${isTranslated ? `
                    <button class="btn btn-ghost btn-sm btn-publish" data-action="publish" title="Publish">
                        Publish
                    </button>
                    ` : ''}
                    <button class="btn btn-ghost btn-icon ${isSaved ? 'btn-saved' : ''}" data-action="toggle-save" title="${isSaved ? 'Unsave' : 'Save'}">
                        ${isSaved ? '★' : '☆'}
                    </button>
                    <button class="btn btn-ghost btn-icon" data-action="toggle-disable" title="${article.status === 'disabled' ? 'Enable' : 'Disable'}">
                        ${article.status === 'disabled' ? '&#10003;' : '&#10005;'}
                    </button>
                    <button class="btn btn-ghost btn-icon btn-danger-ghost" data-action="delete" title="Delete">
                        &#128465;
                    </button>
                </div>
            </div>
            <p class="article-card-excerpt" data-action="open">${escapeHtml(article.description || '')}</p>
        </div>
    `}).join('');

    // Add click handlers
    articlesList.querySelectorAll('.article-card').forEach(card => {
        const articleId = card.dataset.id;
        const article = articles.find(a => a.id === articleId);

        // Checkbox selection
        const checkbox = card.querySelector('input[type="checkbox"]');
        if (checkbox) {
            checkbox.addEventListener('change', (e) => {
                e.stopPropagation();
                toggleArticleSelection(articleId, e.target.checked);
                card.classList.toggle('selected', e.target.checked);
            });
        }

        // Open modal on card info click
        card.querySelectorAll('[data-action="open"]').forEach(el => {
            el.addEventListener('click', () => {
                if (article) openArticleModal(article);
            });
        });

        // Toggle disable button
        const toggleBtn = card.querySelector('[data-action="toggle-disable"]');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleDisableArticle(articleId);
            });
        }

        // Toggle save button
        const saveBtn = card.querySelector('[data-action="toggle-save"]');
        if (saveBtn) {
            saveBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleSaveArticle(articleId);
            });
        }

        // Translate button (from card)
        const translateBtn = card.querySelector('[data-action="translate"]');
        if (translateBtn) {
            translateBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                translateArticleFromCard(articleId);
            });
        }

        // Publish button (from card)
        const publishBtn = card.querySelector('[data-action="publish"]');
        if (publishBtn) {
            publishBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                publishArticleFromCard(articleId);
            });
        }

        // Delete button
        const deleteBtn = card.querySelector('[data-action="delete"]');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                confirmDeleteArticle(articleId, article?.title);
            });
        }
    });
}

/**
 * Render translated articles list
 */
function renderTranslatedArticles(items) {
    if (!items.length) {
        translatedList.innerHTML = '<div class="empty-state"><p>No translated articles yet.</p></div>';
        return;
    }

    translatedList.innerHTML = items.map(article => `
        <div class="article-card" data-slug="${article.slug}" data-id="${article.id}">
            <div class="article-card-header">
                <div class="article-card-info" data-action="open">
                    <h3 class="article-card-title">${escapeHtml(article.title)}</h3>
                    <div class="article-card-meta">
                        <span>${article.source}</span>
                        <span>Translated: ${formatDate(article.translatedAt)}</span>
                    </div>
                </div>
                <div class="article-card-actions">
                    <span class="article-card-status status-${article.status}">${article.status}</span>
                    <button class="btn btn-ghost btn-icon btn-danger-ghost" data-action="delete" title="Delete">
                        &#128465;
                    </button>
                </div>
            </div>
            <p class="article-card-excerpt" data-action="open">${escapeHtml(article.description || '')}</p>
        </div>
    `).join('');

    // Add click handlers for translated articles
    translatedList.querySelectorAll('.article-card').forEach(card => {
        const slug = card.dataset.slug;
        const articleId = card.dataset.id;
        const article = translatedArticles.find(a => a.slug === slug);

        // Open modal
        card.querySelectorAll('[data-action="open"]').forEach(el => {
            el.addEventListener('click', () => {
                if (article) openTranslatedModal(article);
            });
        });

        // Delete button
        const deleteBtn = card.querySelector('[data-action="delete"]');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                confirmDeleteArticle(articleId, article?.title);
            });
        }
    });
}

/**
 * Render providers in settings
 */
function renderProviders(items) {
    const container = document.getElementById('providers-status');
    container.innerHTML = items.map(provider => `
        <div class="provider-item">
            <span>${provider.name}</span>
            <span class="provider-status ${provider.available ? 'available' : 'unavailable'}">
                ${provider.available ? 'Available' : 'Not configured'}
            </span>
        </div>
    `).join('');
}

/**
 * Load and render RSS feeds
 */
async function loadRSSFeeds() {
    const container = document.getElementById('feeds-list');
    try {
        const response = await fetch(`${API_BASE}/feeds`);
        const feeds = await response.json();

        if (feeds.length === 0) {
            container.innerHTML = '<p class="empty-state-small">No RSS feeds configured.</p>';
            return;
        }

        container.innerHTML = feeds.map(feed => `
            <div class="feed-item" data-id="${feed.id}">
                <div class="feed-info">
                    <span class="feed-name">${escapeHtml(feed.name)}</span>
                    <span class="feed-url">${escapeHtml(feed.url)}</span>
                    <span class="feed-status ${feed.enabled ? 'enabled' : 'disabled'}">${feed.enabled ? 'Enabled' : 'Disabled'}</span>
                </div>
                <div class="feed-actions">
                    <a href="${escapeHtml(feed.sourceUrl)}" target="_blank" class="btn btn-ghost btn-sm" title="Visit site">Visit</a>
                    <button class="btn btn-ghost btn-sm" data-action="edit" title="Edit">Edit</button>
                    <button class="btn btn-ghost btn-sm" data-action="toggle" title="${feed.enabled ? 'Disable' : 'Enable'}">
                        ${feed.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button class="btn btn-ghost btn-sm btn-danger-ghost" data-action="delete" title="Delete">Delete</button>
                </div>
            </div>
        `).join('');

        // Add event handlers
        container.querySelectorAll('.feed-item').forEach(item => {
            const feedId = parseInt(item.dataset.id);
            const feed = feeds.find(f => f.id === feedId);

            item.querySelector('[data-action="edit"]')?.addEventListener('click', () => {
                startEditFeed(feed);
            });

            item.querySelector('[data-action="toggle"]')?.addEventListener('click', () => {
                toggleFeedStatus(feedId, !feed.enabled);
            });

            item.querySelector('[data-action="delete"]')?.addEventListener('click', () => {
                confirmDeleteFeed(feedId, feed.name);
            });
        });
    } catch (error) {
        container.innerHTML = `<p class="error">Failed to load feeds: ${error.message}</p>`;
        console.error('Failed to load RSS feeds:', error);
    }
}

/**
 * Initialize feed form handlers
 */
function initFeedHandlers() {
    const saveBtn = document.getElementById('save-feed-btn');
    const cancelBtn = document.getElementById('cancel-feed-btn');

    if (saveBtn) {
        saveBtn.addEventListener('click', saveFeed);
    }

    if (cancelBtn) {
        cancelBtn.addEventListener('click', cancelEditFeed);
    }
}

/**
 * Save feed (add or update)
 */
async function saveFeed() {
    const editId = document.getElementById('feed-edit-id').value;
    const name = document.getElementById('feed-name').value.trim();
    const url = document.getElementById('feed-url').value.trim();
    const sourceUrl = document.getElementById('feed-source-url').value.trim();

    if (!name || !url || !sourceUrl) {
        showToast('Please fill in all fields', 'error');
        return;
    }

    // Validate URLs
    try {
        new URL(url);
        new URL(sourceUrl);
    } catch {
        showToast('Please enter valid URLs', 'error');
        return;
    }

    const btn = document.getElementById('save-feed-btn');
    btn.disabled = true;
    btn.textContent = editId ? 'Updating...' : 'Adding...';

    try {
        const method = editId ? 'PUT' : 'POST';
        const endpoint = editId ? `${API_BASE}/feeds/${editId}` : `${API_BASE}/feeds`;

        const response = await fetch(endpoint, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, url, sourceUrl })
        });

        const data = await response.json();

        if (data.success) {
            showToast(editId ? 'Feed updated!' : 'Feed added!', 'success');
            cancelEditFeed(); // Reset form
            await loadRSSFeeds();
        } else {
            throw new Error(data.error || 'Failed to save feed');
        }
    } catch (error) {
        showToast(`Failed: ${error.message}`, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = editId ? 'Update Feed' : 'Add Feed';
    }
}

/**
 * Start editing a feed
 */
function startEditFeed(feed) {
    document.getElementById('feed-edit-id').value = feed.id;
    document.getElementById('feed-name').value = feed.name;
    document.getElementById('feed-url').value = feed.url;
    document.getElementById('feed-source-url').value = feed.sourceUrl;

    document.getElementById('feed-form-title').textContent = 'Edit Feed';
    document.getElementById('save-feed-btn').textContent = 'Update Feed';
    document.getElementById('cancel-feed-btn').style.display = 'inline-flex';

    // Scroll to form
    document.getElementById('feed-form').scrollIntoView({ behavior: 'smooth' });
}

/**
 * Cancel feed editing
 */
function cancelEditFeed() {
    document.getElementById('feed-edit-id').value = '';
    document.getElementById('feed-name').value = '';
    document.getElementById('feed-url').value = '';
    document.getElementById('feed-source-url').value = '';

    document.getElementById('feed-form-title').textContent = 'Add New Feed';
    document.getElementById('save-feed-btn').textContent = 'Add Feed';
    document.getElementById('cancel-feed-btn').style.display = 'none';
}

/**
 * Toggle feed enabled status
 */
async function toggleFeedStatus(feedId, enabled) {
    try {
        const response = await fetch(`${API_BASE}/feeds/${feedId}/toggle`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled })
        });

        const data = await response.json();

        if (data.success) {
            showToast(data.message, 'success');
            await loadRSSFeeds();
        } else {
            throw new Error(data.error || 'Toggle failed');
        }
    } catch (error) {
        showToast(`Failed: ${error.message}`, 'error');
    }
}

/**
 * Confirm and delete feed
 */
function confirmDeleteFeed(feedId, feedName) {
    showConfirmDialog(
        'Delete Feed',
        `Are you sure you want to delete the feed "${feedName}"? This will not delete any previously fetched articles.`,
        () => deleteFeedById(feedId)
    );
}

/**
 * Delete feed
 */
async function deleteFeedById(feedId) {
    try {
        const response = await fetch(`${API_BASE}/feeds/${feedId}`, {
            method: 'DELETE'
        });

        const data = await response.json();

        if (data.success) {
            showToast('Feed deleted', 'success');
            await loadRSSFeeds();
        } else {
            throw new Error(data.error || 'Delete failed');
        }
    } catch (error) {
        showToast(`Failed to delete: ${error.message}`, 'error');
    }
}

/**
 * Load API keys from database
 */
async function loadApiKeys() {
    const container = document.getElementById('api-keys-list');
    try {
        const response = await fetch(`${API_BASE}/settings/api-keys`);
        const keys = await response.json();

        if (keys.length === 0) {
            container.innerHTML = '<p class="empty-state-small">No API keys configured. Add one below.</p>';
            return;
        }

        container.innerHTML = keys.map(key => `
            <div class="api-key-item" data-provider="${key.provider}">
                <div class="api-key-info">
                    <span class="api-key-provider">${getProviderDisplayName(key.provider)}</span>
                    <span class="api-key-value">${key.apiKey}</span>
                    <span class="api-key-status ${key.enabled ? 'enabled' : 'disabled'}">${key.enabled ? 'Enabled' : 'Disabled'}</span>
                </div>
                <div class="api-key-actions">
                    <button class="btn btn-ghost btn-sm" data-action="toggle" title="${key.enabled ? 'Disable' : 'Enable'}">
                        ${key.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button class="btn btn-ghost btn-sm btn-danger-ghost" data-action="delete" title="Delete">
                        Delete
                    </button>
                </div>
            </div>
        `).join('');

        // Add event handlers
        container.querySelectorAll('.api-key-item').forEach(item => {
            const provider = item.dataset.provider;

            item.querySelector('[data-action="toggle"]').addEventListener('click', () => {
                toggleApiKeyStatus(provider);
            });

            item.querySelector('[data-action="delete"]').addEventListener('click', () => {
                confirmDeleteApiKey(provider);
            });
        });
    } catch (error) {
        container.innerHTML = `<p class="error">Failed to load API keys: ${error.message}</p>`;
        console.error('Failed to load API keys:', error);
    }
}

/**
 * Get display name for provider
 */
function getProviderDisplayName(provider) {
    const names = {
        'claude-api': 'Claude API (Anthropic)',
        'openai': 'OpenAI',
        'claude-cli': 'Claude Code CLI'
    };
    return names[provider] || provider;
}

/**
 * Initialize API key form handlers
 */
function initApiKeyHandlers() {
    // Toggle password visibility
    const toggleBtn = document.getElementById('toggle-api-key-visibility');
    const apiKeyInput = document.getElementById('api-key-value');

    if (toggleBtn && apiKeyInput) {
        toggleBtn.addEventListener('click', () => {
            const isPassword = apiKeyInput.type === 'password';
            apiKeyInput.type = isPassword ? 'text' : 'password';
            toggleBtn.textContent = isPassword ? '🙈' : '👁';
        });
    }

    // Save API key
    const saveBtn = document.getElementById('save-api-key-btn');
    if (saveBtn) {
        saveBtn.addEventListener('click', saveApiKey);
    }
}

/**
 * Save API key
 */
async function saveApiKey() {
    const provider = document.getElementById('api-key-provider').value;
    const apiKey = document.getElementById('api-key-value').value.trim();

    if (!apiKey) {
        showToast('Please enter an API key', 'error');
        return;
    }

    const btn = document.getElementById('save-api-key-btn');
    btn.disabled = true;
    btn.textContent = 'Saving...';

    try {
        const response = await fetch(`${API_BASE}/settings/api-keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider, apiKey, enabled: true })
        });

        const data = await response.json();

        if (data.success) {
            showToast(`API key for ${getProviderDisplayName(provider)} saved!`, 'success');
            document.getElementById('api-key-value').value = '';
            await loadApiKeys();
            await loadProviders(); // Refresh provider status
        } else {
            throw new Error(data.error || 'Failed to save API key');
        }
    } catch (error) {
        showToast(`Failed to save: ${error.message}`, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Save API Key';
    }
}

/**
 * Toggle API key enabled status
 */
async function toggleApiKeyStatus(provider) {
    try {
        // Get current status
        const response = await fetch(`${API_BASE}/settings/api-keys`);
        const keys = await response.json();
        const key = keys.find(k => k.provider === provider);

        if (!key) {
            showToast('API key not found', 'error');
            return;
        }

        const newEnabled = !key.enabled;

        const toggleResponse = await fetch(`${API_BASE}/settings/api-keys/${provider}/toggle`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: newEnabled })
        });

        const data = await toggleResponse.json();

        if (data.success) {
            showToast(`${getProviderDisplayName(provider)} ${newEnabled ? 'enabled' : 'disabled'}`, 'success');
            await loadApiKeys();
            await loadProviders();
        } else {
            throw new Error(data.error || 'Toggle failed');
        }
    } catch (error) {
        showToast(`Failed: ${error.message}`, 'error');
    }
}

/**
 * Confirm and delete API key
 */
function confirmDeleteApiKey(provider) {
    showConfirmDialog(
        'Delete API Key',
        `Are you sure you want to delete the API key for ${getProviderDisplayName(provider)}?`,
        () => deleteApiKey(provider)
    );
}

/**
 * Delete API key
 */
async function deleteApiKey(provider) {
    try {
        const response = await fetch(`${API_BASE}/settings/api-keys/${provider}`, {
            method: 'DELETE'
        });

        const data = await response.json();

        if (data.success) {
            showToast(`API key for ${getProviderDisplayName(provider)} deleted`, 'success');
            await loadApiKeys();
            await loadProviders();
        } else {
            throw new Error(data.error || 'Delete failed');
        }
    } catch (error) {
        showToast(`Failed to delete: ${error.message}`, 'error');
    }
}

/**
 * Update provider select elements based on availability
 */
function updateProviderSelects(items) {
    const selects = document.querySelectorAll('#translate-provider, #default-provider');
    const availableProviders = items.filter(p => p.available);

    selects.forEach(select => {
        Array.from(select.options).forEach(option => {
            const provider = items.find(p => p.id === option.value);
            if (provider) {
                option.disabled = !provider.available;
                option.textContent = `${provider.name}${provider.available ? '' : ' (unavailable)'}`;
            }
        });

        // Select first available provider
        if (availableProviders.length > 0) {
            select.value = availableProviders[0].id;
        }
    });
}

/**
 * Confirm dialog handling
 */
function initConfirmDialog() {
    document.getElementById('confirm-cancel').addEventListener('click', () => {
        closeConfirmDialog();
    });

    document.getElementById('confirm-ok').addEventListener('click', () => {
        if (confirmCallback) {
            confirmCallback();
        }
        closeConfirmDialog();
    });

    confirmDialog.addEventListener('click', (e) => {
        if (e.target === confirmDialog) {
            closeConfirmDialog();
        }
    });
}

function showConfirmDialog(title, message, callback, isDanger = true) {
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').textContent = message;
    document.getElementById('confirm-ok').className = `btn ${isDanger ? 'btn-danger' : 'btn-primary'}`;
    confirmCallback = callback;
    confirmDialog.classList.add('active');
}

function closeConfirmDialog() {
    confirmDialog.classList.remove('active');
    confirmCallback = null;
}

/**
 * Delete article
 */
async function deleteArticle(articleId) {
    try {
        const response = await fetch(`${API_BASE}/articles/${articleId}`, {
            method: 'DELETE'
        });
        const data = await response.json();

        if (data.success) {
            showToast('Article deleted', 'success');
            closeModal();
            await loadArticles();
            await loadTranslatedArticles();
            await loadSavedArticles();
        } else {
            throw new Error(data.error || 'Delete failed');
        }
    } catch (error) {
        showToast(`Delete failed: ${error.message}`, 'error');
    }
}

function confirmDeleteArticle(articleId, title) {
    showConfirmDialog(
        'Delete Article',
        `Are you sure you want to delete "${title || 'this article'}"? This action cannot be undone.`,
        () => deleteArticle(articleId)
    );
}

/**
 * Toggle disable/enable article
 */
async function toggleDisableArticle(articleId) {
    try {
        const response = await fetch(`${API_BASE}/articles/${articleId}/toggle-disable`, {
            method: 'POST'
        });
        const data = await response.json();

        if (data.success) {
            showToast(data.message, 'success');
            await loadArticles();
        } else {
            throw new Error(data.error || 'Toggle failed');
        }
    } catch (error) {
        showToast(`Failed: ${error.message}`, 'error');
    }
}

/**
 * Toggle save/unsave article
 */
async function toggleSaveArticle(articleId) {
    try {
        const response = await fetch(`${API_BASE}/articles/${articleId}/toggle-save`, {
            method: 'POST'
        });
        const data = await response.json();

        if (data.success) {
            showToast(data.message, 'success');
            await loadArticles();
            await loadSavedArticles();
        } else {
            throw new Error(data.error || 'Save toggle failed');
        }
    } catch (error) {
        showToast(`Failed: ${error.message}`, 'error');
    }
}

/**
 * Translate article directly from card (not modal)
 */
async function translateArticleFromCard(articleId) {
    const article = articles.find(a => a.id === articleId);
    if (!article) return;

    // Find the specific card and button - update only that button, don't re-render everything
    const card = articlesList.querySelector(`.article-card[data-id="${articleId}"]`);
    const translateBtn = card?.querySelector('[data-action="translate"]');

    if (translateBtn) {
        translateBtn.disabled = true;
        translateBtn.classList.add('translating');
        translateBtn.textContent = 'Translating...';
    }

    // Track translating state (for re-renders)
    translatingArticleId = articleId;

    // Get default provider (first available)
    const defaultProvider = providers.find(p => p.available)?.id || 'claude-api';

    try {
        const response = await fetch(`${API_BASE}/translate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                articleId: articleId,
                provider: defaultProvider
            })
        });

        // Check HTTP status first
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Server error (${response.status}): ${errorText.substring(0, 100)}`);
        }

        const data = await safeJsonParse(response);

        if (data.success) {
            showToast('Translation complete!', 'success');
            // Refresh lists
            translatingArticleId = null;
            await loadArticles();
            await loadTranslatedArticles();
            await loadSavedArticles();
        } else {
            throw new Error(data.error || 'Translation failed');
        }
    } catch (error) {
        showToast(`Translation failed: ${error.message}`, 'error');
        // Reset button on error
        if (translateBtn) {
            translateBtn.disabled = false;
            translateBtn.classList.remove('translating');
            translateBtn.textContent = 'Translate';
        }
    } finally {
        translatingArticleId = null;
    }
}

/**
 * Publish article directly from card (not modal)
 */
async function publishArticleFromCard(articleId) {
    const article = articles.find(a => a.id === articleId);
    if (!article) return;

    const card = articlesList.querySelector(`.article-card[data-id="${articleId}"]`);
    const publishBtn = card?.querySelector('[data-action="publish"]');

    if (publishBtn) {
        publishBtn.disabled = true;
        publishBtn.textContent = 'Publishing...';
    }

    try {
        const response = await fetch(`${API_BASE}/publish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                articleId: articleId,
                slug: article.slug,
                autoPush: true
            })
        });

        const data = await response.json();

        if (data.success) {
            if (data.pushed) {
                showToast('Article published and pushed to GitHub!', 'success');
            } else {
                showToast(`Article published! ${data.pushMessage || ''}`, 'info');
            }
            await loadArticles();
            await loadTranslatedArticles();
            await loadSavedArticles();
        } else {
            throw new Error(data.error || 'Publish failed');
        }
    } catch (error) {
        showToast(`Publish failed: ${error.message}`, 'error');
        if (publishBtn) {
            publishBtn.disabled = false;
            publishBtn.textContent = 'Publish';
        }
    }
}

/**
 * Modal handlers
 */
function initModalHandlers() {
    // Close modal
    document.querySelector('.modal-close').addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });

    // Fetch full content button
    document.getElementById('fetch-content-btn').addEventListener('click', fetchFullContent);

    // Translate button
    document.getElementById('translate-btn').addEventListener('click', translateArticle);

    // Publish button
    document.getElementById('publish-btn').addEventListener('click', publishArticle);

    // Modal disable button
    document.getElementById('modal-disable-btn').addEventListener('click', () => {
        if (currentArticle) {
            toggleDisableArticle(currentArticle.id);
            closeModal();
        }
    });

    // Modal delete button
    document.getElementById('modal-delete-btn').addEventListener('click', () => {
        if (currentArticle) {
            confirmDeleteArticle(currentArticle.id, currentArticle.title);
        }
    });
}

/**
 * Fetch full article content from original URL
 */
async function fetchFullContent() {
    if (!currentArticle) return;

    const btn = document.getElementById('fetch-content-btn');
    btn.disabled = true;
    btn.textContent = 'Fetching...';

    try {
        const response = await fetch(`${API_BASE}/articles/${currentArticle.id}/fetch-content`, {
            method: 'POST'
        });
        const data = await response.json();

        if (data.success) {
            currentArticle = data.article;
            document.getElementById('modal-content').textContent = data.article.content;
            document.getElementById('content-length').textContent = `(${data.contentLength.toLocaleString()} chars)`;

            if (data.hasFullContent) {
                showToast('Full content fetched!', 'success');
                btn.textContent = 'Full Content Loaded';
                btn.classList.add('btn-success');
            } else {
                showToast('Could not fetch full content, using RSS excerpt', 'info');
                btn.textContent = 'Fetch Full Content';
            }

            // Refresh articles list
            await loadArticles();
        } else {
            throw new Error(data.error || 'Failed to fetch');
        }
    } catch (error) {
        showToast(`Failed: ${error.message}`, 'error');
        btn.textContent = 'Fetch Full Content';
    }

    btn.disabled = false;
}

/**
 * Open article modal for translation
 */
function openArticleModal(article) {
    currentArticle = article;

    document.getElementById('modal-title').textContent = article.title;
    document.getElementById('modal-source').textContent = article.source;
    document.getElementById('modal-date').textContent = formatDate(article.publishedDate);
    document.getElementById('modal-status').textContent = article.status;
    document.getElementById('modal-status').className = `article-card-status status-${article.status}`;
    document.getElementById('modal-content').textContent = article.content || article.description || '';
    document.getElementById('modal-original-link').href = article.originalUrl;

    // Show content length
    const contentLength = (article.content || '').length;
    document.getElementById('content-length').textContent = `(${contentLength.toLocaleString()} chars)`;

    // Reset fetch content button
    const fetchBtn = document.getElementById('fetch-content-btn');
    fetchBtn.disabled = false;
    fetchBtn.classList.remove('btn-success');
    if (article.hasFullContent) {
        fetchBtn.textContent = 'Full Content Loaded';
        fetchBtn.classList.add('btn-success');
    } else {
        fetchBtn.textContent = 'Fetch Full Content';
    }

    // Update disable button text
    const disableBtn = document.getElementById('modal-disable-btn');
    disableBtn.textContent = article.status === 'disabled' ? 'Enable' : 'Disable';

    // Reset translation panel and preview state
    resetPreviewState();
    document.getElementById('translated-content').textContent = '';
    document.getElementById('translation-status').className = 'translation-status';
    document.getElementById('translation-status').textContent = '';
    document.getElementById('publish-btn').disabled = true;

    // Show/hide translation panel based on status
    const translationPanel = document.getElementById('translation-panel');
    const translateOptions = document.querySelector('.translate-options');

    if (article.status === 'disabled') {
        translationPanel.style.display = 'none';
    } else if (article.status === 'translated' || article.status === 'published') {
        translationPanel.style.display = 'block';
        translateOptions.style.display = 'none';
        if (article.translatedContent) {
            document.getElementById('translated-content').textContent = article.translatedContent;
            document.getElementById('translation-status').className = 'translation-status success';
            document.getElementById('translation-status').textContent = `Translated with ${article.translationProvider || 'AI'}`;
            document.getElementById('publish-btn').disabled = article.status === 'published';
            showViewToggle();
        }
    } else {
        translationPanel.style.display = 'block';
        translateOptions.style.display = 'flex';
    }

    modal.classList.add('active');
}

/**
 * Open modal for already translated article
 */
function openTranslatedModal(article) {
    currentArticle = article;
    resetPreviewState();

    document.getElementById('modal-title').textContent = article.title;
    document.getElementById('modal-source').textContent = article.source;
    document.getElementById('modal-date').textContent = formatDate(article.publishedDate);
    document.getElementById('modal-status').textContent = article.status;
    document.getElementById('modal-status').className = `article-card-status status-${article.status}`;
    document.getElementById('modal-content').textContent = article.originalContent || article.content || '';
    document.getElementById('modal-original-link').href = article.originalUrl;

    // Update disable button text
    const disableBtn = document.getElementById('modal-disable-btn');
    disableBtn.textContent = article.status === 'disabled' ? 'Enable' : 'Disable';

    // Show translated content
    document.getElementById('translated-content').textContent = article.content || '';
    document.getElementById('translation-status').className = 'translation-status success';
    document.getElementById('translation-status').textContent = `Translated with ${article.translationProvider || 'AI'}`;
    showViewToggle();

    // Enable publish if not already published
    document.getElementById('publish-btn').disabled = article.status === 'published';

    // Hide translation options for already translated
    document.getElementById('translation-panel').style.display = 'block';
    document.querySelector('.translate-options').style.display =
        article.status === 'translated' ? 'none' : 'flex';

    modal.classList.add('active');
}

/**
 * Close modal
 */
function closeModal() {
    modal.classList.remove('active');
    currentArticle = null;
    resetPreviewState();
}

/**
 * Translate current article
 */
async function translateArticle() {
    if (!currentArticle) return;

    const btn = document.getElementById('translate-btn');
    const status = document.getElementById('translation-status');
    const provider = document.getElementById('translate-provider').value;

    btn.disabled = true;
    btn.textContent = 'Translating...';
    status.className = 'translation-status loading';
    status.textContent = 'Translating article... This may take a minute.';

    try {
        const response = await fetch(`${API_BASE}/translate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                articleId: currentArticle.id,
                provider: provider
            })
        });

        // Check HTTP status first
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Server error (${response.status}): ${errorText.substring(0, 100)}`);
        }

        const data = await safeJsonParse(response);

        if (data.success) {
            status.className = 'translation-status success';
            status.textContent = 'Translation complete!';
            document.getElementById('translated-content').textContent = data.translatedContent || '';
            document.getElementById('publish-btn').disabled = false;
            currentArticle = data.article;
            showToast('Translation complete!', 'success');
            showViewToggle();

            // Refresh lists
            await loadArticles();
            await loadTranslatedArticles();
            await loadSavedArticles();
        } else {
            throw new Error(data.error || 'Translation failed');
        }
    } catch (error) {
        status.className = 'translation-status error';
        status.textContent = `Error: ${error.message}`;
        showToast(`Translation failed: ${error.message}`, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Translate';
    }
}

/**
 * Publish current article
 */
async function publishArticle() {
    if (!currentArticle) return;

    const btn = document.getElementById('publish-btn');
    btn.disabled = true;
    btn.textContent = 'Publishing...';

    try {
        const response = await fetch(`${API_BASE}/publish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                articleId: currentArticle.id,
                slug: currentArticle.slug,
                autoPush: true
            })
        });

        const data = await response.json();

        if (data.success) {
            if (data.pushed) {
                showToast('Article published and pushed to GitHub!', 'success');
            } else {
                showToast(`Article published! Push: ${data.pushMessage}`, 'warning');
            }
            closeModal();
            await loadArticles();
            await loadTranslatedArticles();
        } else {
            throw new Error(data.error || 'Publish failed');
        }
    } catch (error) {
        showToast(`Publish failed: ${error.message}`, 'error');
        btn.disabled = false;
    }
    btn.textContent = 'Publish';
}

/**
 * Generate blog HTML
 */
async function generateBlog() {
    const btn = document.getElementById('generate-btn');
    btn.disabled = true;
    btn.textContent = 'Generating...';

    try {
        const response = await fetch(`${API_BASE}/generate`, { method: 'POST' });
        const data = await response.json();

        if (data.success) {
            showToast(`Generated ${data.articlesGenerated} article pages!`, 'success');
        } else {
            throw new Error(data.error || 'Generation failed');
        }
    } catch (error) {
        showToast(`Generation failed: ${error.message}`, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Generate Blog';
    }
}

/**
 * Initialize bulk actions
 */
function initBulkActions() {
    // Select all checkbox
    selectAllCheckbox.addEventListener('change', (e) => {
        const filteredArticles = filterArticles();
        if (e.target.checked) {
            filteredArticles.forEach(a => selectedArticles.add(a.id));
        } else {
            selectedArticles.clear();
        }
        updateSelectionUI();
        updateCardSelectionState();
    });

    // Bulk save button
    document.getElementById('bulk-save-btn').addEventListener('click', () => {
        if (selectedArticles.size === 0) return;
        bulkSaveArticles();
    });

    // Bulk disable button
    document.getElementById('bulk-disable-btn').addEventListener('click', () => {
        if (selectedArticles.size === 0) return;
        showConfirmDialog(
            'Disable Articles',
            `Are you sure you want to disable ${selectedArticles.size} article(s)?`,
            () => bulkDisableArticles(),
            false
        );
    });

    // Bulk enable button
    document.getElementById('bulk-enable-btn').addEventListener('click', () => {
        if (selectedArticles.size === 0) return;
        bulkEnableArticles();
    });

    // Bulk delete button
    document.getElementById('bulk-delete-btn').addEventListener('click', () => {
        if (selectedArticles.size === 0) return;
        showConfirmDialog(
            'Delete Articles',
            `Are you sure you want to delete ${selectedArticles.size} article(s)? This action cannot be undone.`,
            () => bulkDeleteArticles()
        );
    });
}

/**
 * Toggle article selection
 */
function toggleArticleSelection(articleId, isSelected) {
    if (isSelected) {
        selectedArticles.add(articleId);
    } else {
        selectedArticles.delete(articleId);
    }
    updateSelectionUI();
}

/**
 * Update selection UI (count and select all checkbox state)
 */
function updateSelectionUI() {
    const count = selectedArticles.size;
    selectionCountEl.textContent = `${count} selected`;

    // Update select all checkbox state
    const filteredArticles = filterArticles();
    const allSelected = filteredArticles.length > 0 && filteredArticles.every(a => selectedArticles.has(a.id));
    const someSelected = filteredArticles.some(a => selectedArticles.has(a.id));

    selectAllCheckbox.checked = allSelected;
    selectAllCheckbox.indeterminate = someSelected && !allSelected;

    // Enable/disable bulk action buttons
    const hasSelection = count > 0;
    document.getElementById('bulk-save-btn').disabled = !hasSelection;
    document.getElementById('bulk-disable-btn').disabled = !hasSelection;
    document.getElementById('bulk-enable-btn').disabled = !hasSelection;
    document.getElementById('bulk-delete-btn').disabled = !hasSelection;
}

/**
 * Update card visual selection state
 */
function updateCardSelectionState() {
    articlesList.querySelectorAll('.article-card').forEach(card => {
        const articleId = card.dataset.id;
        const checkbox = card.querySelector('input[type="checkbox"]');
        const isSelected = selectedArticles.has(articleId);

        card.classList.toggle('selected', isSelected);
        if (checkbox) {
            checkbox.checked = isSelected;
        }
    });
}

/**
 * Bulk disable articles
 */
async function bulkDisableArticles() {
    const ids = Array.from(selectedArticles);
    try {
        const response = await fetch(`${API_BASE}/articles/bulk-disable`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids })
        });
        const data = await response.json();

        if (data.success) {
            showToast(`Disabled ${data.disabled} article(s)`, 'success');
            selectedArticles.clear();
            await loadArticles();
        } else {
            throw new Error(data.error || 'Bulk disable failed');
        }
    } catch (error) {
        showToast(`Failed: ${error.message}`, 'error');
    }
}

/**
 * Bulk enable articles
 */
async function bulkEnableArticles() {
    const ids = Array.from(selectedArticles);
    let enabled = 0;

    try {
        for (const id of ids) {
            const article = articles.find(a => a.id === id);
            if (article && article.status === 'disabled') {
                const response = await fetch(`${API_BASE}/articles/${id}/toggle-disable`, {
                    method: 'POST'
                });
                const data = await response.json();
                if (data.success) enabled++;
            }
        }

        showToast(`Enabled ${enabled} article(s)`, 'success');
        selectedArticles.clear();
        await loadArticles();
    } catch (error) {
        showToast(`Failed: ${error.message}`, 'error');
    }
}

/**
 * Bulk delete articles
 */
async function bulkDeleteArticles() {
    const ids = Array.from(selectedArticles);
    try {
        const response = await fetch(`${API_BASE}/articles/bulk-delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids })
        });
        const data = await response.json();

        if (data.success) {
            showToast(`Deleted ${data.deleted} article(s)`, 'success');
            selectedArticles.clear();
            await loadArticles();
            await loadTranslatedArticles();
        } else {
            throw new Error(data.error || 'Bulk delete failed');
        }
    } catch (error) {
        showToast(`Failed: ${error.message}`, 'error');
    }
}

/**
 * Bulk save articles
 */
async function bulkSaveArticles() {
    const ids = Array.from(selectedArticles);
    let saved = 0;

    try {
        for (const id of ids) {
            const article = articles.find(a => a.id === id);
            if (article && article.status === 'pending') {
                const response = await fetch(`${API_BASE}/articles/${id}/toggle-save`, {
                    method: 'POST'
                });
                const data = await response.json();
                if (data.success) saved++;
            }
        }

        showToast(`Saved ${saved} article(s)`, 'success');
        selectedArticles.clear();
        await loadArticles();
    } catch (error) {
        showToast(`Failed: ${error.message}`, 'error');
    }
}

/**
 * Initialize keyboard shortcuts
 */
function initKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        // Don't trigger shortcuts when typing in inputs
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
            // Allow Escape in inputs
            if (e.key === 'Escape') {
                e.target.blur();
            }
            return;
        }

        const isModalOpen = modal.classList.contains('active');
        const isConfirmOpen = confirmDialog.classList.contains('active');
        const isShortcutsOpen = document.getElementById('shortcuts-modal')?.classList.contains('active');
        const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
        const ctrlKey = isMac ? e.metaKey : e.ctrlKey;

        // Close dialogs with Escape
        if (e.key === 'Escape') {
            if (isShortcutsOpen) {
                closeShortcutsModal();
                return;
            }
            if (isConfirmOpen) {
                closeConfirmDialog();
                return;
            }
            if (isModalOpen) {
                closeModal();
                return;
            }
            // Clear selection if nothing else to close
            if (selectedArticles.size > 0) {
                selectedArticles.clear();
                updateSelectionUI();
                updateCardSelectionState();
                showToast('Selection cleared', 'info');
            }
            return;
        }

        // Show shortcuts help with ?
        if (e.key === '?' || (e.shiftKey && e.key === '/')) {
            e.preventDefault();
            showShortcutsModal();
            return;
        }

        // Shortcuts when confirm dialog is open
        if (isConfirmOpen) {
            if (e.key === 'Enter') {
                e.preventDefault();
                document.getElementById('confirm-ok').click();
            }
            return;
        }

        // Shortcuts when modal is open
        if (isModalOpen) {
            switch (e.key.toLowerCase()) {
                case 't':
                    // Translate
                    const translateBtn = document.getElementById('translate-btn');
                    if (translateBtn && !translateBtn.disabled) {
                        e.preventDefault();
                        translateBtn.click();
                    }
                    break;
                case 'p':
                    // Publish
                    const publishBtn = document.getElementById('publish-btn');
                    if (publishBtn && !publishBtn.disabled) {
                        e.preventDefault();
                        publishBtn.click();
                    }
                    break;
                case 'd':
                    // Disable/Enable in modal
                    if (!ctrlKey) {
                        e.preventDefault();
                        document.getElementById('modal-disable-btn').click();
                    }
                    break;
                case 'm':
                    // Switch to markdown (raw) view
                    if (document.getElementById('view-toggle').style.display !== 'none') {
                        e.preventDefault();
                        switchViewMode('raw');
                    }
                    break;
                case 'v':
                    // Switch to preview view
                    if (document.getElementById('view-toggle').style.display !== 'none') {
                        e.preventDefault();
                        switchViewMode('preview');
                    }
                    break;
            }
            return;
        }

        // Global shortcuts (when no modal is open)
        switch (e.key) {
            // Tab navigation with number keys
            case '1':
                e.preventDefault();
                switchToView('articles');
                break;
            case '2':
                e.preventDefault();
                switchToView('saved');
                break;
            case '3':
                e.preventDefault();
                switchToView('translated');
                break;
            case '4':
                e.preventDefault();
                switchToView('settings');
                break;

            // Select all with Ctrl/Cmd + A
            case 'a':
            case 'A':
                if (ctrlKey) {
                    e.preventDefault();
                    const currentView = document.querySelector('.nav-btn.active')?.dataset.view;
                    if (currentView === 'articles') {
                        selectAllCheckbox.checked = true;
                        selectAllCheckbox.dispatchEvent(new Event('change'));
                    }
                }
                break;

            // Fetch with F
            case 'f':
            case 'F':
                if (!ctrlKey) {
                    e.preventDefault();
                    const fetchBtn = document.getElementById('fetch-btn');
                    if (fetchBtn && !fetchBtn.disabled) {
                        fetchBtn.click();
                    }
                }
                break;

            // Generate with G
            case 'g':
            case 'G':
                if (!ctrlKey) {
                    e.preventDefault();
                    const generateBtn = document.getElementById('generate-btn');
                    if (generateBtn && !generateBtn.disabled) {
                        generateBtn.click();
                    }
                }
                break;

            // Delete selected with Delete or Backspace
            case 'Delete':
            case 'Backspace':
                if (selectedArticles.size > 0) {
                    e.preventDefault();
                    document.getElementById('bulk-delete-btn').click();
                }
                break;

            // Disable selected with D
            case 'd':
            case 'D':
                if (!ctrlKey && selectedArticles.size > 0) {
                    e.preventDefault();
                    document.getElementById('bulk-disable-btn').click();
                }
                break;

            // Enable selected with E
            case 'e':
            case 'E':
                if (!ctrlKey && selectedArticles.size > 0) {
                    e.preventDefault();
                    document.getElementById('bulk-enable-btn').click();
                }
                break;

            // Save selected with S
            case 's':
            case 'S':
                if (!ctrlKey && selectedArticles.size > 0) {
                    e.preventDefault();
                    bulkSaveArticles();
                }
                break;

            // Deselect all with Ctrl/Cmd + D
            case 'd':
            case 'D':
                if (ctrlKey && selectedArticles.size > 0) {
                    e.preventDefault();
                    selectedArticles.clear();
                    updateSelectionUI();
                    updateCardSelectionState();
                    showToast('Selection cleared', 'info');
                }
                break;
        }
    });
}

/**
 * Switch to a specific view
 */
function switchToView(viewName) {
    const navBtns = document.querySelectorAll('.nav-btn');
    const views = document.querySelectorAll('.view');

    navBtns.forEach(b => b.classList.remove('active'));
    views.forEach(v => v.classList.remove('active'));

    const targetBtn = document.querySelector(`.nav-btn[data-view="${viewName}"]`);
    const targetView = document.getElementById(`${viewName}-view`);

    if (targetBtn && targetView) {
        targetBtn.classList.add('active');
        targetView.classList.add('active');
    }
}

/**
 * Show keyboard shortcuts modal
 */
function showShortcutsModal() {
    // Create modal if it doesn't exist
    let shortcutsModal = document.getElementById('shortcuts-modal');
    if (!shortcutsModal) {
        shortcutsModal = document.createElement('div');
        shortcutsModal.id = 'shortcuts-modal';
        shortcutsModal.className = 'modal';
        shortcutsModal.innerHTML = `
            <div class="modal-content shortcuts-modal-content">
                <button class="modal-close" onclick="closeShortcutsModal()">&times;</button>
                <div class="modal-header">
                    <h2>Keyboard Shortcuts</h2>
                </div>
                <div class="shortcuts-body">
                    <div class="shortcuts-section">
                        <h3>Navigation</h3>
                        <div class="shortcut-item"><kbd>1</kbd> <span>Articles tab</span></div>
                        <div class="shortcut-item"><kbd>2</kbd> <span>Saved tab</span></div>
                        <div class="shortcut-item"><kbd>3</kbd> <span>Translated tab</span></div>
                        <div class="shortcut-item"><kbd>4</kbd> <span>Settings tab</span></div>
                        <div class="shortcut-item"><kbd>Esc</kbd> <span>Close modal / Clear selection</span></div>
                        <div class="shortcut-item"><kbd>?</kbd> <span>Show this help</span></div>
                    </div>
                    <div class="shortcuts-section">
                        <h3>Actions</h3>
                        <div class="shortcut-item"><kbd>F</kbd> <span>Fetch new articles</span></div>
                        <div class="shortcut-item"><kbd>G</kbd> <span>Generate blog</span></div>
                    </div>
                    <div class="shortcuts-section">
                        <h3>Selection</h3>
                        <div class="shortcut-item"><kbd>Ctrl</kbd>+<kbd>A</kbd> <span>Select all</span></div>
                        <div class="shortcut-item"><kbd>Ctrl</kbd>+<kbd>D</kbd> <span>Deselect all</span></div>
                        <div class="shortcut-item"><kbd>S</kbd> <span>Save selected</span></div>
                        <div class="shortcut-item"><kbd>D</kbd> <span>Disable selected</span></div>
                        <div class="shortcut-item"><kbd>E</kbd> <span>Enable selected</span></div>
                        <div class="shortcut-item"><kbd>Delete</kbd> <span>Delete selected</span></div>
                    </div>
                    <div class="shortcuts-section">
                        <h3>In Article Modal</h3>
                        <div class="shortcut-item"><kbd>T</kbd> <span>Translate</span></div>
                        <div class="shortcut-item"><kbd>P</kbd> <span>Publish</span></div>
                        <div class="shortcut-item"><kbd>D</kbd> <span>Disable / Enable</span></div>
                        <div class="shortcut-item"><kbd>M</kbd> <span>Show markdown</span></div>
                        <div class="shortcut-item"><kbd>V</kbd> <span>Show preview</span></div>
                        <div class="shortcut-item"><kbd>Esc</kbd> <span>Close modal</span></div>
                    </div>
                    <div class="shortcuts-section">
                        <h3>In Confirm Dialog</h3>
                        <div class="shortcut-item"><kbd>Enter</kbd> <span>Confirm action</span></div>
                        <div class="shortcut-item"><kbd>Esc</kbd> <span>Cancel</span></div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(shortcutsModal);

        // Close on backdrop click
        shortcutsModal.addEventListener('click', (e) => {
            if (e.target === shortcutsModal) {
                closeShortcutsModal();
            }
        });
    }

    shortcutsModal.classList.add('active');
}

/**
 * Close keyboard shortcuts modal
 */
function closeShortcutsModal() {
    const shortcutsModal = document.getElementById('shortcuts-modal');
    if (shortcutsModal) {
        shortcutsModal.classList.remove('active');
    }
}

/**
 * Initialize preview toggle
 */
function initPreviewToggle() {
    const viewToggle = document.getElementById('view-toggle');
    const toggleBtns = viewToggle.querySelectorAll('.view-toggle-btn');

    toggleBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = btn.dataset.mode;
            switchViewMode(mode);
        });
    });
}

/**
 * Switch between raw markdown and preview mode
 */
function switchViewMode(mode) {
    if (mode === previewMode) return;

    previewMode = mode;

    const viewToggle = document.getElementById('view-toggle');
    const toggleBtns = viewToggle.querySelectorAll('.view-toggle-btn');
    const rawContent = document.getElementById('translated-content');
    const previewContent = document.getElementById('translated-preview');

    // Update button states
    toggleBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
    });

    if (mode === 'preview') {
        // Render markdown to HTML
        const markdown = rawContent.textContent;
        if (markdown && typeof marked !== 'undefined') {
            previewContent.innerHTML = marked.parse(markdown);
        }
        rawContent.style.display = 'none';
        previewContent.style.display = 'block';
    } else {
        rawContent.style.display = 'block';
        previewContent.style.display = 'none';
    }
}

/**
 * Reset preview state (called when opening/closing modal)
 */
function resetPreviewState() {
    previewMode = 'raw';

    const viewToggle = document.getElementById('view-toggle');
    const toggleBtns = viewToggle.querySelectorAll('.view-toggle-btn');
    const rawContent = document.getElementById('translated-content');
    const previewContent = document.getElementById('translated-preview');

    // Reset button states
    toggleBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === 'raw');
    });

    // Show raw, hide preview
    rawContent.style.display = 'block';
    previewContent.style.display = 'none';
    previewContent.innerHTML = '';

    // Hide toggle by default
    viewToggle.style.display = 'none';
}

/**
 * Show view toggle when there's translated content
 */
function showViewToggle() {
    const viewToggle = document.getElementById('view-toggle');
    viewToggle.style.display = 'flex';
}

/**
 * Show toast notification
 */
function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    toastContainer.appendChild(toast);

    setTimeout(() => {
        toast.remove();
    }, 4000);
}

/**
 * Format date for display
 */
function formatDate(dateString) {
    if (!dateString) return '';
    const date = new Date(dateString);
    return date.toLocaleDateString('az-AZ', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    });
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
