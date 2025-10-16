
const { By, until, Key } = require('selenium-webdriver');
const fs = require('fs');
const path = require('path');
const inquirer = require('inquirer').default;
const { log } = require('./logger');
const { solveAndSubmitQuiz } = require('./solveQuiz');
const { clickNextIfPossible } = require('./quizNav');

/**
 * Main entry for scraping/solving a Moodle quiz.
 */
async function scrapeQuiz(driver, quizUrl, outputDir, quizSolverMode = 'prompt') {
    try {
        const currentUrl = await driver.getCurrentUrl();
        log('Navigating to quiz URL.', { quizUrl, currentUrl }, driver);

        await driver.get(quizUrl);

        const pageSource = await driver.getPageSource();
        log('Page source fetched.', { currentUrl, pagePreview: pageSource.slice(0, 500) }, driver);

        const attemptSummary = await driver.findElements(By.css('.generaltable.quizattemptsummary'));
        log('Attempt summary status checked.', { attemptSummaryExists: attemptSummary.length > 0 }, driver);

        if (attemptSummary.length > 0) {
            await processAttempts(driver, attemptSummary, outputDir, quizSolverMode, quizUrl);
        } else {
            log('No previous quiz attempts found. Starting a new attempt.', {}, driver);
            await handleAttempt(driver, quizUrl, outputDir, quizSolverMode);
        }
    } catch (err) {
        log('Failed to scrape quiz.', { error: err.message }, driver);
    }
}

/**
 * Handle the attempt summary table (review existing attempts or start a new one).
 */
async function processAttempts(driver, attemptSummary, outputDir, quizSolverMode, quizUrl, options = {}) {
    const { allowOpenAttempts = true } = options;

    try {
        const rows = await driver.findElements(By.css('.generaltable.quizattemptsummary tbody tr'));
        log('Attempt summary rows fetched.', { rowsFound: rows.length }, driver);

        const quizData = [];
        let attemptFound = false;

        for (const [rowIndex, row] of rows.entries()) {
            log(`Processing row ${rowIndex + 1} of ${rows.length}.`, { rowIndex }, driver);

            try {
                const status = await getStatus(row, driver);
                log(`Row status fetched: ${status}`, { rowIndex, status }, driver);

                const reviewMessage = await getReviewMessage(row, driver);
                log(`Review message fetched: ${reviewMessage}`, { rowIndex, reviewMessage }, driver);

                if (reviewMessage.includes('Nicht erlaubt.')) {
                    if (!allowOpenAttempts) {
                        log('Review not allowed and interactive handling suppressed.', { rowIndex }, driver);
                        continue;
                    }

                    log('Review not allowed. Starting a new attempt.', {}, driver);
                    await handleAttempt(driver, quizUrl, outputDir, quizSolverMode);
                    return;
                }

                if (status === 'In Bearbeitung') {
                    if (!allowOpenAttempts) {
                        log('Attempt is in progress but handling is suppressed for this pass.', { rowIndex }, driver);
                        continue;
                    }

                    log('Attempt is in progress. Offering completion workflow.', { rowIndex }, driver);
                    await handleAttempt(driver, quizUrl, outputDir, quizSolverMode, { skipStart: true });
                    return;
                }

                try {
                    const linkProcessed = await processAttemptLink(driver, row, quizData, outputDir);
                    log('Attempt link processed.', { rowIndex, linkProcessed }, driver);

                    if (linkProcessed) {
                        attemptFound = true;
                        log('Attempt marked as found.', { rowIndex }, driver);
                    }
                } catch (linkErr) {
                    log('Error processing attempt link.', { rowIndex, error: linkErr.message }, driver);
                }
            } catch (rowErr) {
                log('Error processing row status.', { rowIndex, error: rowErr.message }, driver);
            }
        }

        if (!attemptFound) {
            log('No completed attempts with review links found.', { totalRows: rows.length }, driver);
        } else {
            log('Completed attempts with review links were processed.', { totalRows: rows.length }, driver);
        }
    } catch (err) {
        log('Error processing attempt summary.', { error: err.message }, driver);
    }
}

