// Checkmate extras: focus timer. A work/break timer tied to a task. It lives in a small pill at the bottom
// right of every Canvas page, keeps running while you move between pages, and logs the time you actually
// focused on each task (shown as a chip on the Tasks cards). Relies on x-core.js and content.js helpers.
//
// State is shared through storage.local so every open Canvas tab shows the same timer:
//   x_focus     { phase: "work" | "break" | "ready", key, title, courseId, path, phaseMs, endsAt, leftMs,
//                 paused, seg, round }
//   x_focus_log { byTask: { key: { title, ms, n, last } }, byDay: { "YYYY-MM-DD": ms }, segs: [segment ids] }

let xFocus = null;            // current timer state (or null)
let xFocusLog = { byTask: {}, byDay: {}, segs: [] };
let xFocusLoaded = false;
let xFocusTimer = null;
let xFocusAudio = null;
let xFocusMsg = null;         // { text, until }
let xFocusMin = false;        // pill collapsed to the ring
let xFocusBaseTitle = null;

const X_FOCUS_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>';
const X_FOCUS_PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/></svg>';
const X_FOCUS_STOP = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
const X_FOCUS_SKIP = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 5.5v13a1 1 0 0 0 1.5.86L16 13.9V18.5a1 1 0 0 0 2 0v-13a1 1 0 0 0-2 0v4.6L7.5 4.64A1 1 0 0 0 6 5.5z"/></svg>';
const X_FOCUS_MIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 12h12"/></svg>';

function xFocusWorkMs() { return (Number(options.focus_work) > 0 ? Number(options.focus_work) : 25) * 60000; }
function xFocusBreakMs() { return (Number(options.focus_break) > 0 ? Number(options.focus_break) : 5) * 60000; }
function xFocusDayKey(ms) {
    const d = new Date(ms);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function xFocusClock(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(total / 60), s = total % 60;
    return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}
function xFocusRemaining(st, now = Date.now()) {
    if (!st) return 0;
    if (st.phase === "ready") return 0;
    return st.paused ? (st.leftMs || 0) : Math.max(0, (st.endsAt || now) - now);
}

// ---- Storage ------------------------------------------------------------------------------------------
async function xFocusLoad() {
    try {
        const stored = await chrome.storage.local.get(["x_focus", "x_focus_log"]);
        xFocus = stored.x_focus || null;
        xFocusLog = Object.assign({ byTask: {}, byDay: {}, segs: [] }, stored.x_focus_log || {});
    } catch (e) { /* keep defaults */ }
    xFocusLoaded = true;
}
function xFocusSave(state) {
    xFocus = state;
    try {
        if (state) chrome.storage.local.set({ x_focus: state });
        else chrome.storage.local.remove("x_focus");
    } catch (e) { /* ignore */ }
}

// Adds focused time to the log, once per segment (two tabs finishing the same timer log it once).
async function xFocusAddLog(seg, key, title, ms) {
    if (!(ms >= 30000)) return;
    let log;
    try { log = (await chrome.storage.local.get("x_focus_log")).x_focus_log; } catch (e) { return; }
    log = Object.assign({ byTask: {}, byDay: {}, segs: [] }, log || {});
    if (log.segs.includes(seg)) { xFocusLog = log; return; }
    log.segs = log.segs.concat(seg).slice(-30);
    const entry = log.byTask[key] || { title: title, ms: 0, n: 0, last: 0 };
    entry.title = title || entry.title;
    entry.ms += ms;
    entry.n += 1;
    entry.last = Date.now();
    log.byTask[key] = entry;
    const day = xFocusDayKey(Date.now());
    log.byDay[day] = (log.byDay[day] || 0) + ms;
    const days = Object.keys(log.byDay).sort();
    if (days.length > 120) days.slice(0, days.length - 120).forEach(d => delete log.byDay[d]);
    const tasks = Object.keys(log.byTask).sort((a, b) => log.byTask[b].last - log.byTask[a].last);
    if (tasks.length > 200) tasks.slice(200).forEach(k => delete log.byTask[k]);
    xFocusLog = log;
    try { chrome.storage.local.set({ x_focus_log: log }); } catch (e) { /* ignore */ }
    xFocusRefreshCards();
}
function xFocusToday() { return xFocusLog.byDay[xFocusDayKey(Date.now())] || 0; }

function xFocusRefreshCards() {
    const list = document.querySelector("#canvasrefined-todo-list");
    if (list && document.getElementById("better-todo-main") && typeof clearTodoList === "function") { clearTodoList(); createTodoSections(list); }
}

// ---- Chip and button on Tasks cards -------------------------------------------------------------------
function xFocusChipHtml(item) {
    if (options.focus_timer === false) return "";
    const e = xFocusLog.byTask[todoPinKey(item)];
    if (!e || e.ms < 60000) return "";
    return ' <span class="cr-focus-chip" title="Time you focused on this task">' + (typeof xFormatMinutes === "function" ? xFormatMinutes(Math.round(e.ms / 60000)) : Math.round(e.ms / 60000) + "m") + " focused</span>";
}
function xFocusButtonHtml(item) {
    if (options.focus_timer === false || item.improve || item.plannable_type === "announcement") return "";
    const active = xFocus && xFocus.key === todoPinKey(item) && xFocus.phase !== "ready";
    return '<button type="button" class="cr-card-focus' + (active ? " is-active" : "") + '" data-focus-key="' + todoPinKey(item) + '" aria-label="Start a focus timer" title="Start a focus timer">' + X_FOCUS_PLAY + "</button>";
}
function xFocusAttach(root, item) {
    const btn = root.querySelector(".cr-card-focus");
    if (!btn) return;
    btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        xFocusStart({ key: todoPinKey(item), title: item.plannable?.title || item.title || "Task", courseId: item.course_id || item.plannable?.course_id || "", path: item.html_url || "" });
    });
}

