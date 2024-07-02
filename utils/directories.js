const fs = require('fs');
const path = require('path');
const { log } = require('./logger');

function createDirectories(paths) {
    for (const dirPath of paths) {
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
            log(`Created directory: ${dirPath}`);
        }
    }
}

function clearDirectory(directory) {
    fs.readdir(directory, (err, files) => {
        if (err) {
            log(`Failed to read directory ${directory}: ${err.message}`);
            return;
        }
        for (const file of files) {
            const filePath = path.join(directory, file);
            safeUnlink(filePath);
        }
    });
}

function safeUnlink(filePath) {
    fs.access(filePath, fs.constants.F_OK, (err) => {
        if (!err) {
            fs.unlink(filePath, (err) => {
                if (err) {
                    log(`Failed to unlink file ${filePath}: ${err.message}`);
                } else {
                    log(`Successfully unlinked file ${filePath}`);
                }
            });
        } else {
            log(`File does not exist, skipping unlink: ${filePath}`);
        }
    });
}


function sanitizeFilename(filename) {
    return filename.replace(/[^a-z0-9_\-\.]/gi, '_').toLowerCase();
}

module.exports = { createDirectories, clearDirectory, safeUnlink, sanitizeFilename };