/**
 * Create or resume an attempt and solve it (manual or OpenAI).
 */
async function handleAttempt(driver, quizUrl, outputDir, quizSolverMode, options = {}) {
    const { skipStart = false } = options;

    const mode = await resolveQuizSolverMode(quizSolverMode, driver);
    log('Selected quiz solver mode.', { mode }, driver);

    if (!mode) {
        log('No solver mode selected. Aborting attempt handling.', {}, driver);
        return;
    }

    if (!skipStart) {
        const started = await startAttempt(driver);
        if (!started) {
            return;
        }
    } else {
        await ensureAttemptInterfaceReady(driver);
    }

    if (mode === 'manual') {
        await runManualSolve(driver);
    } else if (mode === 'openai') {
        await runOpenAiSolve(driver);
    }

    await refreshAttemptSummary(driver, quizUrl, outputDir, quizSolverMode);
}

async function startAttempt(driver) {
    try {
        const startButton = await driver.findElement(By.css('.singlebutton.quizstartbuttondiv button'));
        log('Found start button. Clicking to start the attempt.', {}, driver);
        await startButton.click();
        await ensureAttemptInterfaceReady(driver);
        log('Attempt started and question interface detected.', {}, driver);
        return true;
    } catch (err) {
        log('Failed to find or click start button.', { error: err.message }, driver);
        return false;
    }
}

async function ensureAttemptInterfaceReady(driver) {
    try {
        await driver.wait(until.elementLocated(By.css('.que')), 10000);
    } catch (err) {
        log('Question elements did not load in time.', { error: err.message }, driver);
        throw err;
    }
}

/**
 * Decide the solver mode based on user preference / TTY availability.
 */
async function resolveQuizSolverMode(preferredMode = 'prompt') {
    const normalized = typeof preferredMode === 'string' ? preferredMode.toLowerCase() : 'prompt';

    if (normalized === 'manual' || normalized === 'openai') {
        return normalized;
    }

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        log('TTY not available for interactive quiz solver selection. Defaulting to manual mode.');
        return 'manual';
    }

    try {
        const { mode } = await inquirer.prompt([
            {
                type: 'list',
                name: 'mode',
                message: 'Wie soll der Quiz-Versuch behandelt werden?',
                choices: [
                    { name: 'Ich löse den Versuch manuell im Browser', value: 'manual' },
                    { name: 'OpenAI API soll den Versuch automatisch lösen', value: 'openai' },
                ],
            },
        ]);

        return mode;
    } catch (err) {
        log('Quiz solver prompt aborted. Defaulting to manual mode.', { error: err.message });
        return 'manual';
    }
}

async function runManualSolve(driver) {
    log('Manual quiz solving selected. Complete the attempt in the browser and submit it.', {}, driver);

    if (process.stdin.isTTY && process.stdout.isTTY) {
        await inquirer.prompt([
            {
                type: 'confirm',
                name: 'completed',
                message: 'Hast du den Versuch abgegeben und befindest dich wieder auf der Zusammenfassungsseite?',
                default: true,
            },
        ]);
    } else {
        log('TTY not available for confirmation prompt. Pausing briefly before continuing.', {}, driver);
        await driver.sleep(15000);
    }
}

async function hasSelectableInputs(driver) {
    const { By } = require('selenium-webdriver');
    const inputs = await driver.findElements(By.css(
        '.que input[type="radio"]:not([disabled]), .que input[type="checkbox"]:not([disabled]), .que select:not([disabled])'
    ));
    return inputs.length > 0;
}

async function getAttemptContext(driver) {
    const url = await driver.getCurrentUrl();
    const m = url.match(/attempt=(\d+)/);
    const attemptId = m ? m[1] : null;
    const pageMatch = url.match(/[?&]page=(\d+)/);
    const page = pageMatch ? parseInt(pageMatch[1], 10) : 0;
    return { url, attemptId, page };
}

