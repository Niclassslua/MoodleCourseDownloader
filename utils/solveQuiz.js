const { log } = require('./logger');
const { By } = require('selenium-webdriver');
const OpenAI = require('openai');

// ANSI color codes
const reset = "\x1b[0m";
const bright = "\x1b[1m";
const dim = "\x1b[2m";
const underscore = "\x1b[4m";
const blink = "\x1b[5m";
const reverse = "\x1b[7m";
const hidden = "\x1b[8m";

const fg = {
    black: "\x1b[30m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    magenta: "\x1b[35m",
    cyan: "\x1b[36m",
    white: "\x1b[37m",
};

const bg = {
    black: "\x1b[40m",
    red: "\x1b[41m",
    green: "\x1b[42m",
    yellow: "\x1b[43m",
    blue: "\x1b[44m",
    magenta: "\x1b[45m",
    cyan: "\x1b[46m",
    white: "\x1b[47m",
};

// Initialize OpenAI client
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

async function solveAndSubmitQuiz(driver, questions) {
    try {
        const userPrompt = generateBatchPrompt(questions);
        console.log(`${fg.cyan}Generated batch prompt:${reset}\n${userPrompt}\n`);

        const systemPrompt = `
            You are a strict JSON generator for quiz questions. Always output a single valid JSON object and nothing else.

            For match questions:
            - Return one object for every field that appears in the prompt.
            - Use the exact option text from the provided list (case-sensitive, excluding placeholder entries such as "Auswählen ...").
            - If you are unsure, choose the most plausible option — never leave the array empty and never omit a field.

            For multiple-choice questions:
            - Return the letters of all answers that should be selected as an array, e.g. ["A", "C"].
            - If you believe no option should be selected, return an empty array.

            For single-choice questions:
            - Return exactly one letter wrapped in an array, e.g. ["A"].

            Example output:
            {
              "answers": [
                {
                  "id": "question-1",
                  "type": "match",
                  "response": [
                    {"field": "float", "selectedOption": "32 bit"},
                    {"field": "int", "selectedOption": "64 bit"}
                  ]
                },
                {
                  "id": "question-2",
                  "type": "multichoice",
                  "response": ["A", "C"]
                },
                {
                  "id": "question-3",
                  "type": "single",
                  "response": ["A"]
                }
              ]
            }

            Always adhere strictly to this structure. Respond with valid JSON only.
        `.trim();

        const response = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            max_tokens: 2000,
        });

        const responseContent = response.choices[0]?.message?.content;
        console.log(`${fg.cyan}OpenAI Response:${reset}\n${responseContent}\n`);

        const parsedAnswers = parseBatchResponse(responseContent, questions);
        console.log(`${fg.green}Parsed answers:${reset}\n`, parsedAnswers);

        let appliedAnswerCount = 0;

        // Handle parsed answers
        for (let i = 0; i < questions.length; i++) {
            const question = questions[i];
            const answer = parsedAnswers[i];

            if (!answer || (Array.isArray(answer) && !answer.length)) {
                log('No valid answer parsed for question.', { questionId: question.id });
                continue;
            }

            if (question.type === 'match') {
                const expectedFields = Array.isArray(question.answers)
                    ? question.answers.map((entry) => entry.field.trim())
                    : [];
                const returnedFields = new Set(answer.map((entry) => entry.field));

                const missing = expectedFields.filter((field) => !returnedFields.has(field));
                if (missing.length) {
                    log('Match answer is missing fields. Skipping automated selection for this question.', { questionId: question.id, missing });
                    continue;
                }

                const handled = await handleMatchQuestion(driver, question, answer);
                if (handled) {
                    appliedAnswerCount += 1;
                }
            } else {
                const handled = await handleChoiceQuestion(driver, question, answer);
                if (handled) {
                    appliedAnswerCount += 1;
                }
            }
        }

        if (appliedAnswerCount === 0) {
            console.warn(`${fg.yellow}No actionable answers were applied; skipping submit button click.${reset}`);
            return;
        }

        try {
            console.log(`${fg.yellow}Finding submit button${reset}`);
            const submitButton = await driver.findElement(By.css('button[type="submit"]'));
            console.log(`${fg.yellow}Clicking submit button${reset}`);
            await submitButton.click();
        } catch (submitErr) {
            console.warn(`${fg.yellow}No immediate submit button found; continuing without clicking.${reset}`);
        }
    } catch (err) {
        console.error(`${fg.red}Error in solveAndSubmitQuiz: ${err.message}${reset}`);
    }
}


function generateBatchPrompt(questions) {
    return questions
        .map((q, i) => {
            const header = `Question ${i + 1} (ID: ${q.id})`;

            if (q.type === 'match') {
                const fieldList = q.answers
                    .map(answer => `- ${answer.field}`)
                    .join('\n');
                const optionPool = Array.from(
                    new Set(
                        (q.choicePool && q.choicePool.length
                            ? q.choicePool
                            : q.answers.flatMap(answer => answer.options || []))
                            .filter(Boolean)
                    )
                );
                const optionList = optionPool.length
                    ? optionPool.map(option => `- ${option}`).join('\n')
                    : '- (no options detected)';

                return [
                    header,
                    'Type: match',
                    `Prompt: ${q.text}`,
                    'Fields:',
                    fieldList,
                    'Options:',
                    optionList,
                    'Respond with: [{"field": "...", "selectedOption": "..."}] covering every field exactly once for this question ID.',
                ].join('\n');
            }

            if (q.type === 'multichoice') {
                const options = q.answers
                    .map((answer, index) => `${String.fromCharCode(65 + index)}. ${answer.text}`)
                    .join('\n');
                const isMultiple = q.choiceType === 'multiple';
                const selectionHint = isMultiple
                    ? 'Respond with all correct letters in an array, e.g. ["A", "C"].'
                    : 'Respond with a single letter inside an array, e.g. ["B"].';

                return [
                    header,
                    `Type: ${isMultiple ? 'multiple choice' : 'single choice'}`,
                    `Prompt: ${q.text}`,
                    'Options:',
                    options,
                    'Return the answer using this question ID exactly.',
                    selectionHint,
                ].join('\n');
            }

            return [
                header,
                `Type: ${q.type}`,
                `Prompt: ${q.text}`,
                'No automated instructions available for this question type. Respond with an empty response array.',
            ].join('\n');
        })
        .join('\n\n');
}