// ---- Timer control ------------------------------------------------------------------------------------
function xFocusUnlockAudio() {
    try {
        if (options.focus_sound === false) return;
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!xFocusAudio && Ctx) xFocusAudio = new Ctx();
        if (xFocusAudio && xFocusAudio.state === "suspended") xFocusAudio.resume();
    } catch (e) { /* ignore */ }
}
function xFocusBeep(kind) {
    if (options.focus_sound === false || !xFocusAudio) return;
    try {
        const notes = kind === "break" ? [523, 659, 784] : [784, 659, 523];
        const t0 = xFocusAudio.currentTime;
        notes.forEach((f, i) => {
            const osc = xFocusAudio.createOscillator();
            const gain = xFocusAudio.createGain();
            osc.type = "sine";
            osc.frequency.value = f;
            gain.gain.setValueAtTime(0.0001, t0 + i * 0.18);
            gain.gain.exponentialRampToValueAtTime(0.16, t0 + i * 0.18 + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.18 + 0.32);
            osc.connect(gain).connect(xFocusAudio.destination);
            osc.start(t0 + i * 0.18);
            osc.stop(t0 + i * 0.18 + 0.35);
        });
    } catch (e) { /* ignore */ }
}
function xFocusNotify(title, body) {
    try {
        if (options.focus_notify === false || typeof Notification === "undefined" || Notification.permission !== "granted") return;
        new Notification(title, { body, icon: chrome.runtime.getURL("icon/icon-128.png"), silent: true });
    } catch (e) { /* ignore */ }
}
function xFocusSay(text) {
    xFocusMsg = { text, until: Date.now() + 8000 };
}

async function xFocusLogElapsed(st) {
    if (!st || st.phase !== "work") return;
    const elapsed = st.phaseMs - xFocusRemaining(st);
    await xFocusAddLog(st.seg, st.key, st.title, elapsed);
}

