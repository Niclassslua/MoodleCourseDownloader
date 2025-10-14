const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { log } = require('./logger');
const { By, until } = require('selenium-webdriver');
const { createDirectories, clearDirectory, sanitizeFilename, safeUnlink } = require('./directories');
const { scrapeForumPosts } = require('./forumScraper');
const { MOODLE_SELECTORS, RESOURCE_SELECTORS, FORUM_SELECTORS, FOLDER_SELECTORS } = require('./selectors');

const readline = require('readline');

const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB

const colors = {
    reset: "\x1b[0m",
    bright: "\x1b[1m",
    dim: "\x1b[2m",
    underscore: "\x1b[4m",
    blink: "\x1b[5m",
    reverse: "\x1b[7m",
    hidden: "\x1b[8m",

    fg: {
        black: "\x1b[30m",
        red: "\x1b[31m",
        green: "\x1b[32m",
        yellow: "\x1b[33m",
        blue: "\x1b[34m",
        magenta: "\x1b[35m",
        cyan: "\x1b[36m",
        white: "\x1b[37m",
        crimson: "\x1b[38m" // Scarlet
    },
    bg: {
        black: "\x1b[40m",
        red: "\x1b[41m",
        green: "\x1b[42m",
        yellow: "\x1b[43m",
        blue: "\x1b[44m",
        magenta: "\x1b[45m",
        cyan: "\x1b[46m",
        white: "\x1b[47m",
        crimson: "\x1b[48m"
    }
};

function showProgress(completed, total) {
    readline.cursorTo(process.stdout, 0);
    process.stdout.write(`Progress: ${completed}/${total} (${((completed / total) * 100).toFixed(2)}%)`);
}

function clearProgress() {
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
}

async function processDownloadQueue(downloadList, maxConcurrent, driver, tempDownloadDir) {
    const queue = [...downloadList];
    const results = [];
    const activeDownloads = [];
    let completedDownloads = 0;

    showProgress(completedDownloads, downloadList.length);

    while (queue.length > 0) {
        while (activeDownloads.length < maxConcurrent && queue.length > 0) {
            const { url, path, name, isFolder, isLink, isForum } = queue.shift();
            log(`Queueing download for: ${name} (Type: ${isFolder ? `${colors.fg.blue}Folder${colors.reset}` : isLink ? `${colors.fg.magenta}Link${colors.reset}` : isForum ? `${colors.fg.cyan}Forum${colors.reset}` : `${colors.fg.green}Resource${colors.reset}`})`);

            const downloadPromise = isFolder
                ? processFolder(url, path, name, driver, tempDownloadDir, clearDirectory).finally(() => {
                    activeDownloads.splice(activeDownloads.indexOf(downloadPromise), 1);
                    completedDownloads++;
                    showProgress(completedDownloads, downloadList.length);
                })
                : isLink
                    ? processLink(url, path, name, driver).finally(() => {
                        activeDownloads.splice(activeDownloads.indexOf(downloadPromise), 1);
                        completedDownloads++;
                        showProgress(completedDownloads, downloadList.length);
                    })
                    : isForum
                        ? scrapeForumPosts(url, path, name, driver).finally(() => {
                            activeDownloads.splice(activeDownloads.indexOf(downloadPromise), 1);
                            completedDownloads++;
                            showProgress(completedDownloads, downloadList.length);
                        })
                        : processResource(url, path, name, driver, tempDownloadDir, clearDirectory).finally(() => {
                            activeDownloads.splice(activeDownloads.indexOf(downloadPromise), 1);
                            completedDownloads++;
                            showProgress(completedDownloads, downloadList.length);
                        });
            activeDownloads.push(downloadPromise);
            results.push(downloadPromise);
        }
        await Promise.race(activeDownloads);
    }

    await Promise.all(results);
    clearProgress(); // Clear progress display when done
}

