const fs = require('fs');
const path = require('path');
const { log } = require('./logger');

function loadCourseState(coursePath) {
    const stateFilePath = path.join(coursePath, 'course_state.json');
    if (fs.existsSync(stateFilePath)) {
        const data = fs.readFileSync(stateFilePath, 'utf8');
        return JSON.parse(data);
    }
    return {};
}

function saveCourseState(coursePath, currentState) {
    const stateFilePath = path.join(coursePath, 'course_state.json');
    fs.writeFileSync(stateFilePath, JSON.stringify(currentState, null, 2), 'utf8');
    log(`Kurszustand gespeichert unter ${stateFilePath}`);
}

module.exports = { loadCourseState, saveCourseState };
