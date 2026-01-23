/**
 * Lightweight Logger for NoMeta.az
 * Supports log levels, structured output, and CI/CD-friendly JSON format
 */

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const CURRENT_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL || 'info'];
const USE_JSON = process.env.CI || process.env.LOG_FORMAT === 'json';

/**
 * Format timestamp for logs
 */
function formatTimestamp() {
    return new Date().toISOString();
}

/**
 * Core logging function
 * @param {string} level - Log level (debug, info, warn, error)
 * @param {string} component - Component name (db, fetch, translate, generate, server)
 * @param {string} message - Log message
 * @param {Object} meta - Additional metadata
 */
function log(level, component, message, meta = {}) {
    if (LOG_LEVELS[level] < CURRENT_LEVEL) return;

    const entry = {
        ts: formatTimestamp(),
        level,
        component,
        msg: message,
        ...meta
    };

    // JSON format for CI/CD, human-readable for local dev
    if (USE_JSON) {
        const stream = level === 'error' ? process.stderr : process.stdout;
        stream.write(JSON.stringify(entry) + '\n');
    } else {
        const levelColors = {
            debug: '\x1b[36m', // cyan
            info: '\x1b[32m',  // green
            warn: '\x1b[33m',  // yellow
            error: '\x1b[31m'  // red
        };
        const reset = '\x1b[0m';
        const color = levelColors[level] || reset;

        const prefix = `${color}[${level.toUpperCase().padEnd(5)}]${reset} [${component}]`;

        // Format metadata (exclude stack for separate printing)
        const { stack, ...restMeta } = meta;
        const metaStr = Object.keys(restMeta).length
            ? ` ${JSON.stringify(restMeta)}`
            : '';

        const stream = level === 'error' ? console.error : console.log;
        stream(`${prefix} ${message}${metaStr}`);

        // Print stack trace on separate line for readability
        if (stack) {
            stream(`${color}${stack}${reset}`);
        }
    }
}

/**
 * Create a timer for measuring operation duration
 * @param {string} component - Component name
 * @param {string} operation - Operation being timed
 * @returns {Function} - Call to end timer and log duration
 */
function timer(component, operation) {
    const start = Date.now();
    return (meta = {}) => {
        const durationMs = Date.now() - start;
        log('info', component, `${operation} completed`, { durationMs, ...meta });
        return durationMs;
    };
}

module.exports = {
    debug: (component, msg, meta) => log('debug', component, msg, meta),
    info: (component, msg, meta) => log('info', component, msg, meta),
    warn: (component, msg, meta) => log('warn', component, msg, meta),
    error: (component, msg, meta) => log('error', component, msg, meta),
    timer,
    LOG_LEVELS
};