async function xFocusStart(task) {
    if (options.focus_timer === false) return;
    xFocusUnlockAudio();
    try {
        if (options.focus_notify !== false && typeof Notification !== "undefined" && Notification.permission === "default") Notification.requestPermission();
    } catch (e) { /* ignore */ }
    if (xFocus && xFocus.phase === "work") await xFocusLogElapsed(xFocus);
    const now = Date.now();
    const sameTask = xFocus && xFocus.key === task.key;
    const ms = xFocusWorkMs();
    xFocusSave({
        phase: "work", key: task.key, title: task.title, courseId: task.courseId || "", path: task.path || "",
        phaseMs: ms, endsAt: now + ms, leftMs: ms, paused: false, seg: "w" + now, round: sameTask ? (xFocus.round || 1) + 1 : 1,
    });
    xFocusMin = false;
    xFocusSay("");
    xFocusBeginTicking();
    xFocusRender();
}
async function xFocusToggle() {
    if (!xFocus || xFocus.phase === "ready") return;
    const now = Date.now();
    const next = Object.assign({}, xFocus);
    if (next.paused) { next.paused = false; next.endsAt = now + (next.leftMs || 0); }
    else { next.leftMs = Math.max(0, next.endsAt - now); next.paused = true; next.endsAt = null; }
    xFocusUnlockAudio();
    xFocusSave(next);
    xFocusRender();
}
async function xFocusStop() {
    const st = xFocus;
    xFocusSave(null);
    xFocusSay("");
    xFocusRender();
    xFocusRestoreTitle();
    if (st) {
        await xFocusLogElapsed(st);
        if (st.phase === "work") {
            const mins = Math.round((st.phaseMs - xFocusRemaining(st)) / 60000);
            if (mins >= 1) { xFocusSay("Logged " + mins + " min on " + st.title); xFocusRender(); }
        }
    }
}
function xFocusSkip() {
    if (!xFocus) return;
    if (xFocus.phase === "break" || xFocus.phase === "ready") xFocusStart({ key: xFocus.key, title: xFocus.title, courseId: xFocus.courseId, path: xFocus.path });
}

// Called every second. Handles the end of a phase, once even when several tabs are open.
async function xFocusAdvance() {
    const st = xFocus;
    if (!st || st.phase === "ready" || st.paused || st.endsAt > Date.now()) return;
    let fresh;
    try { fresh = (await chrome.storage.local.get("x_focus")).x_focus; } catch (e) { return; }
    if (!fresh || fresh.seg !== st.seg || fresh.phase !== st.phase) { xFocus = fresh || null; xFocusRender(); return; }
    const overshoot = Date.now() - st.endsAt;
    const stale = overshoot > 10 * 60000;
    const now = Date.now();
    if (st.phase === "work") {
        await xFocusAddLog(st.seg, st.key, st.title, st.phaseMs);
        if (options.focus_auto_break !== false && !stale) {
            const ms = xFocusBreakMs();
            xFocusSave(Object.assign({}, st, { phase: "break", phaseMs: ms, endsAt: now + ms, leftMs: ms, paused: false, seg: "b" + now }));
            xFocusSay("Nice work. Take a " + Math.round(ms / 60000) + " minute break.");
            if (!stale) { xFocusBeep("break"); xFocusNotify("Focus done: " + st.title, "Break time. You focused for " + Math.round(st.phaseMs / 60000) + " minutes."); }
        } else {
            xFocusSave(Object.assign({}, st, { phase: "ready", endsAt: null, leftMs: 0, paused: false, seg: "r" + now }));
            xFocusSay(stale ? "Your last session was logged." : "Session done.");
            if (!stale) { xFocusBeep("break"); xFocusNotify("Focus done: " + st.title, "You focused for " + Math.round(st.phaseMs / 60000) + " minutes."); }
        }
    } else {
        xFocusSave(Object.assign({}, st, { phase: "ready", endsAt: null, leftMs: 0, paused: false, seg: "r" + now }));
        xFocusSay("Break's over.");
        if (!stale) { xFocusBeep("work"); xFocusNotify("Break's over", "Ready for another round on " + st.title + "?"); }
    }
    xFocusRender();
}

// ---- The pill -----------------------------------------------------------------------------------------
function xFocusRestoreTitle() {
    if (xFocusBaseTitle !== null) { document.title = xFocusBaseTitle; xFocusBaseTitle = null; }
}
function xFocusUpdateTitle(text) {
    if (xFocusBaseTitle === null) xFocusBaseTitle = document.title.replace(/^[^\s]+ \d\d:\d\d · /, "");
    const next = text + " · " + xFocusBaseTitle;
    if (document.title !== next) document.title = next;
}

