const fs = require('fs');
const path = require('path');

const logFile = path.join(__dirname, '../scraper.log');
const debugFolder = path.join(__dirname, '../debug_pages');
fs.writeFileSync(logFile, ''); // Clear log file at the start
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

/**
 * Logs a message with optional debug information.
 * @param {string} message - The main log message.
 * @param {object} [context] - Optional debug information.
 * @param {string} [context.fileName] - Name of the file.
 * @param {string} [context.functionName] - Name of the function.
 * @param {string} [context.field] - Name of the field.
 * @param {object} [context.additionalData] - Any additional data to include.
 * @param {object} [driver] - Selenium WebDriver instance to fetch dynamic data.
 */
async function log(message, context = {}, driver = null) {
    const timestamp = new Date().toISOString();
    const logParts = [`${timestamp}`];

    const silent = process.env.MCD_SILENT_LOGS === '1';

    // Debug: Zeige den Kontext
    if (!silent) {
        console.log('Received context:', context);
    }

    if (context.fileName) {
        logParts.push(`[File: ${context.fileName}]`);
    }

    if (context.functionName) {
        logParts.push(`[Function: ${context.functionName}]`);
    }

    if (context.field) {
        try {
            logParts.push(`[Data: ${JSON.stringify(context.field, null, 2)}]`);
        } catch (err) {
            console.error('Error stringifying field:', err.message);
        }
    }

    if (context.additionalData) {
        try {
            logParts.push(`[Data: ${JSON.stringify(context.additionalData, null, 2)}]`);
        } catch (err) {
            console.error('Error stringifying additionalData:', err.message);
        }
    }

    // Falls `driver` genutzt wird, füge weitere Debugging-Schritte ein
    if (driver) {
        try {
            const currentUrl = await driver.getCurrentUrl();
            logParts.push(`[URL: ${currentUrl}]`);
        } catch (err) {
            console.error('Error fetching current URL:', err.message);
        }
    }

    logParts.push(`- ${message}`);
    const logMessage = logParts.join(' ') + '\n';

    fs.appendFileSync(logFile, logMessage);
    if (!silent) {
        console.log(logMessage);
    }
}


module.exports = { log };
