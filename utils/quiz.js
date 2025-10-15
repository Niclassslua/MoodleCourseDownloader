const { By, until } = require('selenium-webdriver');
const fs = require('fs');
const path = require('path');
const inquirer = require('inquirer').default;
const { log } = require('./logger');
const { solveAndSubmitQuiz } = require('./solveQuiz');

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

async function runOpenAiSolve(driver) {
    try {
        const questions = await collectAttemptQuestions(driver);

        if (!questions.length) {
            log('No questions detected in attempt. Cannot invoke OpenAI solver.', {}, driver);
            return;
        }

        await solveAndSubmitQuiz(driver, questions);
        await finalizeAttempt(driver);
    } catch (err) {
        log('Failed to solve quiz attempt via OpenAI.', { error: err.message }, driver);
    }
}

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
                        log('Failed to extract label text for choice answer.', { error: err.message }, driver);
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

async function finalizeAttempt(driver) {
    try {
        const finishLinkElement = await driver.wait(until.elementLocated(By.css('.endtestlink')), 10000);
        const finishUrl = await finishLinkElement.getAttribute('href');
        log('Found completion link.', { finishUrl }, driver);

        await driver.get(finishUrl);
        log('Navigated to summary page to complete the quiz.', {}, driver);

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

        const outputPath = path.join(outputDir, `${sanitizedQuizTitle}.json`);
        try {
            fs.writeFileSync(outputPath, JSON.stringify({ quizTitle, questions: quizData }, null, 2));
            log('Quiz data saved successfully.', { path: outputPath });
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
            const isChecked = await answerElement.findElement(By.css('input')).isSelected();
            const labelElement = await answerElement.findElement(By.css('div[data-region="answer-label"]'));
            const answerText = await labelElement.getText();

            log('Parsed multiple-choice answer.', { text: answerText, isSelected, isChecked }, driver);
            answers.push({ text: answerText, isSelected, isChecked });
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
