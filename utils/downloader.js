const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { log, emitUiEvent } = require('./logger');
const { By } = require('selenium-webdriver');
const { clearDirectory, sanitizeFilename } = require('./directories');
const { scrapeForumPosts } = require('./forumScraper');
const { MOODLE_SELECTORS, RESOURCE_SELECTORS, FOLDER_SELECTORS } = require('./selectors');

const readline = require('readline');

const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB
const DOWNLOAD_DEBUG_INTERVAL_BYTES = 5 * 1024 * 1024;
const DEBUG_DOWNLOAD_SIZE = process.env.MCD_DEBUG_DOWNLOAD_SIZE === '1';

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

const colors = {
    reset: '\x1b[0m',
    fg: {
        green: '\x1b[32m',
        blue: '\x1b[34m',
        magenta: '\x1b[35m',
        cyan: '\x1b[36m',
        yellow: '\x1b[33m',
    },
};

function logDownloadSizeDebug(message, additionalData = {}) {
    if (!DEBUG_DOWNLOAD_SIZE) {
        return;
    }

    log(message, {
        level: 'debug',
        fileName: 'utils/downloader.js',
        functionName: 'downloadFile',
        additionalData,
    });
}

function showProgress(completed, total) {
    readline.cursorTo(process.stdout, 0);
    process.stdout.write(`Progress: ${completed}/${total} (${total === 0 ? '100.00' : ((completed / total) * 100).toFixed(2)}%)`);
}

function clearProgress() {
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
}

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

function determineResourceKind(resource) {
    if (resource.isFolder) {
        return 'folder';
    }
    if (resource.isLink) {
        return 'link';
    }
    if (resource.isForum) {
        return 'forum';
    }
    return 'resource';
}

function buildTaskDescriptor(resource, targetPath) {
    return {
        name: resource.name,
        type: determineResourceKind(resource),
        path: path.relative(process.cwd(), targetPath),
        url: resource.url,
    };
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
    return descriptor;
}

function createProgressEmitter(total) {
    const state = {
        total,
        completed: 0,
        active: 0,
        startedAt: Date.now(),
    };

    const emit = (extra = {}) => {
        const pending = Math.max(state.total - state.completed - state.active, 0);
        const percent = state.total === 0 ? 100 : Math.min(100, Math.round((state.completed / state.total) * 100));
        emitUiEvent('progress', {
            total: state.total,
            completed: state.completed,
            active: state.active,
            pending,
            percent,
            startedAt: state.startedAt,
            ...extra,
        });
    };

    emit({ stage: total === 0 ? 'idle' : 'running' });

    return {
        state,
        emit,
        start(task) {
            state.active += 1;
            emit({ stage: 'running', current: task });
        },
        complete(task) {
            state.active = Math.max(state.active - 1, 0);
            state.completed += 1;
            emit({ stage: state.completed >= state.total ? 'finishing' : 'running', lastCompleted: task });
        },
        finish() {
            state.active = 0;
            if (state.completed < state.total) {
                state.completed = state.total;
            }
            emit({ stage: 'finished' });
        },
    };
}