function parseBatchResponse(responseContent, questions) {
    try {
        const parsed = JSON.parse(responseContent.trim());
        if (!parsed.answers || !Array.isArray(parsed.answers)) {
            console.error(`${fg.red}Invalid response structure:${reset}`, parsed);
            return questions.map(() => null);
        }

        return questions.map((q) => {
            const answer = parsed.answers.find((a) => a.id === q.id);
            if (!answer) return null;

            if (q.type === 'match' && Array.isArray(answer.response)) {
                return answer.response
                    .filter((pair) => pair && typeof pair.field === 'string' && typeof pair.selectedOption === 'string')
                    .map((pair) => ({
                        field: pair.field.trim(),
                        selectedOption: pair.selectedOption.trim(),
                    }));
            }

            if ((q.type === 'multichoice' || q.type === 'single') && Array.isArray(answer.response)) {
                return answer.response
                    .filter((entry) => typeof entry === 'string' && entry.trim().length)
                    .map((entry) => entry.trim().toUpperCase());
            }

            console.warn(`${fg.yellow}No valid data for question ${q.id}${reset}`);
            return null;
        });
    } catch (err) {
        console.error(`${fg.red}Failed to parse batch response: ${err.message}${reset}`);
        return questions.map(() => null);
    }
}

async function handleMatchQuestion(driver, question, answer) {
    const normalizeField = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

    try {
        const rows = await driver.findElements(By.css(`#${question.id} .answer tbody tr`));
        const rowMap = new Map();
        let applied = false;

        for (const row of rows) {
            try {
                const fieldElement = await row.findElement(By.css('td.text'));
                const fieldLabel = normalizeField(await fieldElement.getText());
                if (fieldLabel) {
                    rowMap.set(fieldLabel, row);
                }
            } catch (err) {
                log('Failed to index match row.', { questionId: question.id, error: err.message });
            }
        }

        for (const pair of answer) {
            if (!pair.selectedOption || pair.selectedOption.toLowerCase().includes('auswählen')) {
                log('Skipping placeholder option for match question.', { questionId: question.id, field: pair.field, selectedOption: pair.selectedOption });
                continue;
            }
            const row = rowMap.get(normalizeField(pair.field));
            if (!row) {
                log('Unable to locate row for match field.', { questionId: question.id, field: pair.field });
                continue;
            }
            const select = await row.findElement(By.css('select'));
            await select.sendKeys(pair.selectedOption);
            log('Match answer selected.', { questionId: question.id, field: pair.field, selectedOption: pair.selectedOption });
            applied = true;
        }
        return applied;
    } catch (err) {
        log('Error handling match question.', { error: err.message, questionId: question.id });
        return false;
    }
}

async function handleChoiceQuestion(driver, question, answer) {
    try {
        const answers = await driver.findElements(By.css(`#${question.id} .answer .r0, #${question.id} .answer .r1`));

        if (!answers.length) {
            log('No choice options located for question.', { questionId: question.id });
            return false;
        }

        const normalized = Array.isArray(answer)
            ? answer.map((opt) => (typeof opt === 'string' ? opt.trim().toUpperCase() : '')).filter(Boolean)
            : [];

        const isMultiple = question.choiceType === 'multiple';
        if (!normalized.length) {
            log('No answer content provided for choice question.', { questionId: question.id });
            return false;
        }

        if (isMultiple) {
            const desired = new Set(normalized);
            let changed = false;

            for (let index = 0; index < answers.length; index += 1) {
                const letter = String.fromCharCode(65 + index);
                const shouldSelect = desired.has(letter);
                const input = await answers[index].findElement(By.css('input'));
                const currentlySelected = await input.isSelected();

                if (shouldSelect !== currentlySelected) {
                    await input.click();
                    log(shouldSelect ? 'Answer selected.' : 'Answer deselected.', { questionId: question.id, letter });
                    changed = true;
                }
            }

            return changed || normalized.length > 0;
        }

        const letter = normalized[0];
        if (!letter) {
            log('No answer provided for single-choice question.', { questionId: question.id });
            return false;
        }

        const index = letter.charCodeAt(0) - 65;
        if (index < 0 || index >= answers.length) {
            log('Answer index out of bounds for single-choice question.', { questionId: question.id, letter });
            return false;
        }

        const input = await answers[index].findElement(By.css('input'));
        const alreadySelected = await input.isSelected();
        if (!alreadySelected) {
            await input.click();
            log('Answer selected.', { questionId: question.id, letter });
            return true;
        }

        if (normalized.length > 1) {
            log('Multiple answers provided for single-choice question; extra entries ignored.', { questionId: question.id, letters: normalized });
        }
        return true;
    } catch (err) {
        log('Error handling choice question.', { error: err.message, questionId: question.id });
        return false;
    }
}

module.exports = { solveAndSubmitQuiz, parseBatchResponse };