async function runOpenAiSolve(driver) {
    try {
        const seen = new Map(); // key=attemptId|page -> count

        while (true) {
            const { url, attemptId, page } = await getAttemptContext(driver);

            // 0) Seitentyp prüfen
            if (/\/mod\/quiz\/summary\.php/.test(url) || /\/mod\/quiz\/review\.php/.test(url)) {
                await log('Summary/Review reached. Finishing loop.', { url }, driver);
                break;
            }
            if (!/\/mod\/quiz\/attempt\.php/.test(url)) {
                // Nicht auf einer Attempt-Seite → versuche Finish-Flow
                await log('Not on attempt page, trying to finish attempt flow.', { url }, driver);
                await finishAttemptFlow(driver);
                break;
            }

            // 1) Anti-Loop (gleiche Attempt-Seite wiederholt)
            const key = `${attemptId || 'na'}|${page}`;
            seen.set(key, (seen.get(key) || 0) + 1);
            if (seen.get(key) >= 3) {
                await log('Same attempt page repeated 3x. Breaking to avoid submit loop.', { attemptId, page, url }, driver);
                // versuche sauber zu beenden
                await finishAttemptFlow(driver);
                break;
            }

            // 2) Fragen einsammeln nur wenn Inputs wählbar
            const selectable = await hasSelectableInputs(driver);
            let questions = [];
            if (selectable) {
                questions = await collectAttemptQuestions(driver);
            } else {
                await log('No selectable inputs on this page. Skipping solver.', { url }, driver);
            }

            if (questions.length) {
                await log('Solving current page with OpenAI...', { count: questions.length }, driver);
                // WICHTIG: solveAndSubmitQuiz soll NUR Antworten setzen, NICHT submitten!
                const applied = await solveAndSubmitQuiz(driver, questions);
                if (!applied) {
                    await log('Solver did not apply any answers on this page.', { url }, driver);
                }
            } else {
                await log('No questions detected (or unsupported) on this page.', { url }, driver);
            }

            // 3) Nur „Weiter“ versuchen – KEIN zusätzliches Submit / Form-Submit
            const moved = await clickNextIfPresent(driver);
            if (moved) {
                const after = await driver.getCurrentUrl();
                if (/\/mod\/quiz\/attempt\.php/.test(after)) {
                    continue; // nächste Seite lösen
                }
                if (/\/mod\/quiz\/summary\.php|\/mod\/quiz\/review\.php/.test(after)) {
                    await log('Reached summary/review after next. Finishing...', {}, driver);
                    break;
                }
            }

            // 4) Kein "Weiter" verfügbar → Versuch beenden (Summary + Modal)
            await log('No next button present. Finishing attempt...', {}, driver);
            await finishAttemptFlow(driver);
            break;
        }
    } catch (err) {
        log('Failed to solve quiz attempt via OpenAI.', { error: err.message }, driver);
    }
}

/**
 * Persist the current page answers by clicking "Speichern und weiter" or submitting #responseform.
 */
async function saveAttemptPage(driver) {
    try {
        // Preferred: explicit "Speichern und weiter"
        const nextBtns = await driver.findElements(By.css('input.mod_quiz-next-nav, button.mod_quiz-next-nav'));
        if (nextBtns.length) {
            await driver.executeScript('arguments[0].scrollIntoView({block:"center"});', nextBtns[0]);
            await driver.sleep(100); // give the browser a moment to settle
            await nextBtns[0].click();
            // wait briefly for navigation or save
            await driver.sleep(600);
            return true;
        }

        // Fallback: submit the response form directly
        const forms = await driver.findElements(By.css('form#responseform'));
        if (forms.length) {
            await driver.executeScript(`
                arguments[0].dispatchEvent(new Event('submit', {bubbles:true}));
                arguments[0].submit();
            `, forms[0]);
            await driver.sleep(600);
            return true;
        }

        return false;
    } catch (err) {
        log('Error while trying to save attempt page.', { error: err.message }, driver);
        return false;
    }
}