async function processDownloadQueue(downloadList, maxConcurrent, driver, tempDownloadDir) {
    const queue = [...downloadList];
    const results = [];
    const activeDownloads = [];
    let completedDownloads = 0;

    const progress = createProgressEmitter(downloadList.length);

    showProgress(completedDownloads, downloadList.length);

    while (queue.length > 0) {
        while (activeDownloads.length < maxConcurrent && queue.length > 0) {
            const resource = queue.shift();
            if (!resource) {
                break;
            }
            const { url, path: targetPath, name, isFolder, isLink, isForum } = resource;
            const resourceKind = determineResourceKind(resource);
            const taskDescriptor = buildTaskDescriptor(resource, targetPath);
            const coloredType = isFolder
                ? `${colors.fg.blue}Ordner${colors.reset}`
                : isLink
                    ? `${colors.fg.magenta}Link${colors.reset}`
                    : isForum
                        ? `${colors.fg.cyan}Forum${colors.reset}`
                        : `${colors.fg.green}Ressource${colors.reset}`;

            log(`Queueing download for: ${name} (Typ: ${coloredType})`, {
                level: 'debug',
                fileName: 'utils/downloader.js',
                functionName: 'processDownloadQueue',
            });

            progress.start(taskDescriptor);

            const downloadPromise = isFolder
                ? processFolder(url, targetPath, name, driver, tempDownloadDir)
                : isLink
                    ? processLink(url, targetPath, name, driver)
                    : isForum
                        ? scrapeForumPosts(url, targetPath, name, driver)
                        : processResource(url, targetPath, name, driver, tempDownloadDir);

            const wrappedPromise = downloadPromise.finally(() => {
                activeDownloads.splice(activeDownloads.indexOf(wrappedPromise), 1);
                completedDownloads += 1;
                progress.complete(taskDescriptor);
                showProgress(completedDownloads, downloadList.length);
            });

            activeDownloads.push(wrappedPromise);
            results.push(wrappedPromise);
        }
        if (activeDownloads.length > 0) {
            await Promise.race(activeDownloads);
        }
    }

    await Promise.all(results);
    progress.finish();
    clearProgress();
}

async function processResource(url, sectionPath, resourceName, driver, tempDownloadDir) {
    try {
        log(`Verarbeite Ressourcen-URL: ${url}`);
        await driver.get(url);

        const resourceContentLinks = await driver.findElements(By.css(RESOURCE_SELECTORS.resourceContentLink));
        const resourceContentImages = await driver.findElements(By.css(RESOURCE_SELECTORS.resourceContentImage));

        log(`Resource content links found: ${resourceContentLinks.length}`);
        log(`Resource content images found: ${resourceContentImages.length}`);

        if (resourceContentLinks.length > 0) {
            const downloadLink = await resourceContentLinks[0].getAttribute('href');
            log(`Found resource content link, treating as resource-encapsulated download: ${downloadLink}`);
            await downloadFile(downloadLink, sectionPath, resourceName, driver, tempDownloadDir);
        } else if (resourceContentImages.length > 0) {
            const downloadLink = await resourceContentImages[0].getAttribute('src');
            log(`Found resource content image, treating as resource-encapsulated download: ${downloadLink}`);
            await downloadFile(downloadLink, sectionPath, resourceName, driver, tempDownloadDir);
        } else {
            log(`No resource content found for URL: ${url}, treating as direct download.`);
            await downloadFile(url, sectionPath, resourceName, driver, tempDownloadDir);
        }
    } catch (err) {
        log(`Failed to process resource from ${url}: ${err.message}`, {
            level: 'error',
            fileName: 'utils/downloader.js',
            functionName: 'processResource',
        });
    }
}

async function processFolder(url, sectionPath, folderName, driver, tempDownloadDir) {
    try {
        log(`Processing folder URL: ${url}`);
        await driver.get(url);

        const folderPath = path.join(sectionPath, sanitizeFilename(folderName));
        if (!fs.existsSync(folderPath)) {
            fs.mkdirSync(folderPath, { recursive: true });
        }

        const folderLinks = await driver.findElements(By.css(FOLDER_SELECTORS.folderLinks));

        for (const link of folderLinks) {
            const downloadLink = await link.getAttribute('href');
            const fileName = await link.findElement(By.css(FOLDER_SELECTORS.folderFileName)).getText();

            log(`Found file in folder: ${fileName} at URL: ${downloadLink}`);
            await downloadFile(downloadLink, folderPath, fileName, driver, tempDownloadDir);
        }
    } catch (err) {
        log(`Failed to process folder from ${url}: ${err.message}`, {
            level: 'error',
            fileName: 'utils/downloader.js',
            functionName: 'processFolder',
        });
    }
}

