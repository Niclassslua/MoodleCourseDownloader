const { solveAndSubmitQuiz } = require('./solveQuiz');
const { mockQuizData } = require('./mockData');

(async () => {
    console.log("Mock Quiz Data:", JSON.stringify(mockQuizData, null, 2));

    // Mock-Driver, der keine echten Selenium-Interaktionen durchführt
    const mockDriver = {
        findElement: async (selector) => ({
            click: async () => console.log(`Clicked element: ${selector}`),
            sendKeys: async (keys) => console.log(`Sent keys: ${keys} to ${selector}`),
        }),
        findElements: async (selector) => [
            {
                findElement: async () => ({
                    getText: async () => "Matched Option",
                    click: async () => console.log("Matched Option clicked"),
                }),
            },
        ],
    };

    const applied = await solveAndSubmitQuiz(mockDriver, mockQuizData.questions);
    console.log(`Solver applied answers: ${applied}`);
})();