/**
 * Collect question text/options to pass into the solver.
 */
async function collectAttemptQuestions(driver) {
    const questions = [];

    try {
        const questionElements = await driver.findElements(By.css('.que'));
        log('Collecting question data for OpenAI solver.', { count: questionElements.length }, driver);

        for (const questionElement of questionElements) {
            const questionId = await questionElement.getAttribute('id');
            const questionTypeClass = await questionElement.getAttribute('class');
            const questionType = questionTypeClass.match(/que\s(\w+)/)?.[1] || 'unknown';
            const questionTextElement = await questionElement.findElement(By.css('.qtext'));
            const questionText = await questionTextElement.getText();

            const questionData = {
                id: questionId,
                type: questionType,
                text: questionText,
            };

            if (questionType === 'match') {
                const rows = await questionElement.findElements(By.css('.answer tbody tr'));
                const answers = [];
                const optionsSet = new Set();

                for (const row of rows) {
                    const fieldElement = await row.findElement(By.css('td.text'));
                    const fieldText = (await fieldElement.getText()).trim();
                    const selectElement = await row.findElement(By.css('select'));
                    const optionElements = await selectElement.findElements(By.css('option'));
                    const optionTexts = [];

                    for (const optionElement of optionElements) {
                        const optionText = (await optionElement.getText()).trim();
                        if (optionText) {
                            optionTexts.push(optionText);
                            optionsSet.add(optionText);
                        }
                    }

                    let selectedOption = '';
                    try {
                        const selectedOptionElement = await selectElement.findElement(By.css('option[selected="selected"]'));
                        selectedOption = (await selectedOptionElement.getText()).trim();
                    } catch (err) {
                        // No preselection is expected before the question is answered.
                    }

                    answers.push({ field: fieldText, selectedOption, options: optionTexts });
                }

                questionData.answers = answers;
                questionData.choicePool = Array.from(optionsSet);
            } else if (questionType === 'multichoice') {
                const answerElements = await questionElement.findElements(By.css('.answer .r0, .answer .r1'));
                const answers = [];

                for (const [index, answerElement] of answerElements.entries()) {
                    let labelText = '';
                    try {
                        const labelElement = await answerElement.findElement(By.css('div[data-region="answer-label"]'));
                        labelText = await labelElement.getText();
                    } catch (err) {
                        try {
                            labelText = await answerElement.getText();
                        } catch (fallbackErr) {
                            log('Failed to extract label text for choice answer.', { error: err.message, fallbackError: fallbackErr.message }, driver);
                        }
                    }

                    answers.push({ text: labelText.trim(), value: String.fromCharCode(65 + index) });
                }

                questionData.answers = answers;
                questionData.choiceType = await detectChoiceType(questionElement, driver);
            } else {
                log('Encountered unsupported question type during collection.', { questionType }, driver);
            }

            questions.push(questionData);
        }
    } catch (err) {
        log('Error while collecting attempt questions.', { error: err.message }, driver);
    }

    return questions;
}

async function clickNextIfPresent(driver) {
    try {
        return await clickNextIfPossible(driver);
    } catch (err) {
        await log('Error while trying to click next button.', { error: err.message }, driver);
        return false;
    }
}

