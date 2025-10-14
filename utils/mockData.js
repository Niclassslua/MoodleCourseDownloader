const mockQuizData = {
    quizTitle: "Kapitel 1: Auffrischung",
    questions: [
        {
            id: "question-500824-1",
            type: "match",
            text: "Ordnen Sie die Bitbreiten den Datentypen zu:",
            answers: [
                { field: "float", selectedOption: "Auswählen ..." },
                { field: "byte", selectedOption: "Auswählen ..." },
                { field: "double", selectedOption: "Auswählen ..." },
                { field: "char", selectedOption: "Auswählen ..." },
                { field: "long", selectedOption: "Auswählen ..." },
                { field: "int", selectedOption: "Auswählen ..." },
                { field: "short", selectedOption: "Auswählen ..." },
            ],
            options: ["8 bit", "16 bit", "32 bit", "64 bit"], // Optionen für die Zuordnung
            correctAnswer: [
                { field: "float", selectedOption: "32 bit" },
                { field: "byte", selectedOption: "8 bit" },
                { field: "double", selectedOption: "64 bit" },
                { field: "char", selectedOption: "16 bit" },
                { field: "long", selectedOption: "64 bit" },
                { field: "int", selectedOption: "32 bit" },
                { field: "short", selectedOption: "16 bit" },
            ],
        },
        {
            id: "question-500824-2",
            type: "multichoice",
            text: "Welche der folgenden Datentypen sind vorzeichenbehaftet:",
            answers: [
                { text: "a. short", isSelected: false },
                { text: "b. int", isSelected: false },
                { text: "c. byte", isSelected: false },
                { text: "d. float", isSelected: false },
                { text: "e. char", isSelected: false },
                { text: "f. long", isSelected: false },
                { text: "g. double", isSelected: false },
            ],
            choiceType: "multiple",
            correctAnswers: ["short", "int", "byte", "float", "long", "double"],
        },
        {
            id: "question-500824-3",
            type: "multichoice",
            text: "Gegeben sei folgendes Codefragment\ndouble d = -1.0 / 0.0;\nWelchen Wert hat die Variable d?",
            answers: [
                { text: "a. unbestimmt", isSelected: false },
                { text: "b. -Infinity", isSelected: false },
                { text: "c. -1.0", isSelected: false },
                { text: "d. 0.0", isSelected: false },
                { text: "e. Infinity", isSelected: false },
                { text: "f. Not a Number (NaN)", isSelected: false },
            ],
            choiceType: "single",
            correctAnswer: "-Infinity",
        },
        {
            id: "question-500824-4",
            type: "match",
            text: "Geben Sie bitte die Wertebereiche der folgenden Java-Datentypen an: byte, short, int, long und char.\nOrdnen Sie bitte passend zu:",
            answers: [
                { field: "byte", selectedOption: "Auswählen ..." },
                { field: "short", selectedOption: "Auswählen ..." },
                { field: "long", selectedOption: "Auswählen ..." },
                { field: "char", selectedOption: "Auswählen ..." },
                { field: "int", selectedOption: "Auswählen ..." },
            ],
            options: [
                "-2^7 bis 2^7 - 1",
                "-2^15 bis 2^15 - 1",
                "-2^31 bis 2^31 - 1",
                "-2^63 bis 2^63 - 1",
                "0 bis 2^16",
            ], // Optionen für die Zuordnung
            correctAnswer: [
                { field: "byte", selectedOption: "-2^7 bis 2^7 - 1" },
                { field: "short", selectedOption: "-2^15 bis 2^15 - 1" },
                { field: "long", selectedOption: "-2^63 bis 2^63 - 1" },
                { field: "char", selectedOption: "0 bis 2^16" },
                { field: "int", selectedOption: "-2^31 bis 2^31 - 1" },
            ],
        },
    ],
};

module.exports = { mockQuizData };