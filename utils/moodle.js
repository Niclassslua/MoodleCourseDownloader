const { By, until } = require('selenium-webdriver');
const { log } = require('./logger');
const fs = require('fs');
const path = require('path');
const { sanitizeFilename } = require('./directories');

async function loginToMoodle(driver, loginURL, username, password, moodleUrl) {
    log('Navigating to Moodle login page');
    await driver.get(loginURL);

    log('Entering username and password');
    await driver.findElement(By.name('username')).sendKeys(username);
    await driver.findElement(By.name('password')).sendKeys(password);
    await driver.findElement(By.id('loginbtn')).click();

    log('Waiting for post-login redirect');
    await driver.wait(until.urlContains(moodleUrl), 10000);
}

async function getCourseTitle(driver, courseUrl) {
    log('Navigating to course URL');
    await driver.get(courseUrl);

    log('Getting course title');
    const courseTitle = await driver.findElement(By.css('.page-header-headings h1')).getText();
    log(`Course title: ${courseTitle}`);
    return courseTitle;
}

async function enumerateDownloads(driver, coursePath, downloadMode) {
    log('Waiting for course page to load');
    await driver.wait(until.elementLocated(By.css('.course-content')), 30000);

    const sections = await driver.findElements(By.css('.course-content .section'));
    const downloadList = [];
    const seenUrls = new Set();

    for (const section of sections) {
        try {
            let sectionTitle = 'Unnamed Section';
            try {
                const sectionTitleElement = await section.findElement(By.css('.sectionname'));
                sectionTitle = await sectionTitleElement.getText();
            } catch (err) {
                log(`Section title not found, using default: ${sectionTitle}`);
            }
            log(`Enumerating section: ${sectionTitle}`);

            const sectionPath = path.join(coursePath, sanitizeFilename(sectionTitle));
            if (!fs.existsSync(sectionPath)) {
                fs.mkdirSync(sectionPath, { recursive: true });
            }

            const activities = await section.findElements(By.css('.activity'));

            for (const activity of activities) {
                const activityType = await activity.getAttribute('class');
                const activityId = await activity.getAttribute('id');
                log(`Processing activity with ID: ${activityId}, Type: ${activityType}`);

                const activityNameElement = await activity.findElement(By.css('.instancename'));
                const activityName = await activityNameElement.getText();
                const activityLink = await activityNameElement.findElement(By.xpath('..'));
                const activityUrl = await activityLink.getAttribute('href');

                if (!seenUrls.has(activityUrl)) {
                    seenUrls.add(activityUrl);

                    if (activityType.includes('modtype_resource') && (downloadMode === 'all' || downloadMode === 'resources-only')) {
                        log(`\x1b[32mFound resource:\x1b[0m ${activityName} at URL: ${activityUrl}`);
                        downloadList.push({ url: activityUrl, name: activityName, path: sectionPath });
                    } else if (activityType.includes('modtype_url') && (downloadMode === 'all' || downloadMode === 'resources-only')) {
                        log(`\x1b[35mFound link:\x1b[0m ${activityName} at URL: ${activityUrl}`);
                        downloadList.push({ url: activityUrl, name: activityName, path: sectionPath, isLink: true });
                    } else if (activityType.includes('modtype_forum') && (downloadMode === 'all' || downloadMode === 'forums-only')) {
                        log(`\x1b[34mFound forum:\x1b[0m ${activityName} at URL: ${activityUrl}`);
                        downloadList.push({ url: activityUrl, name: activityName, path: sectionPath, isForum: true });
                    } else if (activityType.includes('modtype_folder') && (downloadMode === 'all' || downloadMode === 'resources-only')) {
                        log(`\x1b[33mFound folder:\x1b[0m ${activityName} at URL: ${activityUrl}`);
                        downloadList.push({ url: activityUrl, name: activityName, path: sectionPath, isFolder: true });
                    } else {
                        log(`\x1b[31mSkipping unknown or unselected activity type:\x1b[0m ${activityType}`);
                    }
                } else {
                    log(`Skipping duplicate URL: ${activityUrl}`);
                }
            }
        } catch (err) {
            log(`Error processing section: ${err.message}`);
        }
    }

    log(`Total resources found: ${downloadList.length}`);
    return downloadList;
}

module.exports = { loginToMoodle, getCourseTitle, enumerateDownloads };
