const fs = require('fs');
const path = require('path');

const logFile = path.join(__dirname, '../scraper.log');
fs.writeFileSync(logFile, ''); // Clear log file at the start

function log(message) {
    const timestamp = new Date().toISOString();
    const logMessage = `${timestamp} - ${message}\n`;
    fs.appendFileSync(logFile, logMessage);
    console.log(logMessage); // Optional: Ausgabe auf der Konsole für Echtzeit-Feedback
}

module.exports = { log };