async function finishAttemptFlow(driver) {
    try {
        const currentUrl = await driver.getCurrentUrl();

        if (/\/mod\/quiz\/review\.php/.test(currentUrl)) {
            await log('Review page already reached. No additional actions required.', { currentUrl }, driver);
            return true;
        }

        if (/\/mod\/quiz\/attempt\.php/.test(currentUrl)) {
            await log('Attempt page detected. Preparing to navigate to summary.', { currentUrl }, driver);
            await reportNavigationStatus(driver);

            const navigated = await navigateToSummary(driver);
            if (!navigated) {
                await log('Unable to reach summary page from attempt.', { currentUrl }, driver);
                return false;
            }
        }

        const summaryReached = await driver.getCurrentUrl();
        if (/\/mod\/quiz\/summary\.php/.test(summaryReached)) {
            await log('Summary page reached. Validating question statuses before submission.', { summaryReached }, driver);
            const allSaved = await verifySummaryStatuses(driver);
            if (!allSaved) {
                await log('Summary indicates unanswered questions. Returning to attempt page.', { summaryReached }, driver);
                await returnToAttemptFromSummary(driver);
                return false;
            }

            await log('All questions are marked as answered. Submitting attempt.', {}, driver);
            await submitQuiz(driver);

            try {
                await driver.wait(async () => {
                    const url = await driver.getCurrentUrl();
                    return /\/mod\/quiz\/(review|summary)\.php/.test(url);
                }, 10000);
            } catch (waitErr) {
                await log('Timeout while waiting for post-submission page.', { error: waitErr.message }, driver);
            }

            return true;
        }

        await log('finishAttemptFlow invoked on an unexpected page.', { currentUrl: summaryReached }, driver);
        return false;
    } catch (err) {
        await log('Error in finishAttemptFlow.', { error: err.message }, driver);
        return false;
    }
}

async function reportNavigationStatus(driver) {
    try {
        const status = await driver.executeScript(() => {
            const buttons = Array.from(document.querySelectorAll('#mod_quiz_navblock .qnbutton'));
            return buttons.map((button) => {
                const title = button.getAttribute('title') || '';
                const label = button.textContent?.replace(/\s+/g, ' ').trim() || '';
                return {
                    id: button.id || null,
                    label,
                    title,
                    className: button.className || '',
                };
            });
        });

        const unanswered = status
            .filter((entry) => isMarkedUnanswered(entry.className, entry.title))
            .map((entry) => entry.label);

        await log('Collected quiz navigation status.', { unanswered }, driver);
    } catch (err) {
        await log('Failed to collect navigation status.', { error: err.message }, driver);
    }
}

function isMarkedUnanswered(className = '', title = '') {
    const combined = `${className} ${title}`.toLowerCase();
    return (
        combined.includes('notyetanswered') ||
        combined.includes('nicht beantwortet') ||
        combined.includes('not answered') ||
        combined.includes('bisher nicht beantwortet')
    );
}

async function navigateToSummary(driver) {
    const attemptSelectors = [
        'form#responseform input[name="next"]',
        'form#responseform button[name="next"]',
        'input.mod_quiz-next-nav',
        'button.mod_quiz-next-nav',
        'a.endtestlink',
    ];

    for (const selector of attemptSelectors) {
        const elements = await driver.findElements(By.css(selector));
        for (const element of elements) {
            try {
                const candidate = (await element.getAttribute('value')) || (await element.getText()) || '';
                const normalized = candidate.toLowerCase();
                if (
                    normalized.includes('abschließ') ||
                    normalized.includes('finish') ||
                    normalized.includes('versuch abschließen') ||
                    normalized.includes('versuch beenden')
                ) {
                    await driver.executeScript('arguments[0].scrollIntoView({block:"center"});', element);
                    await driver.sleep(100);
                    await element.click();
                    try {
                        await driver.wait(until.urlContains('/mod/quiz/summary.php'), 10000);
                    } catch (err) {
                        await log('Navigation to summary timed out after clicking finish control.', { error: err.message }, driver);
                    }
                    return /\/mod\/quiz\/summary\.php/.test(await driver.getCurrentUrl());
                }
            } catch (err) {
                await log('Failed to evaluate finish control candidate.', { selector, error: err.message }, driver);
            }
        }
    }

    return false;
}