async function processResource(url, sectionPath, resourceName, driver, tempDownloadDir, clearDirectory) {
    try {
        log(`\x1b[32mProcessing resource URL:\x1b[0m ${url}`);
        await driver.get(url);

        const resourceContentLinks = await driver.findElements(By.css(RESOURCE_SELECTORS.resourceContentLink));
        const resourceContentImages = await driver.findElements(By.css(RESOURCE_SELECTORS.resourceContentImage));

        log(`Resource content links found: ${resourceContentLinks.length}`);
        log(`Resource content images found: ${resourceContentImages.length}`);

        if (resourceContentLinks.length > 0) {
            const downloadLink = await resourceContentLinks[0].getAttribute('href');
            log(`Found resource content link, treating as resource-encapsulated download: ${downloadLink}`);
            await downloadFile(downloadLink, sectionPath, resourceName, driver, tempDownloadDir, clearDirectory);
        } else if (resourceContentImages.length > 0) {
            const downloadLink = await resourceContentImages[0].getAttribute('src');
            log(`Found resource content image, treating as resource-encapsulated download: ${downloadLink}`);
            await downloadFile(downloadLink, sectionPath, resourceName, driver, tempDownloadDir, clearDirectory);
        } else {
            log(`No resource content found for URL: ${url}, treating as direct download.`);
            await downloadFile(url, sectionPath, resourceName, driver, tempDownloadDir, clearDirectory);
        }
    } catch (err) {
        log(`\x1b[31mFailed to process resource from ${url}:\x1b[0m ${err.message}`);
    }
}

async function processFolder(url, sectionPath, folderName, driver, tempDownloadDir, clearDirectory) {
    try {
        log(`\x1b[34mProcessing folder URL:\x1b[0m ${url}`);
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
            await downloadFile(downloadLink, folderPath, fileName, driver, tempDownloadDir, clearDirectory);
        }
    } catch (err) {
        log(`\x1b[31mFailed to process folder from ${url}:\x1b[0m ${err.message}`);
    }
}

async function processLink(url, sectionPath, linkName, driver) {
    try {
        log(`\x1b[35mProcessing link URL:\x1b[0m ${url}`);
        await driver.get(url);

        const linkContentElement = await driver.findElement(By.css(MOODLE_SELECTORS.activityLink));
        const linkContent = await linkContentElement.getAttribute('href');
        log(`Found link content: ${linkContent}`);

        const linkFileName = sanitizeFilename(`${linkName}.txt`);
        const linkFilePath = path.join(sectionPath, linkFileName);
        await fs.promises.writeFile(linkFilePath, linkContent);

        log(`Saved link content to ${linkFilePath}`);
    } catch (err) {
        log(`\x1b[31mFailed to process link from ${url}:\x1b[0m ${err.message}`);
    }
}

async function downloadFile(url, sectionDir, resourceName, driver, tempDownloadDir, clearDirectory) {
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
            if (!Number.isNaN(contentLength) && contentLength > MAX_FILE_SIZE_BYTES) {
                log(`Warnung: Überspringe Download von ${sanitizedFilename} (${(contentLength / (1024 * 1024)).toFixed(2)} MB), da die Datei größer als 100MB ist.`);
                return;
            }
        }

        const filePath = path.join(sectionDir, sanitizedFilename);

        await new Promise((resolve, reject) => {
            const stream = response.data;
            const writer = fs.createWriteStream(filePath);
            let downloadedBytes = 0;
            let abortedDueToSize = false;
            let settled = false;

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
                const sizeInMb = downloadedBytes / (1024 * 1024);
                log(`Warnung: Überspringe Download von ${sanitizedFilename} (${sizeInMb.toFixed(2)} MB), da die Datei größer als 100MB ist.`);
                stream.destroy();
                writer.destroy();
            };

            stream.on('data', (chunk) => {
                downloadedBytes += chunk.length;
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
                    log(`Downloaded file to ${filePath}`);
                    await waitForDownloadCompletion(filePath);
                    await verifyDownload(filePath, url, sectionDir, driver);
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
        log(`Failed to download file from ${url}: ${err.message}`);
    }
}

async function waitForDownloadCompletion(filePath) {
    const downloadInProgress = `${filePath}.crdownload`;
    while (fs.existsSync(downloadInProgress)) {
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}

async function verifyDownload(filePath, url, sectionDir, driver) {
    try {
        const stats = await fs.promises.stat(filePath);
        if (stats.size > 0) {
            log(`\x1b[32mIntegrity check passed for file:\x1b[0m ${filePath}`);
        } else {
            log(`\x1b[31mIntegrity check failed for file (size 0 bytes):\x1b[0m ${filePath}`);
            throw new Error(`File ${filePath} has size 0 bytes`);
        }
    } catch (err) {
        log(`\x1b[31mIntegrity check failed for file:\x1b[0m ${filePath}. Error: ${err.message}`);
        log(`Retrying download for ${url}`);
        await downloadFile(url, sectionDir, resourceName, driver, tempDownloadDir, clearDirectory); // Retry download
    }
}

module.exports = { processDownloadQueue };
