require('dotenv').config();
const { Builder } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const path = require('path');
const fs = require('fs');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { log } = require('./utils/logger');
const { createDirectories, sanitizeFilename } = require('./utils/directories');
const { loginToMoodle, getCourseTitle, enumerateDownloads, listAvailableCourses } = require('./utils/moodle');
const { processDownloadQueue } = require('./utils/downloader');
const { loadCourseState, saveCourseState } = require('./utils/stateManager');
const inquirer = require('inquirer').default;

const {
    MOODLE_URL,
    MOODLE_LOGIN_URL,
    MOODLE_USERNAME,
    MOODLE_PASSWORD,
    COURSE_URL
} = process.env;

const argv = yargs(hideBin(process.argv))
    .options({
        coursesFile: { type: 'string', describe: 'Pfad zur JSON-Datei mit den Kurskonfigurationen' },
        courseUrl: { type: 'string', describe: 'URL des Moodle-Kurses für manuellen Download', default: COURSE_URL },
        outputDir: { type: 'string', default: './downloads', describe: 'Verzeichnis zum Speichern der Downloads' },
        maxConcurrentDownloads: { type: 'number', default: 3, describe: 'Maximale Anzahl gleichzeitiger Downloads' },
        interval: { type: 'number', default: 3600000, describe: 'Intervall in Millisekunden zwischen den Prüfungen' },
        downloadMode: {
            type: 'string',
            choices: ['all', 'resources-only', 'forums-only', 'quizzes-only'],
            default: 'all',
            describe: 'Download-Modus: all, resources-only, forums-only, quizzes-only'
        },
        enableNotifications: { type: 'boolean', default: false, describe: 'Benachrichtigungen bei neuen Ressourcen aktivieren' },
        manualDownload: { type: 'boolean', default: false, describe: 'Manuellen Downloadmodus aktivieren' },
        keepBrowserOpen: { type: 'boolean', default: false, describe: 'Browser nach Abschluss offen halten' }
    })
    .help()
    .alias('help', 'h')
    .argv;

const tempDownloadDir = path.join(__dirname, 'temp-downloads');
createDirectories([tempDownloadDir]);

const options = new chrome.Options();
const CHROME_BINARY="/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
options.setChromeBinaryPath(CHROME_BINARY);
options.addArguments('--disable-gpu', '--no-sandbox', '--headless');
options.setUserPreferences({
    'download.default_directory': tempDownloadDir,
    'download.prompt_for_download': false,
    'download.directory_upgrade': true,
    'plugins.always_open_pdf_externally': true,
});

(async function main() {
    let driver;

    try {
        driver = await new Builder()
            .forBrowser('chrome')
            .setChromeOptions(options)
            .build();

        if (argv.manualDownload && argv.courseUrl) {
            await downloadSingleCourse(driver, argv.courseUrl, argv.outputDir, argv.downloadMode);
        } else if (argv.coursesFile) {
            const courses = JSON.parse(fs.readFileSync(argv.coursesFile, 'utf8'));
            const interval = argv.interval;

            while (true) {
                for (const courseConfig of courses) {
                    await syncCourse(driver, courseConfig);
                }
                log(`Synchronisation aller Kurse abgeschlossen. Warte ${interval / 1000} Sekunden vor dem nächsten Check.`);
                await new Promise(resolve => setTimeout(resolve, interval));
            }
        } else if (COURSE_URL) {
            await downloadSingleCourse(driver, COURSE_URL, argv.outputDir, argv.downloadMode);
        } else {
            // 🧠 Neue automatische Kurswahl via CLI
            log('Kein Kurs angegeben. Starte interaktive Auswahl.');

            await loginToMoodle(driver, MOODLE_LOGIN_URL, MOODLE_USERNAME, MOODLE_PASSWORD, MOODLE_URL);
            const courses = await listAvailableCourses(driver);

            if (courses.length === 0) {
                log('Es wurden keine Kurse gefunden.');
                return;
            }

            const { selectedCourseIndex } = await inquirer.prompt([
                {
                    type: 'list',
                    name: 'selectedCourseIndex',
                    message: 'Wähle einen Kurs aus:',
                    choices: courses.map((course, i) => ({
                        name: `${course.title} (ID: ${course.courseId})`,
                        value: i
                    }))
                }
            ]);

            const selectedCourse = courses[selectedCourseIndex];
            log(`Du hast gewählt: ${selectedCourse.title} (${selectedCourse.courseId})`);
            await downloadSingleCourse(driver, selectedCourse.url, argv.outputDir, argv.downloadMode, true);
        }
    } catch (err) {
        log(`Ein Fehler ist aufgetreten: ${err}`);
    } finally {
        try {
            if (!argv.keepBrowserOpen) {
                log('Closing browser instance as --keepBrowserOpen is not set.', {}, driver);
                await driver.quit();
            } else {
                log('Browser instance will remain open due to --keepBrowserOpen flag. Press Ctrl+C to terminate.', {}, driver);
                setInterval(() => {}, 1000);
            }
        } catch (err) {
            log('Error during driver.quit().', { error: err.message }, driver);
        }
    }

    process.on('SIGINT', async () => {
        log('Caught interrupt signal. Closing browser.', {}, driver);
        if (driver) await driver.quit();
        process.exit(0);
    });
})();


async function downloadSingleCourse(driver, courseUrl, outputDir, downloadMode, loggedin) {
    try {
        if ( !loggedin ) {
            await loginToMoodle(driver, MOODLE_LOGIN_URL, MOODLE_USERNAME, MOODLE_PASSWORD, MOODLE_URL);
        }
        const courseTitle = await getCourseTitle(driver, courseUrl);
        const coursePath = path.join(outputDir, sanitizeFilename(courseTitle));
        createDirectories([coursePath]);

        const { downloadList } = await enumerateDownloads(driver, coursePath, downloadMode);

        log(`Starte manuellen Download für den Kurs: ${courseTitle}`);
        await processDownloadQueue(downloadList, argv.maxConcurrentDownloads, driver, tempDownloadDir);
    } catch (err) {
        log(`Ein Fehler ist aufgetreten: ${err}`);
    }
}

async function syncCourse(driver, courseConfig) {
    const { courseUrl, outputDir, downloadMode } = courseConfig;

    try {
        await loginToMoodle(driver, MOODLE_LOGIN_URL, MOODLE_USERNAME, MOODLE_PASSWORD, MOODLE_URL);
        const courseTitle = await getCourseTitle(driver, courseUrl);
        const coursePath = path.join(outputDir, sanitizeFilename(courseTitle));
        createDirectories([coursePath]);

        const previousState = loadCourseState(coursePath);

        const { downloadList, currentState } = await enumerateDownloads(driver, coursePath, downloadMode);

        const newResources = getNewResources(previousState, currentState);

        if (newResources.length > 0) {
            log(`Erkannte ${newResources.length} neue oder aktualisierte Ressourcen im Kurs ${courseTitle}.`);
            await processDownloadQueue(newResources, argv.maxConcurrentDownloads, driver, tempDownloadDir);
            saveCourseState(coursePath, currentState);
        } else {
            log(`Keine neuen Ressourcen im Kurs ${courseTitle} erkannt.`);
        }
    } catch (err) {
        log(`Fehler beim Synchronisieren des Kurses ${courseUrl}: ${err}`);
    }
}

function getNewResources(previousState, currentState) {
    const newResources = [];
    for (const resourceKey in currentState) {
        if (!previousState[resourceKey] || currentState[resourceKey].hash !== previousState[resourceKey].hash) {
            newResources.push(currentState[resourceKey]);
        }
    }
    return newResources;
}
