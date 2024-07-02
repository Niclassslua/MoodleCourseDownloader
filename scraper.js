require('dotenv').config();
const { Builder } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const path = require('path');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { log } = require('./utils/logger');
const { createDirectories, clearDirectory, sanitizeFilename } = require('./utils/directories');
const { loginToMoodle, getCourseTitle, enumerateDownloads } = require('./utils/moodle');
const { processDownloadQueue } = require('./utils/downloader');
const { scrapeForumPosts } = require('./utils/forumScraper');

const moodleUrl = process.env.MOODLE_URL;
const moodleLoginURL = process.env.MOODLE_LOGIN_URL;
const username = process.env.MOODLE_USERNAME;
const password = process.env.MOODLE_PASSWORD;
const courseUrl = process.env.COURSE_URL;

const argv = yargs(hideBin(process.argv))
    .options({
        username: { type: 'string', demandOption: false, describe: 'Moodle username' },
        password: { type: 'string', demandOption: false, describe: 'Moodle password' },
        courseUrl: { type: 'string', demandOption: false, describe: 'URL of the Moodle course' },
        outputDir: { type: 'string', default: './downloads', describe: 'Directory to save downloads' },
        maxConcurrentDownloads: { type: 'number', default: 3, describe: 'Maximum number of concurrent downloads' },
        downloadMode: { 
            type: 'string', 
            choices: ['all', 'resources-only', 'forums-only'], 
            default: 'all', 
            describe: 'Download mode: all, resources-only, forums-only' 
        }
    })
    .help()
    .alias('help', 'h')
    .argv;

const tempDownloadDir = path.join(__dirname, 'temp-downloads');
const finalDownloadDir = argv.outputDir;

createDirectories([tempDownloadDir, finalDownloadDir]);

const options = new chrome.Options();
options.addArguments('--disable-gpu', '--no-sandbox');
options.setUserPreferences({
    'download.default_directory': tempDownloadDir,
    'download.prompt_for_download': false,
    'download.directory_upgrade': true,
    'plugins.always_open_pdf_externally': true,
    'profile.default_content_settings.popups': 0,
    'profile.content_settings.exceptions.automatic_downloads.*.setting': 1,
    'profile.default_content_setting_values.automatic_downloads': 1,
    'profile.content_settings.exceptions.plugins.*.setting': 1,
    'profile.content_settings.plugin_run.*.setting': 1,
    'profile.content_settings.exceptions.plugins.*.last_used_time': Date.now(),
    'profile.default_content_setting_values.plugins': 1,
    'profile.managed_default_content_settings.plugins': 1,
    'network.http.max-persistent-connections-per-server': 10,
    'network.http.redirection-limit': 30,
    'permissions.default.image': 2,
    'permissions.default.stylesheet': 2,
});

(async function downloadMoodleCourse() {
    const driver = await new Builder().forBrowser('chrome').setChromeOptions(options).build();
    try {
        await loginToMoodle(driver, moodleLoginURL, username, password, moodleUrl);
        const courseTitle = await getCourseTitle(driver, courseUrl);
        const coursePath = path.join(finalDownloadDir, sanitizeFilename(courseTitle));
        createDirectories([coursePath]);
        const downloadList = await enumerateDownloads(driver, coursePath, argv.downloadMode);

        if (argv.downloadMode === 'all') {
            // Process both forums and resources
            const forumList = [];
            const resourceList = [];
            for (const item of downloadList) {
                if (item.isForum) {
                    forumList.push(item);
                } else {
                    resourceList.push(item);
                }
            }
            // Process resources first
            await processDownloadQueue(resourceList, argv.maxConcurrentDownloads, driver, tempDownloadDir, clearDirectory);
            // Process forums
            for (const item of forumList) {
                await scrapeForumPosts(item.url, item.path, item.name, driver);
            }
        } else if (argv.downloadMode === 'forums-only') {
            // Only process forums
            for (const item of downloadList) {
                if (item.isForum) {
                    await scrapeForumPosts(item.url, item.path, item.name, driver);
                } else {
                    log(`Skipping non-forum item: ${item.name}`);
                }
            }
        } else {
            // Only process resources
            await processDownloadQueue(downloadList, argv.maxConcurrentDownloads, driver, tempDownloadDir, clearDirectory);
        }
    } catch (err) {
        log(`An error occurred: ${err}`);
    } finally {
        await driver.quit();
    }
})();
