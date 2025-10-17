const { emitUiEvent } = require('./logger');

const state = {
    total: 0,
    completed: 0,
    active: 0,
    pending: 0,
    startedAt: null,
    stage: 'idle',
};

function reset() {
    state.total = 0;
    state.completed = 0;
    state.active = 0;
    state.pending = 0;
    state.startedAt = null;
    state.stage = 'idle';
    emit({ stage: 'idle' });
}

function ensureStarted() {
    if (!state.startedAt) {
        state.startedAt = Date.now();
    }
}

function sanitizePayload(payload = {}) {
    const clean = { ...payload };
    for (const key of Object.keys(clean)) {
        if (clean[key] === undefined || clean[key] === null) {
            delete clean[key];
        }
    }
    return clean;
}

function emit(extra = {}) {
    ensureStarted();
    if (extra.stage) {
        state.stage = extra.stage;
    }
    const pending = Math.max(state.total - state.completed - state.active, 0);
    state.pending = pending;
    const percent = state.total === 0 ? 100 : Math.min(100, Math.round((state.completed / state.total) * 100));
    const payload = sanitizePayload({
        total: state.total,
        completed: state.completed,
        active: state.active,
        pending,
        percent,
        startedAt: state.startedAt,
        stage: state.stage,
        ...extra,
    });
    emitUiEvent('progress', payload);
}

function registerTasks(count = 0) {
    if (!Number.isFinite(count) || count <= 0) {
        return state.total;
    }
    ensureStarted();
    state.total += count;
    emit({ stage: state.stage || 'running' });
    return state.total;
}

function startTask(task = null, options = {}) {
    ensureStarted();
    state.active += 1;
    const payload = { stage: 'running' };
    if (task) {
        payload.current = task;
    }
    if (options.message) {
        payload.message = options.message;
    }
    emit(payload);
}

function completeTask(task = null, options = {}) {
    if (state.active > 0) {
        state.active -= 1;
    }
    state.completed += 1;
    if (state.completed > state.total) {
        state.total = state.completed;
    }
    const payload = { stage: state.completed >= state.total ? 'finishing' : state.stage || 'running' };
    if (task) {
        payload.lastCompleted = task;
    }
    if (options.message) {
        payload.message = options.message;
    }
    emit(payload);
}

function failTask(task = null, error = null, options = {}) {
    if (state.active > 0) {
        state.active -= 1;
    }
    const payload = { stage: 'error' };
    if (task) {
        payload.lastCompleted = task;
    }
    if (error && error.message) {
        payload.error = { message: error.message };
        if (!options.message) {
            payload.message = error.message;
        }
    }
    if (options.message) {
        payload.message = options.message;
    }
    emit(payload);
}

function setStage(stage, options = {}) {
    const payload = { stage };
    if (options.message) {
        payload.message = options.message;
    }
    emit(payload);
}

function setMessage(message) {
    emit({ stage: state.stage, message });
}

function finish(options = {}) {
    state.stage = 'finished';
    state.active = 0;
    if (state.completed < state.total) {
        state.completed = state.total;
    }
    const payload = { stage: 'finished' };
    if (options.message) {
        payload.message = options.message;
    }
    emit(payload);
}

function getState() {
    return { ...state };
}

module.exports = {
    reset,
    registerTasks,
    startTask,
    completeTask,
    failTask,
    setStage,
    setMessage,
    finish,
    getState,
};