async function verifySummaryStatuses(driver) {
    try {
        const summary = await driver.executeScript(() => {
            const rows = Array.from(document.querySelectorAll('table.quizsummaryofattempt tbody tr'));
            return rows
                .map((row) => {
                    const classes = row.className || '';
                    if (/quizsummaryheading/.test(classes)) {
                        return null;
                    }
                    const question = row.querySelector('td.c0')?.textContent?.replace(/\s+/g, ' ').trim() || '';
                    const status = row.querySelector('td.c1')?.textContent?.replace(/\s+/g, ' ').trim() || '';
                    return question ? { question, status, classes } : null;
                })
                .filter(Boolean);
        });

        if (!summary.length) {
            await log('No summary rows detected; assuming nothing to validate.', {}, driver);
            return true;
        }

        const pending = summary.filter((entry) => !isStatusSaved(entry.status, entry.classes));
        if (pending.length) {
            await log('Summary rows without saved answers detected.', { pending }, driver);
            return false;
        }

        return true;
    } catch (err) {
        await log('Failed to evaluate summary table.', { error: err.message }, driver);
        return false;
    }
}

function isStatusSaved(status = '', className = '') {
    const normalized = `${status} ${className}`.toLowerCase();
    if (!normalized.trim()) {
        return false;
    }
    return (
        normalized.includes('antwort gespeichert') ||
        normalized.includes('complete') ||
        normalized.includes('beantwortet') ||
        normalized.includes('answered')
    );
}

async function returnToAttemptFromSummary(driver) {
    const selectors = [
        'form[action*="mod/quiz/attempt.php"] button[type="submit"]',
        'form[action*="mod/quiz/attempt.php"] input[type="submit"]',
        'a.endtestlink',
    ];

    for (const selector of selectors) {
        const elements = await driver.findElements(By.css(selector));
        if (!elements.length) {
            continue;
        }
        try {
            await elements[0].click();
            await driver.wait(until.urlContains('/mod/quiz/attempt.php'), 10000);
            return true;
        } catch (err) {
            await log('Failed to navigate back to attempt page from summary.', { selector, error: err.message }, driver);
        }
    }

    return false;
}

/**
 * Click the "finish attempt" link and complete submission (modal).
 * IMPORTANT: click instead of driver.get() to trigger Moodle's JS handlers.
 */
async function finalizeAttempt(driver) {
    try {
        const finishLinkElement = await driver.wait(until.elementLocated(By.css('.endtestlink')), 10000);
        // Click instead of navigate to ensure onClick handlers fire
        await driver.executeScript('arguments[0].scrollIntoView({block:"center"});', finishLinkElement);
        await finishLinkElement.click();
        log('Navigated to summary page to complete the quiz (via click).', {}, driver);

        await submitQuiz(driver);

        try {
            await driver.wait(until.elementLocated(By.css('.generaltable.quizattemptsummary')), 10000);
        } catch (summaryErr) {
            log('Quiz summary did not appear after submission within expected time.', { error: summaryErr.message }, driver);
        }
    } catch (err) {
        log('Failed to handle in-progress attempt.', { error: err.message }, driver);
    }
}

/**
 * Refresh the attempt summary and parse results.
 */
async function refreshAttemptSummary(driver, quizUrl, outputDir, quizSolverMode, options = {}) {
    const { skipReload = false } = options;

    let attemptSummary = await driver.findElements(By.css('.generaltable.quizattemptsummary'));

    if (!attemptSummary.length && !skipReload) {
        await driver.get(quizUrl);
        attemptSummary = await driver.findElements(By.css('.generaltable.quizattemptsummary'));
    }

    if (!attemptSummary.length) {
        log('Attempt summary table not found after returning to quiz.', {}, driver);
        return;
    }

    await processAttempts(driver, attemptSummary, outputDir, quizSolverMode, quizUrl, { allowOpenAttempts: false });
}

/** Helpers to parse the summary table **/
async function getReviewMessage(row, driver) {
    try {
        const reviewCell = await row.findElement(By.css('td:last-child'));
        const reviewMessage = await reviewCell.getText();
        return reviewMessage.trim();
    } catch (err) {
        log('Error fetching review message.', { error: err.message }, driver);
        return '';
    }
}

