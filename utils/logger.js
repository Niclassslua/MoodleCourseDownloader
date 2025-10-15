const fs = require('fs');
const path = require('path');

const logFile = path.join(__dirname, '../scraper.log');
const debugFolder = path.join(__dirname, '../debug_pages');

const LOG_FORMAT = process.env.MCD_LOG_FORMAT === 'structured' ? 'structured' : 'plain';
const UI_LOG_LEVEL = (process.env.MCD_UI_LOG_LEVEL || 'info').toLowerCase();

function silentLogsEnabled() {
    return process.env.MCD_SILENT_LOGS === '1';
}

const LEVELS = ['debug', 'info', 'success', 'warn', 'error'];
const LEVEL_PRIORITY = {
    debug: 10,
    info: 20,
    success: 25,
    warn: 30,
    error: 40,
};

const LEVEL_LABEL = {
    debug: 'DEBUG',
    info: 'INFO',
    success: 'OK',
    warn: 'WARN',
    error: 'ERROR',
};

const LEVEL_COLOR = {
    debug: '\x1b[36m',
    info: '\x1b[34m',
    success: '\x1b[32m',
    warn: '\x1b[33m',
    error: '\x1b[31m',
};

const RESET_COLOR = '\x1b[0m';

let uiLogThreshold = LEVEL_PRIORITY[UI_LOG_LEVEL] ?? LEVEL_PRIORITY.info;

fs.writeFileSync(logFile, '');
try {
    fs.rmSync(debugFolder, { recursive: true, force: true });
} catch (err) {
    if (err && err.code !== 'ENOENT') {
        throw err;
    }
}
if (!fs.existsSync(debugFolder)) {
    fs.mkdirSync(debugFolder, { recursive: true });
}

function normalizeLevel(level) {
    if (!level) {
        return 'debug';
    }
    const normalized = level.toString().toLowerCase();
    if (LEVELS.includes(normalized)) {
        return normalized;
    }
    return 'debug';
}

function getStreamForLevel(level) {
    return level === 'error' || level === 'warn' ? 'stderr' : 'stdout';
}

function shouldForwardToUi(level) {
    if (LOG_FORMAT !== 'structured') {
        return false;
    }
    const priority = LEVEL_PRIORITY[level] ?? LEVEL_PRIORITY.debug;
    return priority >= uiLogThreshold;
}

function sanitizeContext(rawContext = {}) {
    const context = { ...rawContext };
    delete context.level;
    if (context.additionalData && typeof context.additionalData !== 'object') {
        delete context.additionalData;
    }
    if (context.field && typeof context.field !== 'object') {
        delete context.field;
    }
    return context;
}

function formatScope(context = {}) {
    const parts = [];
    if (context.fileName) {
        parts.push(context.fileName);
    }
    if (context.functionName) {
        parts.push(context.functionName);
    }
    return parts.length > 0 ? ` [${parts.join(' › ')}]` : '';
}

function colorize(level, message) {
    const color = LEVEL_COLOR[level] || '';
    if (!color) {
        return message;
    }
    return `${color}${message}${RESET_COLOR}`;
}

function writeTerminal(level, message) {
    const colored = colorize(level, message);
    if (LOG_FORMAT === 'structured') {
        process.stderr.write(`${colored}\n`);
    } else {
        process.stdout.write(`${colored}\n`);
    }
}

function appendLogFile(entry) {
    try {
        fs.appendFileSync(logFile, `${entry}\n`);
    } catch (error) {
        process.stderr.write(`Failed to write log file: ${error.message}\n`);
    }
}

function emitStructured(payload) {
    if (LOG_FORMAT !== 'structured') {
        return;
    }
    try {
        process.stdout.write(`${JSON.stringify(payload)}\n`);
    } catch (error) {
        process.stderr.write(`Failed to emit structured log: ${error.message}\n`);
    }
}

function emitUiEvent(type, payload = {}) {
    if (LOG_FORMAT !== 'structured') {
        return;
    }
    const body = {
        type,
        time: new Date().toISOString(),
        ...payload,
    };
    emitStructured(body);
}

async function log(message, context = {}, driver = null) {
    const timestamp = new Date().toISOString();
    const level = normalizeLevel(context.level);
    const sanitizedContext = sanitizeContext(context);
    const scope = formatScope(sanitizedContext);
    const stream = getStreamForLevel(level);

    let currentUrl = null;
    if (driver) {
        try {
            currentUrl = await driver.getCurrentUrl();
        } catch (err) {
            currentUrl = null;
        }
    }

    const plainEntryParts = [timestamp, LEVEL_LABEL[level] || 'LOG'];
    if (scope) {
        plainEntryParts.push(scope.trim());
    }
    const plainEntry = `${plainEntryParts.join(' ')} - ${message}`;

    appendLogFile(plainEntry);

    if (silentLogsEnabled()) {
        return;
    }

    if (shouldForwardToUi(level)) {
        const uiPayload = {
            type: 'log',
            message,
            level,
            stream,
            time: timestamp,
        };
        if (Object.keys(sanitizedContext).length > 0) {
            uiPayload.context = sanitizedContext;
        }
        if (currentUrl) {
            uiPayload.url = currentUrl;
        }
        emitStructured(uiPayload);
    }

    const terminalParts = [`[${timestamp}]`, LEVEL_LABEL[level] || 'LOG'];
    if (scope) {
        terminalParts.push(scope);
    }
    const terminalMessage = `${terminalParts.join(' ')} ${message}`;
    writeTerminal(level, terminalMessage);
}

module.exports = { log, emitUiEvent };
