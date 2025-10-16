// utils/quizNav.js
const { By } = require('selenium-webdriver');

function norm(s){ return (s||'').toLowerCase().replace(/\s+/g,' ').trim(); }

async function isAttemptPage(driver){
    return /\/mod\/quiz\/attempt\.php/.test(await driver.getCurrentUrl());
}
async function isSummaryPage(driver){
    return /\/mod\/quiz\/summary\.php/.test(await driver.getCurrentUrl());
}
async function isReviewPage(driver){
    return /\/mod\/quiz\/review\.php/.test(await driver.getCurrentUrl());
}

async function findNextButton(driver){
    const candidates = await driver.findElements(
        By.css('form#responseform input[type="submit"][name="next"], input.mod_quiz-next-nav, button.mod_quiz-next-nav')
    );
    for (const el of candidates){
        try{
            const v = norm(await el.getAttribute('value'));
            if (v.includes('next') || v.includes('weiter') || v.includes('nächste')) return el;
        }catch{}
    }
    return null;
}

async function findFinishAttemptButton(driver){
    const selectors = [
        'form#responseform input[type="submit"][name="next"]',   // „Versuch beenden“ auf attempt-Seite
        '#frm-finishattempt button[type="submit"]',              // Summary-Seite: „Abgeben“
        'form input#id_submitbutton'                             // generisch (Modal/Form)
    ];
    const lists = await Promise.all(selectors.map(s => driver.findElements(By.css(s))));
    const flat = lists.flat();
    for (const el of flat){
        try{
            const v = norm(await el.getAttribute('value'));
            if (
                v.includes('finish') || v.includes('beenden') ||
                v.includes('abgeben') || v.includes('abschließen') ||
                v.includes('submit all') || v.includes('versuch beenden')
            ) return el;
        }catch{}
    }
    return null;
}

async function clickNextIfPossible(driver){
    const next = await findNextButton(driver);
    if (!next) return false;
    await next.click();
    await driver.wait(async ()=>{
        const url = await driver.getCurrentUrl();
        return /\/mod\/quiz\/attempt\.php|\/mod\/quiz\/summary\.php|\/mod\/quiz\/review\.php/.test(url);
    }, 10000);
    return true;
}

async function finishAttempt(driver){
    // 1) Falls wir noch auf attempt-Seite sind: dortigen Finish/Submit drücken
    const finish = await findFinishAttemptButton(driver);
    if (finish){
        await finish.click();
        // 2) Wenn jetzt Summary: dort „Abgeben“ + Modal bestätigen
        if (await isSummaryPage(driver)){
            const finishFormBtns = await driver.findElements(By.css('#frm-finishattempt button[type="submit"], #frm-finishattempt input[type="submit"]'));
            if (finishFormBtns.length) await finishFormBtns[0].click();

            const modals = await driver.findElements(By.css('.modal-dialog'));
            if (modals.length){
                const confirm = await modals[0].findElements(By.css('.modal-footer .btn-primary,[data-action="save"]'));
                if (confirm.length) await confirm[0].click();
            }
        }
        // 3) Warten, bis Review oder Summary erreicht
        await driver.wait(async ()=> (await isReviewPage(driver)) || (await isSummaryPage(driver)), 15000);
        return true;
    }
    return false;
}

module.exports = { isAttemptPage, isSummaryPage, isReviewPage, clickNextIfPossible, finishAttempt };