async function getStatus(row, driver) {
    try {
        const statusCell = await row.findElement(By.css('td:nth-child(2)')).getText();
        const status = statusCell.trim();
        log('Row status fetched successfully.', { status }, driver);
        return status;
    } catch (err) {
        log('Error fetching row status.', { error: err.message }, driver);
        throw err;
    }
}

async function processAttemptLink(driver, row, quizData, outputDir) {
    try {
        const attemptLink = await row.findElement(By.css('a[title*="Überprüfung"]')).getAttribute('href');
        log('Attempt review link found.', { attemptLink }, driver);

        log('Navigating to attempt review page.', { attemptLink }, driver);
        await driver.get(attemptLink);

        log('Extracting results from the review page.', {}, driver);
        await extractQuizResults(driver, quizData, outputDir);

        return true;
    } catch (err) {
        log('No review link found for attempt.', { error: err.message }, driver);
        return false;
    }
}

/**
 * Extract the graded results from a finished attempt review page.
 */
async function extractQuizResults(driver, quizData, outputDir) {
    try {
        const breadcrumbLink = await driver.findElement(By.css('.breadcrumb-item a[aria-current="page"]'));
        const quizTitle = await breadcrumbLink.getText();
        const sanitizedQuizTitle = quizTitle.replace(/[^a-zA-Z0-9-_]/g, '_');

        log('Extracted quiz title.', { quizTitle, sanitizedQuizTitle });

        const questions = await driver.wait(until.elementsLocated(By.css('.que')), 10000);
        log('Found questions.', { count: questions.length });

        for (let i = 0; i < questions.length; i++) {
            try {
                const refreshedQuestions = await driver.findElements(By.css('.que'));
                const question = refreshedQuestions[i];
                const questionData = await extractQuestionData(question, driver);
                quizData.push(questionData);
                log('Added question to quizData.', { questionData });
            } catch (err) {
                log(`Error extracting data for question ${i + 1}.`, { error: err.message });
            }
        }

        log('Extraction completed. Preparing to save quiz data.', { additionalData: quizData });

        if (quizData.length === 0) {
            log('Quiz data is empty. Nothing to save.', {});
            return;
        }

        if (!fs.existsSync(outputDir)) {
            log('Output directory missing. Creating...', { outputDir });
            fs.mkdirSync(outputDir, { recursive: true });
        }

        // Use a robust write path
        const filePath = path.join(outputDir, `${sanitizedQuizTitle}.json`);
        try {
            fs.writeFileSync(filePath, JSON.stringify({ quizTitle, questions: quizData }, null, 2));
            log('Quiz data saved successfully.', { path: filePath });
        } catch (err) {
            log('Failed to save quiz data.', { error: err.message });
        }
    } catch (err) {
        log('Failed to extract quiz results.', { error: err.message });
    }
}

async function extractQuestionData(question, driver) {
    const questionData = {};
    try {
        const questionId = await question.getAttribute('id');
        const questionTypeClass = await question.getAttribute('class');
        const questionType = questionTypeClass.match(/que\s(\w+)/)?.[1] || 'unknown';

        questionData.id = questionId;
        questionData.type = questionType;

        const questionTextElement = await question.findElement(By.css('.qtext'));
        questionData.text = await questionTextElement.getText();
        log('Question text fetched.', { id: questionId, text: questionData.text }, driver);

        if (questionType === 'match') {
            questionData.answers = await extractMatchAnswers(question, driver);
        } else if (questionType === 'multichoice') {
            questionData.answers = await extractMultipleChoiceAnswers(question, driver);
            questionData.choiceType = await detectChoiceType(question, driver);
        } else {
            log('Unhandled question type.', { type: questionType }, driver);
        }

        try {
            const feedbackElement = await question.findElement(By.css('.rightanswer'));
            const rightAnswerText = await feedbackElement.getText();
            if (rightAnswerText.startsWith('Die richtige Antwort ist:')) {
                questionData.correctAnswer = rightAnswerText.replace('Die richtige Antwort ist: ', '').trim();
            } else if (rightAnswerText.startsWith('Die richtigen Antworten sind:')) {
                questionData.correctAnswers = rightAnswerText
                    .replace('Die richtigen Antworten sind: ', '')
                    .split(',')
                    .map(a => a.trim());
            }
        } catch (err) {
            log('No feedback or right answer found for the question.', { id: questionId }, driver);
        }
    } catch (err) {
        log('Error extracting question data.', { error: err.message, id: questionData.id }, driver);
    }
    return questionData;
}

