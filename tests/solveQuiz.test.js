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

        await solveAndSubmitQuiz(mockDriver, mockQuizData.questions);

        expect(mockDriver.findElement).toHaveBeenCalled();
        expect(mockDriver.findElements).toHaveBeenCalled();
    });
});
