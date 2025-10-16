const { collectQuizState, collectQuestions, logQuizState, logQuizQuestion } = require('./quizState');

const SLEEP = (ms) => new Promise(r => setTimeout(r, ms));

function shouldWatch() {
    return process.env.QUIZ_WATCH !== '0';
}

function isQuizUrl(href) {
    return /\/mod\/quiz\//.test(href);
}

/**
 * Runs a background watcher while `fn` executes.
 * The watcher polls every 2s and logs only when the state changes.
 */
async function withQuizWatcher(driver, log, fn, { intervalMs = 2000 } = {}) {
    if (!shouldWatch()) {
        return fn();
    }

    let stop = false;
    let lastKey = '';
    let lastQuestionsKey = '';

    const runner = (async () => {
        while (!stop) {
            try {
                const url = await driver.getCurrentUrl();
                if (!isQuizUrl(url)) {
                    await SLEEP(intervalMs);
                    continue;
                }

                const s = await collectQuizState(driver);
                const key = JSON.stringify({ phase: s.phase, attemptId: s.attemptId, page: s.page, answeredCount: s.answeredCount, questionCount: s.questionCount, hasNext: s.hasNext, hasFinish: s.hasFinish });
                if (key !== lastKey) {
                    logQuizState(log, s);
                    lastKey = key;
                }

                if (process.env.QUIZ_TRACE === '1' && (s.phase === 'attempt' || s.phase === 'summary')) {
                    const qs = await collectQuestions(driver);
                    const qKey = JSON.stringify(qs.map(q => [q.id, q.type, q.answered]));
                    if (qKey !== lastQuestionsKey) {
                        for (const q of qs) {
                            logQuizQuestion(log, q);
                        }
                        lastQuestionsKey = qKey;
                    }
                }
            } catch (e) {
                // don't crash the watcher on transient DOM/driver issues
            } finally {
                await SLEEP(intervalMs);
            }
        }
    })();

    try {
        const result = await fn();
        return result;
    } finally {
        stop = true;
        await SLEEP(intervalMs + 50); // let last poll finish
    }
}

module.exports = { withQuizWatcher };