function xFocusBtn(cls, label, svg, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cr-focus-btn " + cls;
    b.setAttribute("aria-label", label);
    b.title = label;
    b.innerHTML = svg;
    b.addEventListener("click", onClick);
    return b;
}

function xFocusRender() {
    let pill = document.getElementById("cr-focus");
    const hidden = options.focus_timer === false || !xFocus || (typeof quizSafeModeActive === "function" && quizSafeModeActive());
    if (hidden || !document.body) {
        pill?.remove();
        if (!xFocus || options.focus_timer === false) xFocusRestoreTitle();
        return;
    }
    const st = xFocus;
    const msgLive = xFocusMsg && xFocusMsg.until > Date.now() ? xFocusMsg.text : "";
    const left = xFocusRemaining(st);
    const frac = st.phase === "ready" || !st.phaseMs ? 0 : Math.min(1, Math.max(0, 1 - left / st.phaseMs));
    const phaseLabel = st.phase === "work" ? "Focus" : st.phase === "break" ? "Break" : "Done";
    const sig = [st.phase, st.paused, st.key, xFocusMin, msgLive, st.seg].join("|");

    if (!pill) {
        pill = document.createElement("section");
        pill.id = "cr-focus";
        pill.setAttribute("aria-label", "Focus timer");
        crToastHost().appendChild(pill);
    }
    if (pill.dataset.sig !== sig) {
        pill.dataset.sig = sig;
        pill.className = "cr-focus is-" + st.phase + (st.paused ? " is-paused" : "") + (xFocusMin ? " is-min" : "");
        pill.replaceChildren();

        const ring = document.createElement("button");
        ring.type = "button";
        ring.className = "cr-focus-ring";
        ring.title = xFocusMin ? "Expand the timer" : "Collapse the timer";
        ring.innerHTML = '<svg viewBox="0 0 44 44" aria-hidden="true"><circle class="cr-focus-track" cx="22" cy="22" r="18"/><circle class="cr-focus-arc" cx="22" cy="22" r="18" transform="rotate(-90 22 22)"/></svg><span class="cr-focus-clock"></span>';
        ring.addEventListener("click", () => { xFocusMin = !xFocusMin; xFocusRender(); });
        pill.appendChild(ring);

        if (!xFocusMin) {
            const body = document.createElement("div");
            body.className = "cr-focus-body";
            const phase = document.createElement("span");
            phase.className = "cr-focus-phase";
            phase.textContent = phaseLabel + (st.paused ? " (paused)" : "") + (st.round > 1 && st.phase === "work" ? " · round " + st.round : "");
            const title = document.createElement("a");
            title.className = "cr-focus-title";
            title.textContent = st.title;
            if (st.path) title.href = st.path.startsWith("http") ? st.path : (typeof domain === "string" ? domain : "") + st.path;
            const sub = document.createElement("span");
            sub.className = "cr-focus-sub";
            sub.textContent = msgLive || (xFocusToday() >= 60000 ? "Focused today: " + (typeof xFormatMinutes === "function" ? xFormatMinutes(Math.round(xFocusToday() / 60000)) : Math.round(xFocusToday() / 60000) + "m") : "");
            body.append(phase, title, sub);
            pill.appendChild(body);

            const actions = document.createElement("div");
            actions.className = "cr-focus-actions";
            if (st.phase === "ready") {
                const again = xFocusBtn("is-primary", "Start another round", X_FOCUS_PLAY, () => xFocusSkip());
                actions.appendChild(again);
            } else {
                actions.appendChild(xFocusBtn("is-primary", st.paused ? "Resume" : "Pause", st.paused ? X_FOCUS_PLAY : X_FOCUS_PAUSE, () => xFocusToggle()));
                if (st.phase === "break") actions.appendChild(xFocusBtn("", "Skip the break", X_FOCUS_SKIP, () => xFocusSkip()));
            }
            actions.appendChild(xFocusBtn("", st.phase === "work" ? "Stop and log the time" : "Close", X_FOCUS_STOP, () => xFocusStop()));
            pill.appendChild(actions);
        }
    }

    const clock = pill.querySelector(".cr-focus-clock");
    if (clock) clock.textContent = st.phase === "ready" ? "✓" : xFocusClock(left);
    const arc = pill.querySelector(".cr-focus-arc");
    if (arc) {
        const c = 2 * Math.PI * 18;
        arc.setAttribute("stroke-dasharray", (c * frac).toFixed(1) + " " + c.toFixed(1));
    }
    if (st.phase === "ready" || (st.paused && st.phase !== "ready")) {
        if (st.phase === "ready") xFocusRestoreTitle(); else xFocusUpdateTitle("⏸ " + xFocusClock(left));
    } else {
        xFocusUpdateTitle((st.phase === "work" ? "⏱" : "☕") + " " + xFocusClock(left));
    }
}

