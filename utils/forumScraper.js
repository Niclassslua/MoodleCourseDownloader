const fs = require('fs');
const path = require('path');
const { log } = require('./logger');
const { By, until } = require('selenium-webdriver');
const { sanitizeFilename } = require('./directories');
const axios = require('axios');
const sizeOf = require('image-size');
const { FORUM_SELECTORS } = require('./selectors');

async function downloadResource(url, downloadPath, cookies) {
    const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream',
        headers: {
            Cookie: cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '),
        },
    });

    const writer = fs.createWriteStream(downloadPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
        writer.on('finish', () => {
            // Check if the file is a valid image
            try {
                const dimensions = sizeOf(downloadPath);
                if (dimensions.width && dimensions.height) {
                    log(`Valid image downloaded to ${downloadPath}`);
                    resolve();
                } else {
                    fs.unlinkSync(downloadPath); // Delete the invalid image file
                    log(`Invalid image file, deleted ${downloadPath}`);
                    reject(new Error('Invalid image file'));
                }
            } catch (err) {
                fs.unlinkSync(downloadPath); // Delete the invalid image file
                log(`Invalid image file, deleted ${downloadPath}`);
                reject(new Error('Invalid image file'));
            }
        });
        writer.on('error', err => {
            fs.unlinkSync(downloadPath); // Delete the file in case of error
            log(`Failed to download file from ${url}: ${err.message}`);
            reject(err);
        });
    });
}

async function scrapeForumPosts(url, sectionPath, forumName, driver) {
    try {
        log(`Processing forum URL: ${url}`);
        await driver.get(url);

        const forumPath = path.join(sectionPath, sanitizeFilename(forumName));
        if (!fs.existsSync(forumPath)) {
            fs.mkdirSync(forumPath, { recursive: true });
        }

        log(`Waiting for discussion list element on forum page: ${url}`);
        try {
            await driver.wait(until.elementLocated(By.css(FORUM_SELECTORS.discussionList)), 10000);
            const discussionListElement = await driver.findElement(By.css(FORUM_SELECTORS.discussionList));
            const discussionListHTML = await discussionListElement.getAttribute('outerHTML');
            log(`Found discussion list element on forum page: ${url}`);
            log(`Discussion list HTML: ${discussionListHTML}`);
        } catch (err) {
            const pageSource = await driver.getPageSource();
            log(`Failed to locate discussion list for forum ${forumName} at URL ${url}`);
            log(`Page source: ${pageSource}`);
            throw err;
        }

        const discussions = await driver.findElements(By.css(FORUM_SELECTORS.discussionRow));
        log(`Found ${discussions.length} discussions on forum page: ${url}`);

        // Extract discussion URLs
        const discussionUrls = [];
        for (const discussion of discussions) {
            const threadTitleElement = await discussion.findElement(By.css(FORUM_SELECTORS.threadTitle));
            const threadTitle = await threadTitleElement.getText();
            const threadUrl = await threadTitleElement.getAttribute('href');
            discussionUrls.push({ threadTitle, threadUrl });
        }

        // Process each discussion URL
        for (const { threadTitle, threadUrl } of discussionUrls) {
            const threadPath = path.join(forumPath, sanitizeFilename(threadTitle));
            if (!fs.existsSync(threadPath)) {
                fs.mkdirSync(threadPath, { recursive: true });
            }

            log(`Opening thread: ${threadTitle} at URL: ${threadUrl}`);
            await driver.get(threadUrl);

            await driver.wait(until.elementLocated(By.css(FORUM_SELECTORS.forumPostContainer)), 10000);

            const posts = await driver.findElements(By.css(FORUM_SELECTORS.forumPostContainer));
            let postIndex = 1;

            for (const post of posts) {
                try {
                    let postContent = await post.getAttribute('outerHTML');  // Get the entire HTML content of the post
                    const postFileName = sanitizeFilename(`post_${postIndex}.html`);
                    const postFilePath = path.join(threadPath, postFileName);

                    // Insert UTF-8 meta tag
                    const utf8MetaTag = '<meta charset="UTF-8">';
                    postContent = utf8MetaTag + postContent;

                    // Find and download images
                    const images = await post.findElements(By.css('img'));
                    const cookies = await driver.manage().getCookies();

                    for (const [imgIndex, img] of images.entries()) {
                        const src = await img.getAttribute('src');
                        const imgUrl = new URL(src, url).href;
                        const imgExtension = path.extname(new URL(src).pathname);

                        // Check if the image is a profile picture
                        const isProfilePicture = imgUrl.includes('/user/icon/') || imgUrl.includes('/u/f1');
                        let imgFileName;
                        if (isProfilePicture) {
                            const usernameElement = await post.findElement(By.css('header .mb-3 a'));
                            const username = sanitizeFilename(await usernameElement.getText());
                            imgFileName = `avatar_${username}${imgExtension}`;
                        } else {
                            imgFileName = `image_${postIndex}_${imgIndex}${imgExtension}`;
                        }

                        const imgFilePath = path.join(threadPath, imgFileName);

                        log(`Found image with src: ${src}`);
                        log(`Downloading image from: ${imgUrl}`);

                        try {
                            await downloadResource(imgUrl, imgFilePath, cookies);
                            log(`Downloaded image to ${imgFilePath}`);

                            // Replace the image src in the post content
                            postContent = postContent.replace(new RegExp(src, 'g'), imgFileName);
                        } catch (err) {
                            log(`Failed to download image from ${imgUrl}: ${err.message}`);
                        }
                    }

                    await fs.promises.writeFile(postFilePath, postContent, 'utf8');
                    log(`Saved post content to ${postFilePath}`);
                    postIndex++;
                } catch (err) {
                    log(`Failed to process post: ${err.message}`);
                }
            }
        }
    } catch (err) {
        log(`Failed to scrape forum posts from ${url}: ${err.message}`);
    }
}

module.exports = { scrapeForumPosts };
