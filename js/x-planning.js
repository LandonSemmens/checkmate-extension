// Checkmate extras: planning tools. Time estimates (with hours per day under the week strip)
// and the calendar export. Relies on x-core.js and content.js helpers.

// ---- Time estimates ------------------------------------------------------------------------------------
// Every task gets an estimate in minutes: the student's own number when set (time_estimates, keyed by
// the planner key), otherwise a guess from the title and type. Clicking the chip on a card changes it.
const X_EST_PRESETS = [15, 30, 45, 60, 90, 120, 180];

function xGuessMinutes(item) {
    const title = item.plannable?.title || item.title || "";
    if (/\b(final|midterm|mid-term|exam)\b/i.test(title) && !/review|practice/i.test(title)) return 120;
    if (item.plannable_type === "planner_note") return 30;
    if (item.plannable_type === "discussion_topic" || /discussion|reply|post/i.test(title)) return 30;
    if (item.plannable_type === "quiz" || /quiz|check/i.test(title)) return 30;
    if (/case|project|paper|essay|report|presentation/i.test(title)) return 90;
    if (/smartbook|reading|chapter/i.test(title)) return 45;
    return 45;
}
function xEstimateMinutes(item) {
    const own = Number(options.time_estimates?.[todoPinKey(item)]);
    return own > 0 ? own : xGuessMinutes(item);
}
function xFormatHours(minutes) {
    if (minutes < 60) return minutes + "m";
    const h = minutes / 60;
    return (Math.round(h * 10) / 10) + "h";
}
function xFormatMinutes(minutes) {
    if (minutes < 60) return minutes + "m";
    const h = Math.floor(minutes / 60), m = minutes % 60;
    return h + "h" + (m ? " " + m + "m" : "");
}

function xEstChipHtml(item) {
    if (options.plan_hours === false || item.plannable_type === "announcement") return "";
    const own = Number(options.time_estimates?.[todoPinKey(item)]) > 0;
    return ' <button type="button" class="cr-est' + (own ? " is-set" : "") + '" data-est-key="' + todoPinKey(item) + '" title="Estimated time. Click to change it.">~' + xFormatMinutes(xEstimateMinutes(item)) + "</button>";
}

function xCloseEstimateMenu() {
    document.getElementById("cr-est-menu")?.remove();
}
function xSetEstimate(item, minutes) {
    const key = todoPinKey(item);
    const next = Object.assign({}, options.time_estimates || {});
    delete next[key];
    if (minutes) next[key] = minutes;
    const keys = Object.keys(next);
    if (keys.length > 150) keys.slice(0, keys.length - 150).forEach(k => delete next[k]);
    options.time_estimates = next;
    chrome.storage.sync.set({ time_estimates: next });
}
function xOpenEstimateMenu(item, anchor) {
    xCloseEstimateMenu();
    const menu = document.createElement("div");
    menu.id = "cr-est-menu";
    menu.setAttribute("role", "menu");
    const current = xEstimateMinutes(item);
    X_EST_PRESETS.forEach(m => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "cr-est-opt" + (m === current ? " is-current" : "");
        b.textContent = xFormatMinutes(m);
        b.addEventListener("click", () => { xSetEstimate(item, m); xCloseEstimateMenu(); });
        menu.appendChild(b);
    });
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "cr-est-opt cr-est-reset";
    reset.textContent = "Auto";
    reset.title = "Go back to the automatic guess";
    reset.addEventListener("click", () => { xSetEstimate(item, 0); xCloseEstimateMenu(); });
    menu.appendChild(reset);
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    const w = menu.offsetWidth;
    menu.style.top = Math.min(window.innerHeight - menu.offsetHeight - 8, r.bottom + 6) + "px";
    menu.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left)) + "px";
    setTimeout(() => {
        const close = (e) => { if (!menu.contains(e.target)) { xCloseEstimateMenu(); document.removeEventListener("mousedown", close, true); } };
        document.addEventListener("mousedown", close, true);
    }, 0);
}
function xAttachEstimateEditor(root, item) {
    const chip = root.querySelector(".cr-est");
    if (!chip) return;
    chip.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); xOpenEstimateMenu(item, chip); });
}

