const { By, until } = require('selenium-webdriver');
const { log } = require('./logger');
const fs = require('fs');
const path = require('path');
const { sanitizeFilename } = require('./directories');
const crypto = require('crypto');
const { LOGIN_SELECTORS, MOODLE_SELECTORS } = require('./selectors');
const { scrapeQuiz } = require('./quiz'); // Import der Quiz-Funktion

const delay = ms => new Promise(res => setTimeout(res, ms));

async function loginToMoodle(driver, loginURL, username, password, moodleUrl) {
    log('Navigiere zur Moodle-Login-Seite');
    await driver.get(loginURL);

    log('Benutzername und Passwort eingeben');

    // Warten, bis die Login-Seite geladen ist
    await driver.wait(until.elementLocated(By.css('input[name="logintoken"]')), 5000);

    // Das versteckte Token extrahieren
    const logintoken = await driver.findElement(By.css('input[name="logintoken"]')).getAttribute('value');
    log(`Erhaltenes Login-Token: ${logintoken}`);

    await delay(200);

    await driver.findElement(By.css('input[name="username"]')).sendKeys(username);
    await driver.findElement(By.css('input[name="password"]')).sendKeys(password);

    // Setze das Token ins Formular
    const tokenInput = await driver.findElement(By.css('input[name="logintoken"]'));
    await driver.executeScript("arguments[0].value = arguments[1];", tokenInput, logintoken);

    await driver.findElement(By.css('#loginbtn')).click();

    log('Warte auf Weiterleitung nach dem Login');
    await driver.wait(until.urlContains(moodleUrl), 10000);
}

async function listAvailableCourses(driver) {
    const { MOODLE_URL } = process.env;
    await driver.get(MOODLE_URL);

    await driver.sleep(500); // Optional: warte, bis alles geladen ist

    const courseElements = await driver.findElements(By.css('li.type_course.depth_3.contains_branch a'));

    const courses = [];
    for (const courseElement of courseElements) {
        const title = await courseElement.getAttribute('title');
        const url = await courseElement.getAttribute('href');
        const courseIdMatch = url.match(/id=(\d+)/);
        const courseId = courseIdMatch ? courseIdMatch[1] : 'unknown';
        courses.push({ title, url, courseId });
    }

    return courses;
}

async function getCourseTitle(driver, courseUrl) {
    log('Navigiere zur Kurs-URL');
    await driver.get(courseUrl);

    log('Kurstitel abrufen');
    const courseTitle = await driver.findElement(By.css(MOODLE_SELECTORS.courseTitle)).getText();
    log(`Kurstitel: ${courseTitle}`);

    return courseTitle;
}

