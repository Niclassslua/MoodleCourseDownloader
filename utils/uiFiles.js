const fs = require('fs');
const path = require('path');

const PREVIEWABLE_EXTENSIONS = new Set([
    'pdf',
    'txt',
    'md',
    'json',
    'csv',
    'jpg',
    'jpeg',
    'png',
    'gif',
    'webp',
    'bmp',
    'svg',
]);

function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) {
        return '0 B';
    }
    if (bytes === 0) {
        return '0 B';
    }
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index += 1;
    }
    const precision = value >= 10 || index === 0 ? 0 : 1;
    return `${value.toFixed(precision)} ${units[index]}`;
}

function describeFileForUi(filePath, sectionDir, resourceName, url, sizeBytes) {
    const name = path.basename(filePath);
    const extension = path.extname(name).replace('.', '').toLowerCase();
    const descriptor = {
        name,
        resourceName,
        path: filePath,
        relativePath: path.relative(process.cwd(), filePath),
        sectionPath: sectionDir ? path.relative(process.cwd(), sectionDir) : '',
        sizeBytes,
        sizeHuman: formatBytes(sizeBytes),
        extension,
        url,
        previewHint: PREVIEWABLE_EXTENSIONS.has(extension) ? 'preview' : 'download',
        downloadedAt: new Date().toISOString(),
    };

    try {
        const stats = fs.statSync(filePath);
        descriptor.sizeBytes = typeof sizeBytes === 'number' && sizeBytes >= 0 ? sizeBytes : stats.size;
        descriptor.sizeHuman = formatBytes(descriptor.sizeBytes);
    } catch (err) {
        if (!descriptor.sizeBytes || descriptor.sizeBytes < 0) {
            descriptor.sizeBytes = 0;
            descriptor.sizeHuman = '0 B';
        }
    }

    return descriptor;
}

module.exports = {
    formatBytes,
    describeFileForUi,
};
