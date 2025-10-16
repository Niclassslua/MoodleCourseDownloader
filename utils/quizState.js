const { URL } = require('url');

function getAttemptIdFromUrl(url) {
    try {
        const u = new URL(url);
        const id = u.searchParams.get('attempt');
        return id ? Number(id) : null;
    } catch {
        return null;
    }
}

async function evalInPage(driver, fn, args = []) {
    // Small utility to run DOM-reading code
    return await driver.executeScript(`return (${fn}).apply(null, arguments)`, ...args);
}

async function detectPhase(driver) {
    const href = await driver.getCurrentUrl();
    if (/\/mod\/quiz\/attempt\.php/.test(href)) return 'attempt';
    if (/\/mod\/quiz\/summary\.php/.test(href)) return 'summary';
    if (/\/mod\/quiz\/review\.php/.test(href)) return 'review';
    if (/\/mod\/quiz\/view\.php/.test(href)) return 'view';
    return 'other';
}

async function collectQuestions(driver) {
    return await evalInPage(driver, () => {
        const nodes = Array.from(document.querySelectorAll('div[id^="question-"]'));
        const list = nodes.map((q, i) => {
            const id = q.id || `q-${i+1}`;
            const qno = q.querySelector('.qno, .qn')?.textContent?.trim() || String(i+1);
            // crude type detection
            let type = 'unknown';
            const classes = q.className || '';
            if (/multichoice/i.test(classes)) type = 'multichoice';
            else if (/truefalse/i.test(classes)) type = 'truefalse';
            else if (/shortanswer/i.test(classes)) type = 'shortanswer';
            else if (/essay/i.test(classes)) type = 'essay';
            else if (/match/i.test(classes)) type = 'match';
            else if (/numerical/i.test(classes)) type = 'numerical';

            // answered heuristic
            let answered = false;
            if (q.querySelector('input[type="radio"]:checked, input[type="checkbox"]:checked')) answered = true;
            else if (q.querySelector('input[type="text"][value]:not([value=""])')) answered = true;
            else if (q.querySelector('textarea') && q.querySelector('textarea').value.trim().length > 0) answered = true;
            else if (q.querySelector('.state.completed, .state.correct, .state.incorrect')) answered = true;

            return { index: i+1, id, type, answered, qno };
        });
        return list;
    });
}

async function collectQuizState(driver) {
    const phase = await detectPhase(driver);
    const url = await driver.getCurrentUrl();
    const attemptId = getAttemptIdFromUrl(url);
    const snapshot = await evalInPage(driver, () => {
        const rf = document.querySelector('form#responseform');
        const hasNext = !!(document.querySelector('input[name="next"], button[name="next"]'));
        const hasFinish = !!(document.querySelector('input[name="finishattempt"], button[name="finishattempt"]'));
        const showAll = !!document.querySelector('input[name="thispage"]') === false && !!rf;
        const pageInput = document.querySelector('input[name="thispage"]');
        const page = pageInput ? Number(pageInput.value || 0) : 0;
        const qNodes = Array.from(document.querySelectorAll('div[id^="question-"]'));
        const questionCount = qNodes.length;

        // count answered
        let answeredCount = 0;
        for (const q of qNodes) {
            let answered = false;
            if (q.querySelector('input[type="radio"]:checked, input[type="checkbox"]:checked')) answered = true;
            else if (q.querySelector('input[type="text"][value]:not([value=""])')) answered = true;
            else if (q.querySelector('textarea') && q.querySelector('textarea').value.trim().length > 0) answered = true;
            else if (q.querySelector('.state.completed, .state.correct, .state.incorrect')) answered = true;
            if (answered) answeredCount++;
        }

        return { hasNext, hasFinish, showAll, page, questionCount, answeredCount };
    });

    return {
        tag: 'QUIZ@WATCH',
        phase,
        attemptId,
        page: snapshot.page,
        showAll: snapshot.showAll,
        hasNext: snapshot.hasNext,
        hasFinish: snapshot.hasFinish,
        questionCount: snapshot.questionCount,
        answeredCount: snapshot.answeredCount,
        url
    };
}

function logQuizState(log, state, tag = 'QUIZ@WATCH') {
    const payload = { ...state, tag };
    log(`${tag} state: ${JSON.stringify(payload)}`);
}

function logQuizQuestion(log, q, tag = 'QUIZ@WATCH q') {
    log(`${tag}: ${JSON.stringify(q)}`);
}

async function logQuizEvent(log, driver, eventName, extra = {}) {
    const state = await collectQuizState(driver);
    const payload = {
        event: eventName,
        phase: state.phase,
        attemptId: state.attemptId,
        page: state.page,
        hasNext: state.hasNext,
        hasFinish: state.hasFinish,
        ...extra,
    };
    log(`QUIZ@EVENT ${eventName}: ${JSON.stringify(payload)}`);
}

module.exports = {
    getAttemptIdFromUrl,
    collectQuizState,
    collectQuestions,
    logQuizState,
    logQuizQuestion,
    logQuizEvent,
};
