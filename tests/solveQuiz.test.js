jest.setTimeout(15000); // Setzt das Timeout auf 15 Sekunden

require('dotenv').config();
const { solveAndSubmitQuiz, parseBatchResponse } = require('../utils/solveQuiz');
const { mockQuizData } = require('../utils/mockData');
const OpenAI = require('openai');

describe('solveAndSubmitQuiz (Real OpenAI)', () => {
    let mockDriver;

    beforeEach(() => {
        mockDriver = {
            findElement: jest.fn(() => ({ click: jest.fn() })),
            findElements: jest.fn(() => [
                {
                    findElement: jest.fn(() => ({
                        getText: jest.fn(() => 'Option A'),
                        click: jest.fn(),
                    })),
                },
            ]),
        };
    });

    afterEach(() => {
        jest.clearAllMocks(); // Löscht Mock-Aufrufe
    });

    it('should correctly solve the quiz using solveAndSubmitQuiz', async () => {
        if (!process.env.OPENAI_API_KEY) {
            throw new Error('OPENAI_API_KEY is not set. Please add it to your environment variables.');
        }

        const client = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
        });

        const systemPrompt = `
            You are a strict JSON generator for quiz questions.
            - For match questions, provide answers as an array of objects, e.g., [{"field": "field_name", "selectedOption": "matched_value"}].
            - For multiple-choice questions, provide answers as an array of selected options, e.g., ["A", "C"].
            - For single-choice questions, provide the answer as an array with one letter, e.g., ["A"].
            Only output valid JSON.
        `.trim();

        const userPrompt = mockQuizData.questions.map((q, index) => {
            // Prompt Generierung (wie oben beschrieben)
        }).join('\n\n');

        console.log('Generated batch prompt:', userPrompt);

        const response = await client.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            max_tokens: 2000,
        });

        const responseContent = response.choices[0]?.message?.content;
        console.log('OpenAI Response:', responseContent);

        const parsedAnswers = parseBatchResponse(responseContent, mockQuizData.questions);
        console.log('Parsed answers:', parsedAnswers);

        const result = await solveAndSubmitQuiz(mockDriver, mockQuizData.questions);

        expect(typeof result).toBe('boolean');
        expect(mockDriver.findElements).toHaveBeenCalled();
    });
});

describe('parseBatchResponse', () => {
    it('normalizes responses for true/false questions', () => {
        const questions = [
            {
                id: 'question-truefalse-1',
                type: 'truefalse',
                text: 'Ist die Aussage korrekt?',
                answers: [
                    { text: 'Wahr', value: 'A' },
                    { text: 'Falsch', value: 'B' },
                ],
                choiceType: 'single',
            },
        ];

        const responseContent = JSON.stringify({
            answers: [
                {
                    id: 'question-truefalse-1',
                    response: ['b'],
                },
            ],
        });

        const parsed = parseBatchResponse(responseContent, questions);

        expect(parsed).toEqual([['B']]);
    });

    it('extracts answers from fenced JSON and coerces single values', () => {
        const questions = [
            {
                id: 'question-single-1',
                type: 'single',
                text: 'Welche Option ist korrekt?',
                answers: [
                    { text: 'Option A', value: 'A' },
                    { text: 'Option B', value: 'B' },
                ],
                choiceType: 'single',
            },
            {
                id: 'question-match-1',
                type: 'match',
                answers: [
                    { field: 'Term 1', options: ['Definition 1', 'Definition 2'] },
                ],
            },
        ];

        const responseContent = [
            '```json',
            '{',
            '  "answers": [',
            '    { "id": "question-single-1", "response": "b" },',
            '    { "id": "question-match-1", "response": { "field": "Term 1", "selectedOption": "Definition 2" } }',
            '  ]',
            '}',
            '```',
        ].join('\n');

        const parsed = parseBatchResponse(responseContent, questions);

        expect(parsed).toEqual([
            ['B'],
            [{ field: 'Term 1', selectedOption: 'Definition 2' }],
        ]);
    });
});
