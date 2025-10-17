require('dotenv').config();
const { Builder } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const path = require('path');
const fs = require('fs');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { spawn } = require('child_process');
const http = require('http');
const { log } = require('./utils/logger');
const { createDirectories, sanitizeFilename } = require('./utils/directories');
const { loginToMoodle, getCourseTitle, enumerateDownloads, listAvailableCourses } = require('./utils/moodle');
const { processDownloadQueue } = require('./utils/downloader');
const { loadCourseState, saveCourseState } = require('./utils/stateManager');
const progressTracker = require('./utils/progressTracker');
const inquirer = require('inquirer').default;

// QUIZ WATCHER ⬇️
const { withQuizWatcher } = require('./utils/quizWatcher');

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
        quizSolverMode: {
            type: 'string',
            choices: ['prompt', 'manual', 'openai', 'openai-delayed'],
            default: 'prompt',
            describe: 'Steuert, ob Quiz-Versuche manuell, automatisch über OpenAI oder nach Rückfrage gelöst werden'
        },
        enableNotifications: { type: 'boolean', default: false, describe: 'Benachrichtigungen bei neuen Ressourcen aktivieren' },
        manualDownload: { type: 'boolean', default: false, describe: 'Manuellen Downloadmodus aktivieren' },
        keepBrowserOpen: { type: 'boolean', default: false, describe: 'Browser nach Abschluss offen halten' },
        listCourses: { type: 'boolean', default: false, describe: 'Ermittelt verfügbare Kurse und gibt sie als JSON aus' },
        startServer: { type: 'boolean', default: false, describe: 'Startet die Python-Bridge samt Dashboard und wartet auf deren Beendigung' },
        serverPort: { type: 'number', describe: 'Port für die Dashboard-Bridge (nur mit --startServer)' },
        serverHost: { type: 'string', describe: 'Host/IP für die Dashboard-Bridge (nur mit --startServer)' },
        openDashboard: { type: 'boolean', default: true, describe: 'Öffnet das Dashboard im Browser, wenn --startServer gesetzt ist' }
    })
    .help()
    .alias('help', 'h')
    .argv;

const tempDownloadDir = path.join(__dirname, 'temp-downloads');
createDirectories([tempDownloadDir]);

const options = new chrome.Options();