function xFocusBeginTicking() {
    if (xFocusTimer) return;
    xFocusTimer = setInterval(() => {
        if (!xFocus) { clearInterval(xFocusTimer); xFocusTimer = null; xFocusRender(); return; }
        xFocusAdvance().catch(() => {});
        xFocusRender();
    }, 1000);
}

// ---- Start button on assignment pages -----------------------------------------------------------------
function xFocusEnsurePageButton() {
    const existing = document.querySelector(".cr-page-focus");
    const ref = options.focus_timer === false || typeof pageAssignmentRef !== "function" ? null : pageAssignmentRef();
    if (!ref) { existing?.remove(); return; }
    const key = ref.type + "_" + ref.id;
    if (existing && existing.dataset.key === key && existing.isConnected) return;
    existing?.remove();
    const heading = typeof pageTitleAnchor === "function" ? pageTitleAnchor() : document.querySelector("#content h1.title, #content h1, h1.title, #content h2.title");
    if (!heading) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cr-page-focus";
    btn.dataset.key = key;
    btn.innerHTML = X_FOCUS_PLAY + "<span>Focus</span>";
    btn.title = "Start a focus timer for this assignment";
    btn.addEventListener("click", () => {
        const copy = heading.cloneNode(true);
        copy.querySelectorAll("button").forEach(b => b.remove());
        const title = (copy.textContent || document.title.replace(/^[^\s]+ \d\d:\d\d · /, "")).replace(/\s+/g, " ").trim();
        xFocusStart({ key, title: title || "Assignment", courseId: ref.course, path: ref.path });
    });
    const pin = document.querySelector(".cr-page-pin.is-inline");
    if (typeof placeAfterPageTitle === "function") placeAfterPageTitle(heading, btn, pin);
    else if (pin) pin.insertAdjacentElement("afterend", btn); else heading.appendChild(btn);
}

xRegister({
    id: "focus",
    init() {
        xFocusLoad().then(() => {
            if (xFocus) xFocusBeginTicking();
            xFocusRender();
            xFocusRefreshCards();
        });
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== "local") return;
            if (changes.x_focus) {
                xFocus = changes.x_focus.newValue || null;
                if (xFocus) xFocusBeginTicking();
                const pill = document.getElementById("cr-focus");
                if (pill) pill.dataset.sig = "";
                xFocusRender();
                document.querySelectorAll(".cr-card-focus").forEach(b => b.classList.toggle("is-active", !!xFocus && xFocus.phase !== "ready" && xFocus.key === b.dataset.focusKey));
            }
            if (changes.x_focus_log) {
                xFocusLog = Object.assign({ byTask: {}, byDay: {}, segs: [] }, changes.x_focus_log.newValue || {});
                xFocusRefreshCards();
            }
        });
    },
    tick() {
        if (!xFocusLoaded) return;
        xFocusEnsurePageButton();
        if (xFocus && !document.getElementById("cr-focus")) xFocusRender();
    },
    onChange(keys) {
        if (keys.includes("focus_timer")) {
            if (options.focus_timer === false) { document.getElementById("cr-focus")?.remove(); document.querySelector(".cr-page-focus")?.remove(); xFocusRestoreTitle(); }
            else xFocusRender();
            xFocusRefreshCards();
        }
    },
});
