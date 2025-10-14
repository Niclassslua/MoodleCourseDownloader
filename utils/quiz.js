const { By, until } = require('selenium-webdriver');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { log } = require('./logger');

async function scrapeQuiz(driver, quizUrl, outputDir) {
    try {
        const currentUrl = await driver.getCurrentUrl();
        log('Navigating to quiz URL.', { quizUrl, currentUrl }, driver);

        await driver.get(quizUrl);

        const pageSource = await driver.getPageSource();
        log('Page source fetched.', { currentUrl, pagePreview: pageSource.slice(0, 500) }, driver);

        const attemptSummary = await driver.findElements(By.css('.generaltable.quizattemptsummary'));
        log('Attempt summary status checked.', { attemptSummaryExists: attemptSummary.length > 0 }, driver);

        if (attemptSummary.length > 0) {
            await processAttempts(driver, attemptSummary, outputDir);
        } else {
            log('No previous quiz attempts found. Starting a new attempt.', {}, driver);

            try {
                const startButton = await driver.findElement(By.css('.singlebutton.quizstartbuttondiv button'));
                log('Found start button. Clicking to start the attempt.', {}, driver);
                await startButton.click();
                log('Attempt started. Extend logic to scrape during the attempt if needed.', {}, driver);
            } catch (err) {
                log('Failed to find or click start button.', { error: err.message }, driver);
            }
        }
    } catch (err) {
        log('Failed to scrape quiz.', { error: err.message }, driver);
    }
}

async function processAttempts(driver, attemptSummary, outputDir) {
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

                if (reviewMessage.includes("Nicht erlaubt.")) {
                    log('Review not allowed. Starting a new attempt.', {}, driver);
                    await startAndSubmitNewAttempt(driver, quizData, outputDir);
                    return; // Nach dem neuen Versuch abbrechen, da dieser verarbeitet wird.
                }

                if (status === 'In Bearbeitung') {
                    log('Attempt is in progress. Checking for completion link.', { rowIndex }, driver);
                    try {
                        await handleInProgressAttempt(driver, quizData, outputDir);
                        log('In-progress attempt handled successfully.', { rowIndex }, driver);
                    } catch (progressErr) {
                        log('Error handling in-progress attempt.', { rowIndex, error: progressErr.message }, driver);
                    }
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

async function startAndSubmitNewAttempt(driver, quizData, outputDir) {
    try {
        const startButton = await driver.findElement(By.css('.singlebutton.quizstartbuttondiv button'));
        log('Found start button for new attempt.', {}, driver);
        await startButton.click();
        log('New attempt started.', {}, driver);

        await handleInProgressAttempt(driver, quizData, outputDir);
        log('New attempt submitted and processed.', {}, driver);
    } catch (err) {
        log('Failed to start and submit a new attempt.', { error: err.message }, driver);
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

async function handleInProgressAttempt(driver, quizData, outputDir) {
    try {
        const finishLinkElement = await driver.wait(until.elementLocated(By.css('.endtestlink')), 10000);
        const finishUrl = await finishLinkElement.getAttribute('href');
        log('Found completion link.', { finishUrl }, driver);

        await driver.get(finishUrl);
        log('Navigated to summary page to complete the quiz.', {}, driver);

        await submitQuiz(driver);
        await extractQuizResults(driver, quizData, outputDir);
    } catch (err) {
        log('Failed to handle in-progress attempt.', { error: err.message }, driver);
    }
}

async function submitQuiz(driver) {
    try {
        // Warte auf das Formular mit der ID 'frm-finishattempt'
        const finishForm = await driver.wait(until.elementLocated(By.css('#frm-finishattempt')), 10000);
        log('Finish attempt form found.', {}, driver);

        // Klicke auf den Submit-Button des Formulars
        const finishButton = await finishForm.findElement(By.css('button[type="submit"]'));
        await finishButton.click();
        log('Clicked submit button in the form.', {}, driver);

        // Warte, bis das Modal erscheint
        const modal = await driver.wait(until.elementLocated(By.css('.modal-dialog')), 5000);
        log('Submission modal detected.', {}, driver);

        // Klicke auf den "Abgeben"-Button im Modal
        const modalSubmitButton = await modal.findElement(By.css('.modal-footer .btn-primary[data-action="save"]'));
        await modalSubmitButton.click();
        log('Clicked "Submit" button in modal.', {}, driver);

    } catch (err) {
        log('Failed to submit the quiz.', { error: err.message }, driver);
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
        // Quiz-Titel aus Breadcrumb extrahieren
        const breadcrumbLink = await driver.findElement(By.css('.breadcrumb-item a[aria-current="page"]'));
        const quizTitle = await breadcrumbLink.getText();
        const sanitizedQuizTitle = quizTitle.replace(/[^a-zA-Z0-9-_]/g, '_'); // Für Dateinamen

        log('Extracted quiz title.', { quizTitle, sanitizedQuizTitle });

        // Alle Fragen erneut abrufen, bevor sie verarbeitet werden
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
        // Frage-ID und Typ
        const questionId = await question.getAttribute('id');
        const questionTypeClass = await question.getAttribute('class');
        const questionType = questionTypeClass.match(/que\s(\w+)/)?.[1] || 'unknown';

        questionData.id = questionId;
        questionData.type = questionType;

        // Fragetext
        const questionTextElement = await question.findElement(By.css('.qtext'));
        questionData.text = await questionTextElement.getText();
        log('Question text fetched.', { id: questionId, text: questionData.text }, driver);

        // Extrahiere Antworten basierend auf Fragetyp
        if (questionType === 'match') {
            questionData.answers = await extractMatchAnswers(question, driver);
        } else if (questionType === 'multichoice') {
            questionData.answers = await extractMultipleChoiceAnswers(question, driver);
            questionData.choiceType = await detectChoiceType(question, driver); // "single" oder "multiple"
        } else {
            log('Unhandled question type.', { type: questionType }, driver);
        }

        // Feedback oder richtige Antworten
        try {
            const feedbackElement = await question.findElement(By.css('.rightanswer'));
            const rightAnswerText = await feedbackElement.getText();
            if (rightAnswerText.startsWith('Die richtige Antwort ist:')) {
                questionData.correctAnswer = rightAnswerText.replace('Die richtige Antwort ist: ', '').trim();
            } else if (rightAnswerText.startsWith('Die richtigen Antworten sind:')) {
                questionData.correctAnswers = rightAnswerText.replace('Die richtigen Antworten sind: ', '').split(',').map(a => a.trim());
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

            const selectedOptionElement = await row.findElement(By.css('select option[selected="selected"]'));
            const selectedOption = await selectedOptionElement.getText();

            log('Parsed match answer.', { field: fieldText, selectedOption }, driver);
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
        const inputType = await inputs[0].getAttribute('type');
        return inputType === 'radio' ? 'single' : 'multiple';
    } catch (err) {
        log('Error detecting choice type.', { error: err.message }, driver);
        return 'unknown';
    }
}

module.exports = { scrapeQuiz };