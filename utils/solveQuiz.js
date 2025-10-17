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

/**
 * Builds the system prompt sent to OpenAI, optionally requesting solve time estimates.
 */
function buildSystemPrompt({ includeSolveEstimate = false } = {}) {
    const estimateBlock = includeSolveEstimate
        ? `
            Additionally, include a top-level property "estimatedSolveSeconds" with a realistic estimate for how many seconds a focused human would need to solve the entire quiz page. The value must be a positive number (decimals allowed) representing seconds. Always include this property in your response.
        `
        : '';

    const exampleEstimateLine = includeSolveEstimate ? '              "estimatedSolveSeconds": 42,\n' : '';

    return `
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
${estimateBlock}
            Example output:
            {
${exampleEstimateLine}              "answers": [
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
}

/**
 * Applies answers provided by OpenAI to the current quiz page.
 *
 * @returns {Promise<boolean>} true when at least one answer was applied, otherwise false.
 */
async function solveAndSubmitQuiz(driver, questions, options = {}) {
    try {
        const includeSolveEstimate = Boolean(options.includeSolveEstimate);
        const userPrompt = generateBatchPrompt(questions, { includeSolveEstimate });
        console.log(`${fg.cyan}Generated batch prompt:${reset}\n${userPrompt}\n`);

        const systemPrompt = buildSystemPrompt({ includeSolveEstimate });

        const response = await openai.chat.completions.create({
            model: 'gpt-4.1',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            max_tokens: 2000,
        });

        const responseContent = response.choices[0]?.message?.content;
        console.log(`${fg.cyan}OpenAI Response:${reset}\n${responseContent}\n`);

        const { answers: parsedAnswers, estimatedSolveSeconds } = parseBatchResponse(responseContent, questions, {
            includeSolveEstimate,
        });
        console.log(`${fg.green}Parsed answers:${reset}\n`, parsedAnswers);

        if (includeSolveEstimate) {
            const normalizedSeconds = normalizeEstimatedSeconds(estimatedSolveSeconds);
            if (normalizedSeconds > 0) {
                const waitSeconds = Math.min(normalizedSeconds, 300);
                await log('Delaying automated quiz answer submission to simulate human solving time.', {
                    estimatedSolveSeconds: normalizedSeconds,
                    appliedWaitSeconds: waitSeconds,
                }, driver);
                await driver.sleep(waitSeconds * 1000);
            }
        }

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
            console.warn(`${fg.yellow}No actionable answers were applied on this page.${reset}`);
            return false;
        }

        return true;
    } catch (err) {
        console.error(`${fg.red}Error in solveAndSubmitQuiz: ${err.message}${reset}`);
        return false;
    }
}


function generateBatchPrompt(questions, options = {}) {
    const body = questions
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

            if (q.type === 'multichoice' || q.type === 'truefalse') {
                const options = q.answers
                    .map((answer, index) => `${String.fromCharCode(65 + index)}. ${answer.text}`)
                    .join('\n');
                const isMultiple = q.choiceType === 'multiple';
                const selectionHint = isMultiple
                    ? 'Respond with all correct letters in an array, e.g. ["A", "C"].'
                    : q.type === 'truefalse'
                        ? 'Respond with exactly one letter wrapped in an array. "A" always refers to the first option (e.g. Wahr), "B" to the second option (e.g. Falsch).'
                        : 'Respond with a single letter inside an array, e.g. ["B"].';

                return [
                    header,
                    `Type: ${q.type === 'truefalse' ? 'true/false' : isMultiple ? 'multiple choice' : 'single choice'}`,
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

    if (options.includeSolveEstimate) {
        return `${body}\n\nPlease base your "estimatedSolveSeconds" value on the realistic time a diligent human would need for all questions on this page.`;
    }

    return body;
}

function normalizeJsonContent(content) {
    if (!content || typeof content !== 'string') {
        return null;
    }

    const trimmed = content.trim();

    // Handle responses wrapped in Markdown code fences (```json ... ```)
    const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
    if (fenceMatch) {
        return fenceMatch[1].trim();
    }

    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace >= firstBrace) {
        return trimmed.slice(firstBrace, lastBrace + 1);
    }

    return trimmed;
}

function coerceResponseArray(rawResponse) {
    if (Array.isArray(rawResponse)) {
        return rawResponse;
    }

    if (rawResponse == null) {
        return [];
    }

    // Allow single values (string/number/boolean) to be coerced into a one-element array
    if (['string', 'number', 'boolean'].includes(typeof rawResponse)) {
        return [rawResponse];
    }

    return [];
}

function normalizeEstimatedSeconds(value) {
    if (value == null) {
        return 0;
    }
    const numeric = typeof value === 'string' ? Number.parseFloat(value) : Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
        return 0;
    }
    return numeric;
}

function parseBatchResponse(responseContent, questions, options = {}) {
    try {
        const normalizedContent = normalizeJsonContent(responseContent);
        if (!normalizedContent) {
            console.error(`${fg.red}Empty response content received from OpenAI.${reset}`);
            return { answers: questions.map(() => null), estimatedSolveSeconds: null };
        }

        const parsed = JSON.parse(normalizedContent);
        if (!parsed.answers || !Array.isArray(parsed.answers)) {
            console.error(`${fg.red}Invalid response structure:${reset}`, parsed);
            return { answers: questions.map(() => null), estimatedSolveSeconds: null };
        }

        const answers = questions.map((q) => {
            const answer = parsed.answers.find((a) => a.id === q.id);
            if (!answer) return null;

            if (q.type === 'match') {
                const responseArray = coerceResponseArray(answer.response);
                return responseArray
                    .filter((pair) => pair && typeof pair.field === 'string' && typeof pair.selectedOption === 'string')
                    .map((pair) => ({
                        field: pair.field.trim(),
                        selectedOption: pair.selectedOption.trim(),
                    }));
            }

            if (q.type === 'multichoice' || q.type === 'single' || q.type === 'truefalse') {
                const responseArray = coerceResponseArray(answer.response);
                return responseArray
                    .filter((entry) => typeof entry === 'string' && entry.trim().length)
                    .map((entry) => entry.trim().toUpperCase());
            }

            console.warn(`${fg.yellow}No valid data for question ${q.id}${reset}`);
            return null;
        });
        const includeEstimate = Boolean(options.includeSolveEstimate);
        const estimatedSolveSeconds = includeEstimate
            ? normalizeEstimatedSeconds(parsed.estimatedSolveSeconds)
            : null;
        return { answers, estimatedSolveSeconds };
    } catch (err) {
        console.error(`${fg.red}Failed to parse batch response: ${err.message}${reset}`);
        return { answers: questions.map(() => null), estimatedSolveSeconds: null };
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

        const locateChoiceInput = async (container) => {
            const interactiveInputs = await container.findElements(
                By.css('input[type="radio"], input[type="checkbox"]')
            );

            for (const input of interactiveInputs) {
                // Selenium cannot click hidden inputs directly. Prefer elements that are displayed,
                // but fall back to the first available one in case visibility detection fails.
                if (await input.isDisplayed()) {
                    return input;
                }
            }

            if (interactiveInputs.length) {
                return interactiveInputs[0];
            }

            // Some Moodle themes wrap the checkbox in a label without exposing it directly.
            const labelInputs = await container.findElements(
                By.css('label input[type="radio"], label input[type="checkbox"]')
            );
            return labelInputs.length ? labelInputs[0] : null;
        };

        if (isMultiple) {
            const desired = new Set(normalized);
            let changed = false;

            for (let index = 0; index < answers.length; index += 1) {
                const letter = String.fromCharCode(65 + index);
                const shouldSelect = desired.has(letter);
                const input = await locateChoiceInput(answers[index]);

                if (!input) {
                    log('No selectable checkbox/radio found for option.', { questionId: question.id, letter });
                    continue;
                }

                const currentlySelected = await input.isSelected();

                if (shouldSelect !== currentlySelected) {
                    try {
                        await input.click();
                    } catch (clickErr) {
                        await driver.executeScript('arguments[0].click();', input);
                    }
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

        const input = await locateChoiceInput(answers[index]);
        if (!input) {
            log('No selectable radio found for single-choice option.', { questionId: question.id, letter });
            return false;
        }
        const alreadySelected = await input.isSelected();
        if (!alreadySelected) {
            try {
                await input.click();
            } catch (clickErr) {
                await driver.executeScript('arguments[0].click();', input);
            }
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