async function enumerateDownloads(driver, coursePath, downloadMode) {
    log('Warte, bis die Kursseite geladen ist');
    await driver.wait(until.elementLocated(By.css(MOODLE_SELECTORS.courseContent)), 10000);

    // Sektionen auswählen
    const sections = await driver.findElements(By.css(MOODLE_SELECTORS.section));
    log(`Anzahl gefundener Sektionen: ${sections.length}`);

    const downloadList = [];
    const seenUrls = new Set();
    const currentState = {};

    for (const [sectionIndex, section] of sections.entries()) {
        try {
            let sectionTitle = await section.getAttribute(MOODLE_SELECTORS.sectionAriaLabel);
            if (sectionTitle) {
                log(`Sektion ${sectionIndex + 1}: Gefundener Sektionsname aus aria-label: "${sectionTitle}"`);
            } else {
                log(`Sektion ${sectionIndex + 1}: Kein aria-label vorhanden, versuche alternative Methoden`);
                sectionTitle = await getSectionTitleFromElement(section, sectionIndex);
            }

            log(`Verarbeite Sektion ${sectionIndex + 1}: "${sectionTitle}"`);

            const sectionPath = path.join(coursePath, sanitizeFilename(sectionTitle));
            if (!fs.existsSync(sectionPath)) {
                fs.mkdirSync(sectionPath, { recursive: true });
                log(`Erstelle Verzeichnis für Sektion: ${sectionPath}`);
            } else {
                log(`Verzeichnis für Sektion existiert bereits: ${sectionPath}`);
            }

            const activities = await section.findElements(By.css(MOODLE_SELECTORS.activity));
            log(`Anzahl gefundener Aktivitäten in Sektion "${sectionTitle}": ${activities.length}`);

            for (const [activityIndex, activity] of activities.entries()) {
                const activityType = await activity.getAttribute('class');
                const activityId = await activity.getAttribute('id');
                log(`Verarbeite Aktivität ${activityIndex + 1} in Sektion "${sectionTitle}" - ID: ${activityId}, Typ: ${activityType}`);

                let activityName = 'Unbenannte Aktivität';
                try {
                    const activityNameElement = await activity.findElement(By.css(MOODLE_SELECTORS.activityName));
                    activityName = await activityNameElement.getText();
                } catch (err) {
                    log(`Fehler beim Auslesen des Aktivitätsnamens: ${err.message}`);
                }
                log(`Aktivitätsname: "${activityName}"`);

                let activityLink = null;
                let activityUrl = '';
                try {
                    activityLink = await activity.findElement(By.css(MOODLE_SELECTORS.activityLink));
                    activityUrl = await activityLink.getAttribute('href');
                } catch (err) {
                    log(`Fehler beim Auslesen der Aktivitäts-URL: ${err.message}`);
                    continue; // Ohne URL können wir nicht fortfahren
                }
                log(`Aktivitäts-URL: ${activityUrl}`);

                const resourceKey = activityUrl;
                const resourceHash = getResourceHash(activityName, activityUrl);

                const resource = {
                    url: activityUrl,
                    name: activityName,
                    path: sectionPath,
                    hash: resourceHash,
                    isLink: activityType.includes('modtype_url'),
                    isForum: activityType.includes('modtype_forum'),
                    isFolder: activityType.includes('modtype_folder'),
                    isQuiz: activityType.includes('modtype_quiz'),
                };

                currentState[resourceKey] = resource;

                if (!seenUrls.has(activityUrl)) {
                    seenUrls.add(activityUrl);

                    if (resource.isLink && (downloadMode === 'all' || downloadMode === 'resources-only')) {
                        log(`Gefundener Link: ${activityName} unter URL: ${activityUrl}`);
                        downloadList.push(resource);
                    } else if (resource.isForum && (downloadMode === 'all' || downloadMode === 'forums-only')) {
                        log(`Gefundenes Forum: ${activityName} unter URL: ${activityUrl}`);
                        downloadList.push(resource);
                    } else if (resource.isFolder && (downloadMode === 'all' || downloadMode === 'resources-only')) {
                        log(`Gefundener Ordner: ${activityName} unter URL: ${activityUrl}`);
                        downloadList.push(resource);
                    } else if (resource.isQuiz && (downloadMode === 'all' || downloadMode === 'quizzes-only')) {
                        log(`Gefundenes Quiz: ${activityName} unter URL: ${activityUrl}`);
                        await scrapeQuiz(driver, activityUrl, sectionPath);
                    } else if (activityType.includes('modtype_resource') && (downloadMode === 'all' || downloadMode === 'resources-only')) {
                        log(`Gefundene Ressource: ${activityName} unter URL: ${activityUrl}`);
                        downloadList.push(resource);
                    } else {
                        log(`Überspringe unbekannten oder nicht ausgewählten Aktivitätstyp: ${activityType}`);
                    }
                } else {
                    log(`Überspringe doppelte URL: ${activityUrl}`);
                }
            }
        } catch (err) {
            log(`Fehler beim Verarbeiten der Sektion ${sectionIndex + 1}: ${err.message}`);
        }
    }

    log(`Gesamtanzahl gefundener Ressourcen: ${downloadList.length}`);
    return { downloadList, currentState };
}

async function getSectionTitleFromElement(section, sectionIndex) {
    let sectionTitle = 'Unbenannte Sektion';
    let sectionTitleFound = false;

    const attributeCandidates = ['data-sectionname', 'data-name', 'data-title'];

    for (const attribute of attributeCandidates) {
        try {
            const attributeValue = await section.getAttribute(attribute);
            if (attributeValue && attributeValue.trim()) {
                sectionTitle = attributeValue.trim();
                sectionTitleFound = true;
                log(`Sektion ${sectionIndex + 1}: Gefundener Sektionsname über Attribut "${attribute}": "${sectionTitle}"`);
                break;
            }
        } catch (err) {
            log(`Sektion ${sectionIndex + 1}: Fehler beim Auslesen des Attributs "${attribute}": ${err.message}`);
        }
    }

    if (!sectionTitleFound) {
        const possibleSelectors = MOODLE_SELECTORS.sectionTitleSelectors;

        for (const selector of possibleSelectors) {
            try {
                log(`Sektion ${sectionIndex + 1}: Versuche Sektionsnamen mit Selektor "${selector}" zu finden`);
                const sectionTitleElement = await section.findElement(By.css(selector));
                const extractedTitle = await sectionTitleElement.getText();
                if (extractedTitle && extractedTitle.trim()) {
                    sectionTitle = extractedTitle.trim();
                    log(`Sektion ${sectionIndex + 1}: Gefundener Sektionsname mit Selektor "${selector}": "${sectionTitle}"`);
                    sectionTitleFound = true;
                    break;
                }
            } catch (err) {
                log(`Sektion ${sectionIndex + 1}: Sektionsname nicht gefunden mit Selektor "${selector}"`);
            }
        }
    }

    if (!sectionTitleFound) {
        log(`Sektion ${sectionIndex + 1}: Sektionsname konnte nicht gefunden werden, verwende Standard "${sectionTitle}"`);
    }

    return sectionTitle;
}

function getResourceHash(name, url) {
    return crypto.createHash('md5').update(name + url).digest('hex');
}

module.exports = { loginToMoodle, getCourseTitle, enumerateDownloads, listAvailableCourses };