async function processLink(url, sectionPath, linkName, driver) {
    try {
        log(`Processing link URL: ${url}`);
        await driver.get(url);

        const linkContentElement = await driver.findElement(By.css(MOODLE_SELECTORS.activityLink));
        const linkContent = await linkContentElement.getAttribute('href');
        log(`Found link content: ${linkContent}`);

        const linkFileName = sanitizeFilename(`${linkName}.txt`);
        const linkFilePath = path.join(sectionPath, linkFileName);
        await fs.promises.writeFile(linkFilePath, linkContent);

        log(`Saved link content to ${linkFilePath}`, {
            level: 'success',
            fileName: 'utils/downloader.js',
            functionName: 'processLink',
        });
    } catch (err) {
        log(`Failed to process link from ${url}: ${err.message}`, {
            level: 'error',
            fileName: 'utils/downloader.js',
            functionName: 'processLink',
        });
    }
}

async function downloadFile(url, sectionDir, resourceName, driver, tempDownloadDir) {
    try {
        clearDirectory(tempDownloadDir);

        log(`Starting download from URL: ${url}`);

        const cookies = await driver.manage().getCookies();
        const cookieString = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');

        const response = await axios({
            url,
            method: 'GET',
            responseType: 'stream',
            headers: {
                Cookie: cookieString,
            },
        });

        const contentDisposition = response.headers['content-disposition'];
        let filename = resourceName;
        if (contentDisposition && contentDisposition.includes('filename=')) {
            filename = contentDisposition.split('filename=')[1].split(';')[0].replace(/"/g, '').trim();
        } else {
            const urlParts = new URL(url);
            filename = path.basename(urlParts.pathname);
        }

        const sanitizedFilename = sanitizeFilename(filename);
        const contentLengthHeader = response.headers['content-length'];
        if (contentLengthHeader) {
            const contentLength = parseInt(contentLengthHeader, 10);
            logDownloadSizeDebug('Received Content-Length header for download', {
                url,
                resourceName,
                contentLength,
                limitBytes: MAX_FILE_SIZE_BYTES,
            });
            if (!Number.isNaN(contentLength) && contentLength > MAX_FILE_SIZE_BYTES) {
                log(`Warnung: Überspringe Download von ${sanitizedFilename} (${formatBytes(contentLength)}), da die Datei größer als 100MB ist.`, {
                    level: 'warn',
                    fileName: 'utils/downloader.js',
                    functionName: 'downloadFile',
                });
                logDownloadSizeDebug('Skipped download due to Content-Length exceeding limit', {
                    url,
                    resourceName,
                    contentLength,
                    limitBytes: MAX_FILE_SIZE_BYTES,
                });
                return;
            }
        } else {
            logDownloadSizeDebug('No Content-Length header present; relying on streamed size enforcement', {
                url,
                resourceName,
                limitBytes: MAX_FILE_SIZE_BYTES,
            });
        }

        const filePath = path.join(sectionDir, sanitizedFilename);

        await new Promise((resolve, reject) => {
            const stream = response.data;
            const writer = fs.createWriteStream(filePath);
            let downloadedBytes = 0;
            let abortedDueToSize = false;
            let settled = false;
            let nextDebugThreshold = DOWNLOAD_DEBUG_INTERVAL_BYTES;

            const safeResolve = () => {
                if (!settled) {
                    settled = true;
                    resolve();
                }
            };

            const safeReject = (error) => {
                if (!settled) {
                    settled = true;
                    reject(error);
                }
            };

            const cleanupPartialFile = () => fs.promises.unlink(filePath).catch(() => {});

            const abortDueToSize = () => {
                if (abortedDueToSize) {
                    return;
                }
                abortedDueToSize = true;
                const sizeInBytes = downloadedBytes;
                log(`Warnung: Überspringe Download von ${sanitizedFilename} (${formatBytes(sizeInBytes)}), da die Datei größer als 100MB ist.`, {
                    level: 'warn',
                    fileName: 'utils/downloader.js',
                    functionName: 'downloadFile',
                });
                logDownloadSizeDebug('Aborted streaming download after exceeding size limit', {
                    url,
                    resourceName,
                    downloadedBytes,
                    limitBytes: MAX_FILE_SIZE_BYTES,
                });
                stream.destroy();
                writer.destroy();
            };

            stream.on('data', (chunk) => {
                downloadedBytes += chunk.length;
                if (DEBUG_DOWNLOAD_SIZE && downloadedBytes >= nextDebugThreshold) {
                    logDownloadSizeDebug('Download progress update', {
                        url,
                        resourceName,
                        downloadedBytes,
                        limitBytes: MAX_FILE_SIZE_BYTES,
                    });
                    nextDebugThreshold += DOWNLOAD_DEBUG_INTERVAL_BYTES;
                }
                if (downloadedBytes > MAX_FILE_SIZE_BYTES) {
                    abortDueToSize();
                }
            });

            stream.on('error', (err) => {
                if (abortedDueToSize) {
                    cleanupPartialFile().finally(safeResolve);
                } else {
                    safeReject(err);
                }
            });

            writer.on('finish', () => {
                if (abortedDueToSize) {
                    cleanupPartialFile().finally(safeResolve);
                    return;
                }

                (async () => {
                    logDownloadSizeDebug('Finished downloading file', {
                        url,
                        resourceName,
                        downloadedBytes,
                        limitBytes: MAX_FILE_SIZE_BYTES,
                    });
                    log(`Downloaded file to ${filePath}`, {
                        level: 'info',
                        fileName: 'utils/downloader.js',
                        functionName: 'downloadFile',
                    });
                    await waitForDownloadCompletion(filePath);
                    await verifyDownload({
                        filePath,
                        url,
                        sectionDir,
                        resourceName,
                        driver,
                        tempDownloadDir,
                    });
                })().then(safeResolve).catch(safeReject);
            });

            writer.on('error', (err) => {
                if (abortedDueToSize) {
                    cleanupPartialFile().finally(safeResolve);
                } else {
                    safeReject(err);
                }
            });

            writer.on('close', () => {
                if (abortedDueToSize) {
                    cleanupPartialFile().finally(safeResolve);
                }
            });

            stream.pipe(writer);
        });
    } catch (err) {
        log(`Failed to download file from ${url}: ${err.message}`, {
            level: 'error',
            fileName: 'utils/downloader.js',
            functionName: 'downloadFile',
        });
    }
}

async function waitForDownloadCompletion(filePath) {
    const downloadInProgress = `${filePath}.crdownload`;
    while (fs.existsSync(downloadInProgress)) {
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}

async function verifyDownload({ filePath, url, sectionDir, resourceName, driver, tempDownloadDir }) {
    try {
        const stats = await fs.promises.stat(filePath);
        if (stats.size > 0) {
            log(`Integrity check passed for file: ${filePath}`, {
                level: 'success',
                fileName: 'utils/downloader.js',
                functionName: 'verifyDownload',
            });
            const fileDescriptor = describeFileForUi(filePath, sectionDir, resourceName, url, stats.size);
            emitUiEvent('download', { file: fileDescriptor });
            return;
        }

        throw new Error(`File ${filePath} has size 0 bytes`);
    } catch (err) {
        log(`Integrity check failed for file: ${filePath}. Error: ${err.message}`, {
            level: 'error',
            fileName: 'utils/downloader.js',
            functionName: 'verifyDownload',
        });
        log(`Retrying download for ${url}`, {
            level: 'warn',
            fileName: 'utils/downloader.js',
            functionName: 'verifyDownload',
        });
        await downloadFile(url, sectionDir, resourceName, driver, tempDownloadDir);
    }
}

module.exports = { processDownloadQueue };