function resolveChromeBinary() {
    const envBinary = process.env.MCD_CHROME_BINARY || process.env.CHROME_BINARY;
    if (envBinary && fs.existsSync(envBinary)) {
        return envBinary;
    }

    const platform = process.platform;
    const candidates = [];

    if (platform === 'darwin') {
        candidates.push('/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
        candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    } else if (platform === 'win32') {
        candidates.push('C:/Program Files/Google/Chrome/Application/chrome.exe');
        candidates.push('C:/Program Files (x86)/Google/Chrome/Application/chrome.exe');
    } else {
        candidates.push('/usr/bin/google-chrome');
        candidates.push('/usr/bin/chromium');
        candidates.push('/usr/bin/chromium-browser');
    }

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    return null;
}

const chromeBinary = resolveChromeBinary();
if (chromeBinary) {
    options.setChromeBinaryPath(chromeBinary);
}
options.addArguments('--disable-gpu', '--no-sandbox');
options.setUserPreferences({
    'download.default_directory': tempDownloadDir,
    'download.prompt_for_download': false,
    'download.directory_upgrade': true,
    'plugins.always_open_pdf_externally': true,
});

(async function main() {
    if (argv.startServer) {
        try {
            await runDashboardBridge(argv);
        } catch (err) {
            console.error(err && err.message ? err.message : err);
            process.exit(1);
        }
        return;
    }

    let driver;
    const listCoursesMode = argv.listCourses;

    if (listCoursesMode) {
        process.env.MCD_SILENT_LOGS = '1';
    }

    try {
        driver = await new Builder()
            .forBrowser('chrome')
            .setChromeOptions(options)
            .build();

        if (listCoursesMode) {
            await loginToMoodle(driver, MOODLE_LOGIN_URL, MOODLE_USERNAME, MOODLE_PASSWORD, MOODLE_URL);
            const courses = await listAvailableCourses(driver);
            console.log(JSON.stringify({ courses }, null, 2));
            return;
        }

        const normalizedCourseUrl = typeof argv.courseUrl === 'string' ? argv.courseUrl.trim() : '';

        if (argv.manualDownload) {
            if (!normalizedCourseUrl) {
                await log('Manueller Downloadmodus benötigt eine Kurs-URL.');
                return;
            }
            await withQuizWatcher(driver, log, async () => {
                await downloadSingleCourse(driver, normalizedCourseUrl, argv.outputDir, argv.downloadMode);
            });
        } else if (argv.coursesFile) {
            const courses = JSON.parse(fs.readFileSync(argv.coursesFile, 'utf8'));
            const interval = argv.interval;

            while (true) {
                for (const courseConfig of courses) {
                    await withQuizWatcher(driver, log, async () => {
                        await syncCourse(driver, courseConfig);
                    });
                }
                log(`Synchronisation aller Kurse abgeschlossen. Warte ${interval / 1000} Sekunden vor dem nächsten Check.`);
                await new Promise(resolve => setTimeout(resolve, interval));
            }
        } else if (normalizedCourseUrl) {
            await withQuizWatcher(driver, log, async () => {
                await downloadSingleCourse(driver, normalizedCourseUrl, argv.outputDir, argv.downloadMode);
            });
        } else {
            // 🧠 Neue automatische Kurswahl via CLI
            log('Kein Kurs angegeben. Starte interaktive Auswahl.');

            await loginToMoodle(driver, MOODLE_LOGIN_URL, MOODLE_USERNAME, MOODLE_PASSWORD, MOODLE_URL);
            const courses = await listAvailableCourses(driver);

            if (courses.length === 0) {
                log('Es wurden keine Kurse gefunden.');
                return;
            }

            let selectedCourseIndex;
            try {
                ({ selectedCourseIndex } = await inquirer.prompt([
                    {
                        type: 'list',
                        name: 'selectedCourseIndex',
                        message: 'Wähle einen Kurs aus:',
                        choices: courses.map((course, i) => ({
                            name: `${course.title} (ID: ${course.courseId})`,
                            value: i
                        }))
                    }
                ]));
            } catch (promptError) {
                if (promptError && (promptError.name === 'ExitPromptError' || promptError.message?.includes('force closed'))) {
                    await log('Interaktive Kursauswahl wurde vom Benutzer abgebrochen.');
                    return;
                }
                throw promptError;
            }

            const selectedCourse = courses[selectedCourseIndex];
            log(`Du hast gewählt: ${selectedCourse.title} (${selectedCourse.courseId})`);
            await withQuizWatcher(driver, log, async () => {
                await downloadSingleCourse(driver, selectedCourse.url, argv.outputDir, argv.downloadMode, true);
            });
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


async function runDashboardBridge(argv) {
    const defaultPort = parseInt(process.env.MCD_API_PORT || '8000', 10);
    const host = argv.serverHost || process.env.MCD_API_HOST || '0.0.0.0';
    const port = argv.serverPort || defaultPort;
    const env = { ...process.env, MCD_API_PORT: String(port), MCD_API_HOST: host };
    const pythonExecutable = resolvePythonExecutable();
    const serverScript = path.join(__dirname, 'server.py');
    const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host;
    const dashboardUrl = `http://${displayHost}:${port}/`;

    await log(`Starte Dashboard-Bridge (${pythonExecutable} ${serverScript}) auf ${host}:${port}`);

    let serverProcess;
    try {
        serverProcess = spawn(pythonExecutable, [serverScript], {
            cwd: __dirname,
            env,
            stdio: ['ignore', 'pipe', 'pipe']
        });
    } catch (err) {
        await log(`Dashboard-Bridge konnte nicht gestartet werden: ${err.message || err}`);
        throw err;
    }

    pipeBridgeOutput(serverProcess.stdout, 'stdout');
    pipeBridgeOutput(serverProcess.stderr, 'stderr');

    try {
        await waitForBridgeReady(displayHost, port, serverProcess);
    } catch (err) {
        if (serverProcess && !serverProcess.killed) {
            serverProcess.kill('SIGINT');
        }
        await log(`Dashboard-Bridge antwortet nicht: ${err.message || err}`);
        throw err;
    }

    await log(`Dashboard läuft unter ${dashboardUrl}`);
    console.log(`Dashboard läuft unter ${dashboardUrl}`);

    if (argv.openDashboard) {
        try {
            await openDashboardInBrowser(dashboardUrl);
        } catch (err) {
            await log(`Dashboard konnte nicht automatisch im Browser geöffnet werden: ${err.message || err}`);
        }
    }

    await log('Dashboard-Server aktiv. Drücke Strg+C zum Stoppen.');
    console.log('Dashboard-Server aktiv. Drücke Strg+C zum Stoppen.');

    const handleSignal = () => {
        if (serverProcess && !serverProcess.killed) {
            log('Stoppe Dashboard-Server...');
            serverProcess.kill('SIGINT');
        }
    };

    process.on('SIGINT', handleSignal);
    process.on('SIGTERM', handleSignal);

    try {
        await new Promise((resolve, reject) => {
            serverProcess.on('exit', (code, signal) => {
                if (signal || code === 0 || code === null) {
                    resolve();
                } else {
                    reject(new Error(`Dashboard-Server wurde mit Code ${code} beendet.`));
                }
            });
            serverProcess.on('error', reject);
        });
    } finally {
        process.removeListener('SIGINT', handleSignal);
        process.removeListener('SIGTERM', handleSignal);
    }

    await log('Dashboard-Server wurde beendet.');
}


function resolvePythonExecutable() {
    if (process.env.MCD_PYTHON) {
        return process.env.MCD_PYTHON;
    }
    if (process.platform === 'win32') {
        return 'python';
    }
    return 'python3';
}


function pipeBridgeOutput(stream, label) {
    if (!stream) {
        return;
    }
    stream.setEncoding('utf8');
    stream.on('data', chunk => {
        const lines = chunk.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        for (const line of lines) {
            console.log(`[bridge:${label}] ${line}`);
        }
    });
}


function waitForBridgeReady(host, port, serverProcess, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        let settled = false;

        const onExit = (code, signal) => {
            if (settled) {
                return;
            }
            settled = true;
            reject(new Error(`Dashboard-Server beendete sich vorzeitig (code=${code}, signal=${signal || 'none'})`));
        };

        serverProcess.once('exit', onExit);

        const tryRequest = () => {
            if (settled) {
                return;
            }

            if (Date.now() > deadline) {
                settled = true;
                serverProcess.removeListener('exit', onExit);
                reject(new Error(`Keine Antwort vom Dashboard auf Port ${port}`));
                return;
            }

            const req = http.get({ host, port, path: '/api/status', timeout: 2000 }, res => {
                res.resume();
                if (settled) {
                    return;
                }
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                    settled = true;
                    serverProcess.removeListener('exit', onExit);
                    resolve();
                } else {
                    setTimeout(tryRequest, 500);
                }
            });

            req.on('timeout', () => {
                req.destroy();
                if (!settled) {
                    setTimeout(tryRequest, 500);
                }
            });

            req.on('error', () => {
                if (!settled) {
                    setTimeout(tryRequest, 500);
                }
            });
        };

        tryRequest();
    });
}


function openDashboardInBrowser(url) {
    return new Promise((resolve, reject) => {
        let command;
        let args;

        if (process.platform === 'darwin') {
            command = 'open';
            args = [url];
        } else if (process.platform === 'win32') {
            command = 'cmd';
            args = ['/c', 'start', '', url];
        } else {
            command = 'xdg-open';
            args = [url];
        }

        let opener;
        try {
            opener = spawn(command, args, { stdio: 'ignore', detached: true });
        } catch (err) {
            reject(err);
            return;
        }

        let settled = false;

        const onSuccess = () => {
            if (settled) {
                return;
            }
            settled = true;
            opener.removeListener('error', onError);
            resolve();
        };

        const onError = (err) => {
            if (settled) {
                return;
            }
            settled = true;
            opener.removeListener('spawn', onSuccess);
            reject(err);
        };

        opener.once('spawn', onSuccess);
        opener.once('error', onError);
        opener.unref();
    });
}


async function downloadSingleCourse(driver, courseUrl, outputDir, downloadMode, loggedin) {
    try {
        progressTracker.reset();
        if ( !loggedin ) {
            await loginToMoodle(driver, MOODLE_LOGIN_URL, MOODLE_USERNAME, MOODLE_PASSWORD, MOODLE_URL);
        }
        const courseTitle = await getCourseTitle(driver, courseUrl);
        const coursePath = path.join(outputDir, sanitizeFilename(courseTitle));
        createDirectories([coursePath]);

        progressTracker.setStage('scanning', { message: `Scanne Kurs "${courseTitle}"` });

        const { downloadList } = await enumerateDownloads(driver, coursePath, downloadMode, argv.quizSolverMode);

        log(`Starte manuellen Download für den Kurs: ${courseTitle}`);
        progressTracker.setMessage(`Starte Downloads für "${courseTitle}"`);
        await processDownloadQueue(downloadList, argv.maxConcurrentDownloads, driver, tempDownloadDir);
        progressTracker.setStage('finished', { message: `Kurs "${courseTitle}" abgeschlossen` });
    } catch (err) {
        log(`Ein Fehler ist aufgetreten: ${err}`);
        progressTracker.failTask(null, err, { message: `Verarbeitung des Kurses fehlgeschlagen: ${err.message}` });
    }
}

async function syncCourse(driver, courseConfig) {
    const { courseUrl, outputDir, downloadMode } = courseConfig;

    try {
        progressTracker.reset();
        await loginToMoodle(driver, MOODLE_LOGIN_URL, MOODLE_USERNAME, MOODLE_PASSWORD, MOODLE_URL);
        const courseTitle = await getCourseTitle(driver, courseUrl);
        const coursePath = path.join(outputDir, sanitizeFilename(courseTitle));
        createDirectories([coursePath]);

        progressTracker.setStage('scanning', { message: `Scanne Kurs "${courseTitle}"` });

        const previousState = loadCourseState(coursePath);

        const { downloadList, currentState } = await enumerateDownloads(driver, coursePath, downloadMode, argv.quizSolverMode);

        const newResources = getNewResources(previousState, currentState);

        if (newResources.length > 0) {
            log(`Erkannte ${newResources.length} neue oder aktualisierte Ressourcen im Kurs ${courseTitle}.`);
            progressTracker.setMessage(`Starte Downloads für "${courseTitle}" (${newResources.length} neu)`);
            await processDownloadQueue(newResources, argv.maxConcurrentDownloads, driver, tempDownloadDir);
            saveCourseState(coursePath, currentState);
            progressTracker.setStage('finished', { message: `Kurs "${courseTitle}" synchronisiert` });
        } else {
            log(`Keine neuen Ressourcen im Kurs ${courseTitle} erkannt.`);
            progressTracker.finish({ message: `Keine neuen Ressourcen für "${courseTitle}"` });
        }
    } catch (err) {
        log(`Fehler beim Synchronisieren des Kurses ${courseUrl}: ${err}`);
        progressTracker.failTask(null, err, { message: `Synchronisation fehlgeschlagen: ${err.message}` });
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
