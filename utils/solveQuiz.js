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
            You are a strict JSON generator for quiz questions. Always output a single valid JSON object.
            
            For match questions:
            - Provide answers as an array of objects in the format:
              [{"field": "field_name", "selectedOption": "matched_value"}]
            
            For multiple-choice questions:
            - Provide answers as an array of selected letters, e.g., ["A", "C"].
            
            For single-choice questions:
            - Provide the answer as an array with one letter, e.g., ["A"].
            
            Example output:
            {
              "answers": [
                {
                  "id": "question-1",
                  "type": "match",
                  "response": [{"field": "float", "selectedOption": "32 bit"}, {"field": "int", "selectedOption": "64 bit"}]
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
            Always adhere strictly to this format. If information is missing, respond with an empty array in the "response" field. Do not include any other text or explanation.
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

        // Handle parsed answers
        for (let i = 0; i < questions.length; i++) {
            const question = questions[i];
            const answer = parsedAnswers[i];

            if (!answer) {
                log('No valid answer parsed for question.', { questionId: question.id });
                continue;
            }

            if (question.type === 'match') {
                await handleMatchQuestion(driver, question, answer);
            } else {
                await handleChoiceQuestion(driver, question, answer);
            }
        }

        console.log(`${fg.yellow}Finding submit button${reset}`);
        const submitButton = await driver.findElement(By.css('button[type="submit"]'));
        console.log(`${fg.yellow}Clicking submit button${reset}`);
        await submitButton.click();
    } catch (err) {
        console.error(`${fg.red}Error in solveAndSubmitQuiz: ${err.message}${reset}`);
    }
}


function generateBatchPrompt(questions) {
    return questions
        .map((question) => {
            if (question.type === 'match') {
                const fieldsList = question.answers
                    .map((answer) => `- ${answer.field}`)
                    .join('\n');
                const optionsSource = Array.isArray(question.options) && question.options.length
                    ? question.options
                    : question.answers
                        .map((answer) => answer.selectedOption)
                        .filter(Boolean);
                const optionsList = optionsSource.length
                    ? optionsSource.map((option) => `- ${option}`).join('\n')
                    : '- (no explicit options detected)';

                return [
                    `Match Question (ID: ${question.id})`,
                    question.text,
                    'Fields:',
                    fieldsList,
                    'Possible matches:',
                    optionsList,
                    'Respond format: [{"field": "field_name", "selectedOption": "matched_value"}]',
                ].join('\n');
            }

            if (question.type === 'multichoice') {
                const choiceType = question.choiceType === 'multiple' ? 'Multiple Choice' : 'Single Choice';
                const expectedFormat = question.choiceType === 'multiple' ? '["A", "C"]' : '["A"]';
                const optionsList = question.answers
                    .map((answer, index) => `${String.fromCharCode(65 + index)}. ${answer.text}`)
                    .join('\n');

                return [
                    `${choiceType} Question (ID: ${question.id})`,
                    question.text,
                    'Options:',
                    optionsList,
                    `Respond format: ${expectedFormat}`,
                ].join('\n');
            }

            return `Question (ID: ${question.id})\n${question.text}\nRespond with an empty array if unsupported.`;
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

            if (q.type === 'match' && answer.response) {
                return answer.response;
            }
            if ((q.type === 'multichoice' || q.choiceType === 'single' || q.choiceType === 'multiple') && Array.isArray(answer.response)) {
                return answer.response;
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
    try {
        for (const pair of answer) {
            const row = await driver.findElement(By.xpath(`//tr[td[contains(text(), "${pair.field}")]]`));
            const select = await row.findElement(By.css('select'));
            await select.sendKeys(pair.selectedOption);
            log('Match answer selected.', { questionId: question.id, field: pair.field, selectedOption: pair.selectedOption });
        }
    } catch (err) {
        log('Error handling match question.', { error: err.message, questionId: question.id });
    }
}

async function handleChoiceQuestion(driver, question, answer) {
    try {
        for (const option of answer) {
            const index = option.charCodeAt(0) - 65;
            const answerText = question.answers[index]?.text;
            const answers = await driver.findElements(By.css(`#${question.id} .answer .r0, #${question.id} .answer .r1`));
            let found = false;
            for (const ans of answers) {
                const label = await ans.findElement(By.css('div[data-region="answer-label"]')).getText();
                if (label.trim() === answerText) {
                    const input = await ans.findElement(By.css('input'));
                    await input.click();
                    log('Answer selected.', { questionId: question.id, answerText });
                    found = true;
                    break;
                }
            }
            if (!found) {
                log('Answer not found among available options.', { questionId: question.id, answerText });
            }
        }
    } catch (err) {
        log('Error handling choice question.', { error: err.message, questionId: question.id });
    }
}

module.exports = { solveAndSubmitQuiz, parseBatchResponse };