async function extractMatchAnswers(question, driver) {
    const answers = [];
    try {
        const rows = await question.findElements(By.css('.answer tbody tr'));
        log('Extracting match answers.', { questionId: await question.getAttribute('id'), rowCount: rows.length }, driver);

        for (const row of rows) {
            const fieldElement = await row.findElement(By.css('td.text'));
            const fieldText = await fieldElement.getText();

            let selectedOption = '';
            try {
                const selectedOptionElement = await row.findElement(By.css('select option[selected="selected"]'));
                selectedOption = await selectedOptionElement.getText();
            } catch (err) {
                log('No selected option found while extracting match answers.', { error: err.message }, driver);
            }

            answers.push({ field: fieldText, selectedOption });
        }
    } catch (err) {
        log('Error extracting match answers.', { error: err.message }, driver);
    }
    return answers;
}

async function extractMultipleChoiceAnswers(question, driver) {
    const answers = [];
    try {
        const answerElements = await question.findElements(By.css('.answer .r0, .answer .r1'));
        log('Extracting multiple-choice answers.', { questionId: await question.getAttribute('id'), answerCount: answerElements.length }, driver);

        for (const answerElement of answerElements) {
            const isSelected = (await answerElement.getAttribute('class')).includes('correct');
            const inputEl = await answerElement.findElement(By.css('input'));
            const isChecked = await inputEl.isSelected();
            let answerText = '';
            try {
                const labelElement = await answerElement.findElement(By.css('div[data-region="answer-label"]'));
                answerText = await labelElement.getText();
            } catch {
                answerText = await answerElement.getText();
            }

            log('Parsed multiple-choice answer.', { text: answerText.trim(), isSelected, isChecked }, driver);
            answers.push({ text: answerText.trim(), isSelected, isChecked });
        }
    } catch (err) {
        log('Error extracting multiple-choice answers.', { error: err.message }, driver);
    }
    return answers;
}

async function detectChoiceType(question, driver) {
    try {
        const inputs = await question.findElements(By.css('.answer input[type="radio"], .answer input[type="checkbox"]'));
        if (!inputs.length) {
            return 'unknown';
        }
        const inputType = await inputs[0].getAttribute('type');
        return inputType === 'radio' ? 'single' : 'multiple';
    } catch (err) {
        log('Error detecting choice type.', { error: err.message }, driver);
        return 'unknown';
    }
}

/**
 * Submit the attempt on the summary page (handles confirmation modal).
 */
async function submitQuiz(driver) {
    try {
        const finishForm = await driver.wait(until.elementLocated(By.css('#frm-finishattempt')), 10000);
        log('Finish attempt form found.', {}, driver);

        const finishButton = await finishForm.findElement(By.css('button[type="submit"]'));
        await finishButton.click();
        log('Clicked submit button in the form.', {}, driver);

        const modal = await driver.wait(until.elementLocated(By.css('.modal-dialog')), 5000);
        log('Submission modal detected.', {}, driver);

        const modalSubmitButton = await modal.findElement(By.css('.modal-footer .btn-primary[data-action="save"]'));
        await modalSubmitButton.click();
        log('Clicked "Submit" button in modal.', {}, driver);
    } catch (err) {
        log('Failed to submit the quiz.', { error: err.message }, driver);
        throw err;
    }
}

module.exports = { scrapeQuiz };