// ---- Calendar export (.ics) ----------------------------------------------------------------------------
function xIcsEscape(text) {
    return String(text || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}
function xIcsFold(line) {
    const out = [];
    let rest = line;
    while (rest.length > 74) { out.push(rest.slice(0, 74)); rest = " " + rest.slice(74); }
    out.push(rest);
    return out.join("\r\n");
}
function xIcsStamp(ms) {
    return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}
function xIcsDate(ms) {
    const d = new Date(ms);
    return d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
}

async function xBuildIcs() {
    const now = Date.now();
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Checkmate//Due dates//EN", "CALSCALE:GREGORIAN", "X-WR-CALNAME:Canvas due dates"];
    const add = (event) => event.forEach(l => lines.push(xIcsFold(l)));

    const data = typeof assignments?.then === "function" ? await assignments : [];
    filterHiddenCourses(data).filter(it => isTodoTaskType(it)).forEach(it => {
        const t = new Date(it.plannable_date).getTime();
        if (!(t > now) || t > now + 120 * X_DAY) return;
        if ((hasFinishedSubmission(it) || it.planner_override?.marked_complete === true) && !isPinnedIncomplete(it)) return;
        const course = xCourseName(todoCourseIdOf(it));
        const url = it.html_url ? domain + it.html_url : "";
        add([
            "BEGIN:VEVENT",
            "UID:" + todoPinKey(it) + "@canvasrefined",
            "DTSTAMP:" + xIcsStamp(now),
            "DTSTART:" + xIcsStamp(t),
            "DTEND:" + xIcsStamp(t + 30 * 60000),
            "SUMMARY:" + xIcsEscape((course ? "[" + course.replace(/_FA-\d{4}$/, "") + "] " : "") + (it.plannable?.title || "Assignment") + " due"),
            "DESCRIPTION:" + xIcsEscape("About " + xFormatMinutes(xEstimateMinutes(it)) + (url ? "\n" + url : "")),
            url ? "URL:" + url : "",
            "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Due in 1 day", "TRIGGER:-P1D", "END:VALARM",
            "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Due in 2 hours", "TRIGGER:-PT2H", "END:VALARM",
            "END:VEVENT",
        ].filter(Boolean));
    });

    // Exams and in-person meetings read from the course pages (all-day events)
    try {
        const info = await xGetCourseInfo();
        const exams = await xUpcomingExams(info, now);
        exams.filter(e => e.allDay).forEach(e => add([
            "BEGIN:VEVENT",
            "UID:exam-" + e.courseId + "-" + e.ms + "@canvasrefined",
            "DTSTAMP:" + xIcsStamp(now),
            "DTSTART;VALUE=DATE:" + xIcsDate(e.ms),
            "DTEND;VALUE=DATE:" + xIcsDate(e.ms + X_DAY),
            "SUMMARY:" + xIcsEscape(e.label + " (" + xCourseName(e.courseId).replace(/_FA-\d{4}$/, "") + ")"),
            "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Exam in 1 week", "TRIGGER:-P7D", "END:VALARM",
            "END:VEVENT",
        ]));
    } catch (e) { /* exams are optional */ }

    lines.push("END:VCALENDAR");
    return lines.join("\r\n") + "\r\n";
}

async function xExportIcs(button) {
    button.disabled = true;
    try {
        const text = await xBuildIcs();
        const count = (text.match(/BEGIN:VEVENT/g) || []).length;
        if (!count) { button.title = "Nothing due in the next four months to export."; return; }
        const blob = new Blob([text], { type: "text/calendar;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "canvas-due-dates.ics";
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        button.title = "Exported " + count + " events. Open the file to add them to your calendar.";
    } finally {
        button.disabled = false;
    }
}

function xMountExportButton() {
    const header = document.getElementById("better-todo-header");
    if (!header) return;
    let btn = document.getElementById("cr-ics-btn");
    if (options.todo_export === false) { btn?.remove(); return; }
    if (btn) return;
    btn = document.createElement("button");
    btn.type = "button";
    btn.id = "cr-ics-btn";
    btn.className = "cr-icon-btn";
    btn.setAttribute("aria-label", "Export due dates to your calendar");
    btn.title = "Export due dates to your calendar (.ics)";
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v11m0 0l-4-4m4 4l4-4M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2"/></svg>';
    btn.addEventListener("click", () => xExportIcs(btn));
    header.appendChild(btn);
}

xRegister({
    id: "planning",
    tick() { xMountExportButton(); },
    onChange(keys) {
        if (keys.includes("time_estimates") || keys.includes("plan_hours")) {
            const list = document.querySelector("#canvasrefined-todo-list");
            if (list && document.getElementById("better-todo-main")) { clearTodoList(); createTodoSections(list); }
        }
        if (keys.includes("todo_export")) xMountExportButton();
    },
});
