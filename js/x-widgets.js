// Checkmate extras: dashboard widgets. "Coming up" (next classes, exams) and the weekly recap.
// Relies on x-core.js and content.js helpers.

// ---- Reading dates, exams and meeting times out of a course's Home page and syllabus ---------------
const X_MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const X_DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const X_DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Every "Month day" in a line (with or without weekday, year, "th"). A year given anywhere in the
// line applies to dates that don't carry their own ("Friday, Aug. 21; ... Dec. 4, 2026").
function xParseDates(line, refNow) {
    const re = /(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+)?(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(20\d{2}))?/gi;
    const years = Array.from(line.matchAll(/\b(20\d{2})\b/g)).map(m => Number(m[1]));
    const lineYear = years.length ? years[years.length - 1] : null;
    const found = [];
    let m;
    while ((m = re.exec(line))) {
        const day = Number(m[2]);
        if (day < 1 || day > 31) continue;
        const month = X_MONTHS[m[1].slice(0, 3).toLowerCase()];
        const year = m[3] ? Number(m[3]) : (lineYear || new Date(refNow).getFullYear());
        found.push({ ms: new Date(year, month, day, 0, 0, 0, 0).getTime(), index: m.index });
    }
    return found;
}

function xParseExams(text, refNow) {
    const out = [];
    text.split("\n").forEach(line => {
        const kw = line.match(/\b(final\s+exam|midterm(?:\s+exam)?|mid-term(?:\s+exam)?|exam\s*\d+|test\s*\d+)\b/i);
        if (!kw) return;
        const date = xParseDates(line, refNow).find(d => d.index >= kw.index);
        if (!date) return;
        const raw = kw[1].toLowerCase().replace(/\s+/g, " ").replace("mid-term", "midterm");
        const label = raw.startsWith("final") ? "Final exam" : raw.startsWith("midterm") ? "Midterm exam" : raw.charAt(0).toUpperCase() + raw.slice(1);
        if (!out.some(e => e.label === label && e.ms === date.ms)) out.push({ label, ms: date.ms });
    });
    return out;
}

function xParseTimeRange(line) {
    const m = line.match(/(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\s*(?:-|–|—|to)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/i);
    if (!m) return null;
    const endPm = /^p/i.test(m[6]);
    let sh = Number(m[1]), eh = Number(m[4]);
    const sm = Number(m[2] || 0), em = Number(m[5] || 0);
    const startPm = m[3] ? /^p/i.test(m[3]) : (endPm && !(sh > eh && eh !== 12 ? true : false) ? true : false);
    const to24 = (h, pm) => (h % 12) + (pm ? 12 : 0);
    return { start: to24(sh, startPm) * 60 + sm, end: to24(eh, endPm) * 60 + em, index: m.index, length: m[0].length };
}

function xParseDays(line) {
    const days = [];
    Array.from(line.matchAll(/\b(mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/gi)).forEach(m => {
        const d = X_DAYS[m[1].slice(0, 3).toLowerCase()];
        if (!days.includes(d)) days.push(d);
    });
    return days;
}

// Weekly meetings ("Tuesday/Thursday 8 a.m.- 9:15 a.m.") and dated in-person meetings
// ("Required in-person meetings: Friday, Oct. 2; ...", "In-Class Meetings: August 17th, ...").
function xParseMeetings(text, refNow) {
    const sessions = [];
    const loc = (text.match(/\b(?:location|room)\s*:\s*([^\n]{2,30})/i) || [])[1];
    const baseLocation = loc ? loc.trim() : "";
    text.split("\n").forEach(line => {
        if (!/meeting|meets|class time|class schedule|in-?class|in-?person/i.test(line)) return;
        if (/office hours/i.test(line) || /\b(final exam|midterm|exam)\b/i.test(line)) return;
        const time = xParseTimeRange(line);
        const days = xParseDays(line);
        const dates = xParseDates(line, refNow);
        let location = baseLocation;
        if (time) {
            const after = line.slice(time.index + time.length);
            const lm = after.match(/\b([A-Z]{1,4}\s?\d{1,4}[A-Za-z]?)\b/);
            if (lm) location = lm[1];
        }
        if (dates.length) {
            dates.forEach(d => sessions.push({ date: d.ms, start: time ? time.start : null, end: time ? time.end : null, location }));
        } else if (days.length && time) {
            sessions.push({ weekly: true, days, start: time.start, end: time.end, location });
        }
    });
    return sessions;
}

// ---- Per-course info (cached for six hours) ---------------------------------------------------------
async function xGetCourseInfo() {
    const cached = await xCacheGet("x_course_info", 6 * X_HOUR);
    if (cached) return cached;
    const ids = await xCourseIds();
    const now = Date.now();
    const rows = await Promise.all(ids.slice(0, 12).map(async id => {
        const [front, course, tabs] = await Promise.all([
            xFetchJson(domain + "/api/v1/courses/" + id + "/front_page"),
            xFetchJson(domain + "/api/v1/courses/" + id + "?include[]=syllabus_body"),
            xFetchJson(domain + "/api/v1/courses/" + id + "/tabs"),
        ]);
        const text = xStripHtml(front && front.body) + "\n" + xStripHtml(course && course.syllabus_body);
        const web = (Array.isArray(tabs) ? tabs : []).find(t => !t.hidden && /webex|zoom|big\s*blue|conferenc/i.test(t.label || ""));
        let webexPath = "";
        if (web && web.html_url) { try { webexPath = new URL(web.html_url, domain).pathname; } catch (e) { webexPath = web.html_url; } }
        return { id: Number(id), sessions: xParseMeetings(text, now), exams: xParseExams(text, now), webex: webexPath };
    }));
    xCacheSet("x_course_info", rows);
    return rows;
}

function xStartOfDay(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }

function xFormatClock(minutes) {
    const h = Math.floor(minutes / 60) % 24, m = minutes % 60;
    return ((h % 12) || 12) + (m ? ":" + String(m).padStart(2, "0") : "") + " " + (h < 12 ? "AM" : "PM");
}

// The next few class sessions across all courses.
function xNextSessions(courseInfo, now, limit = 3) {
    const out = [];
    courseInfo.forEach(c => (c.sessions || []).forEach(s => {
        if (s.weekly) {
            for (let i = 0; i < 14; i++) {
                const day = xStartOfDay(now) + i * X_DAY;
                if (!s.days.includes(new Date(day).getDay())) continue;
                const start = day + s.start * 60000, end = day + s.end * 60000;
                if (end > now) { out.push({ courseId: c.id, start, end, allDay: false, location: s.location, webex: c.webex }); break; }
            }
        } else if (s.date) {
            const start = s.date + (s.start != null ? s.start * 60000 : 0);
            const end = s.end != null ? s.date + s.end * 60000 : s.date + X_DAY;
            if (end > now && start < now + 60 * X_DAY) out.push({ courseId: c.id, start, end, allDay: s.start == null, location: s.location, webex: c.webex, inPerson: true });
        }
    }));
    return out.sort((a, b) => a.start - b.start).slice(0, limit);
}

// Exams: dates read from the course pages, plus planner items that look like exams.
async function xUpcomingExams(courseInfo, now) {
    const out = [];
    courseInfo.forEach(c => (c.exams || []).forEach(e => { if (e.ms >= xStartOfDay(now)) out.push({ courseId: c.id, label: e.label, ms: e.ms, allDay: true }); }));
    try {
        const data = typeof assignments?.then === "function" ? await assignments : [];
        filterHiddenCourses(data).forEach(it => {
            const title = it.plannable?.title || "";
            if (!/\b(exam|midterm|mid-term|final)\b/i.test(title) || /review|practice|study|prep/i.test(title)) return;
            if (it.plannable_type === "announcement" || it.plannable_type === "planner_note") return;
            const t = new Date(it.plannable_date).getTime();
            if (!(t >= now)) return;
            if ((hasFinishedSubmission(it) || it.planner_override?.marked_complete === true) && !isPinnedIncomplete(it)) return;
            const cid = Number(todoCourseIdOf(it));
            // the same exam can appear on the course page and in the planner: keep the planner's exact time
            const dup = out.findIndex(e => e.courseId === cid && xStartOfDay(e.ms) === xStartOfDay(t));
            if (dup >= 0) out.splice(dup, 1);
            out.push({ courseId: cid, label: title.replace(/\s+/g, " ").slice(0, 60), ms: t, allDay: false });
        });
    } catch (e) { /* the planner is optional here */ }
    return out.filter(e => e.ms < now + 120 * X_DAY).sort((a, b) => a.ms - b.ms).slice(0, 5);
}

// ---- Coming up card ------------------------------------------------------------------------------
const X_ICON_CAL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 3v3M17 3v3M4 9h16M6 5h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"/></svg>';

function xDaysUntil(ms, now) {
    return Math.round((xStartOfDay(ms) - xStartOfDay(now)) / X_DAY);
}
function xFormatDateShort(ms) {
    return new Date(ms).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function xUpNextRow(opts) {
    const row = document.createElement("div");
    row.className = "cr-un-row";
    row.style.setProperty("--cr-course", opts.courseId ? courseRingColor(String(opts.courseId), 0) : "var(--cr-mute)");
    const body = document.createElement("div");
    body.className = "cr-un-body";
    const title = document.createElement("span");
    title.className = "cr-un-title";
    title.textContent = opts.title;
    const meta = document.createElement("span");
    meta.className = "cr-un-meta";
    meta.textContent = opts.meta;
    body.append(title, meta);
    const badge = document.createElement("span");
    badge.className = "cr-un-badge";
    badge.textContent = opts.badge;
    row.append(body, badge);
    if (opts.join) {
        const a = document.createElement("a");
        a.className = "cr-un-join";
        a.href = domain + opts.join;
        a.textContent = "Webex";
        a.title = "Open the Webex page for this class";
        row.appendChild(a);
    }
    return row;
}

let xUpNextBuiltAt = 0;
let xUpNextBuilding = false;

async function xBuildUpNext() {
    if (xUpNextBuilding) return;
    xUpNextBuilding = true;
    try {
        const info = await xGetCourseInfo();
        const now = Date.now();
        const count = Number(options.upnext_count) > 0 ? Number(options.upnext_count) : 2;
        const sessions = xNextSessions(info, now, count);
        const examCount = Number(options.upnext_exams) > 0 ? Number(options.upnext_exams) : 3;
        const exams = (await xUpcomingExams(info, now)).sort((a, b) => a.ms - b.ms).slice(0, examCount);
        const collapsed = ((await chrome.storage.local.get("x_upnext_collapsed")).x_upnext_collapsed) === true;
        if (options.upnext_card === false) { xUnmountWidget("cr-upnext"); return; }
        if (!sessions.length && !exams.length) { xUnmountWidget("cr-upnext"); xUpNextBuiltAt = now; return; }

        const card = document.createElement("section");
        card.id = "cr-upnext";
        card.className = "cr-upnext" + (options.upnext_size === "normal" ? "" : options.upnext_size === "large" ? " is-large" : " is-compact") + (collapsed ? " is-collapsed" : "");
        const head = document.createElement("div");
        head.className = "cr-w-head";
        const icon = document.createElement("span");
        icon.className = "cr-w-icon";
        icon.innerHTML = X_ICON_CAL;
        const title = document.createElement("span");
        title.className = "cr-w-title";
        title.textContent = "Coming up";
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "cr-w-close cr-un-toggle";
        toggle.textContent = collapsed ? "Show" : "Hide";
        toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
        toggle.addEventListener("click", () => {
            const now2 = !card.classList.contains("is-collapsed");
            card.classList.toggle("is-collapsed", now2);
            toggle.textContent = now2 ? "Show" : "Hide";
            toggle.setAttribute("aria-expanded", now2 ? "false" : "true");
            chrome.storage.local.set({ x_upnext_collapsed: now2 });
        });
        head.append(icon, title, toggle);

        const grid = document.createElement("div");
        grid.className = "cr-un-grid";

        if (sessions.length) {
            const col = document.createElement("div");
            col.className = "cr-un-col";
            const sub = document.createElement("div");
            sub.className = "cr-un-sub";
            sub.textContent = "Next class";
            col.appendChild(sub);
            sessions.forEach((s, i) => {
                const going = s.start <= now && s.end > now;
                const when = s.allDay ? xFormatDateShort(s.start) : new Date(s.start).toLocaleDateString("en-US", { weekday: "short" }) + " " + xFormatClock(Math.round((s.start - xStartOfDay(s.start)) / 60000)) + "–" + xFormatClock(Math.round((s.end - xStartOfDay(s.end - 1)) / 60000));
                col.appendChild(xUpNextRow({
                    courseId: s.courseId,
                    title: xCourseName(s.courseId) || "Class",
                    meta: (s.inPerson ? "In person · " : "") + when + (s.location ? " · " + s.location : ""),
                    badge: going ? "now" : s.allDay ? (xDaysUntil(s.start, now) === 0 ? "today" : "in " + xDaysUntil(s.start, now) + "d") : formatDueIn(s.start - now),
                    join: i === 0 && s.webex ? s.webex : "",
                }));
            });
            grid.appendChild(col);
        }
        if (exams.length) {
            const col = document.createElement("div");
            col.className = "cr-un-col";
            const sub = document.createElement("div");
            sub.className = "cr-un-sub";
            sub.textContent = "Exams";
            col.appendChild(sub);
            exams.forEach(e => {
                const days = xDaysUntil(e.ms, now);
                col.appendChild(xUpNextRow({
                    courseId: e.courseId,
                    title: e.label,
                    meta: (xCourseName(e.courseId) || "") + (e.allDay ? "" : "") + " · " + xFormatDateShort(e.ms),
                    badge: days <= 0 ? "today" : days === 1 ? "tomorrow" : days + " days",
                }));
            });
            grid.appendChild(col);
        }
        card.append(head, grid);

        const old = document.getElementById("cr-upnext");
        if (old) old.replaceWith(card); else xMountWidget(card, 2);
        card.dataset.rank = "2";
        xUpNextBuiltAt = now;
    } catch (e) {
        console.warn("Checkmate: coming up card", e);
    } finally {
        xUpNextBuilding = false;
    }
}

function xTickUpNext() {
    if (!document.querySelector("#DashboardCard_Container")) return;
    if (options.upnext_card === false) { xUnmountWidget("cr-upnext"); return; }
    const card = document.getElementById("cr-upnext");
    if (!card || Date.now() - xUpNextBuiltAt > 10 * 60000) xBuildUpNext();
    else if (card && !card.parentNode) xMountWidget(card, 2);
}

// ---- Weekly recap ---------------------------------------------------------------------------------
// On Sunday and Monday: what got done last week, what was missed, the streak, and grade movement.
function xWeekKey(ms) {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // back to Monday
    return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
}

async function xGradeSnapshot() {
    const courses = await xFetchJson(domain + "/api/v1/courses?enrollment_state=active&include[]=total_scores&per_page=100");
    const out = {};
    (courses || []).forEach(c => {
        const e = (c.enrollments || []).find(x => x.type === "student" || x.role === "StudentEnrollment") || (c.enrollments || [])[0];
        const score = e && (e.computed_current_score ?? (e.grades && e.grades.current_score));
        if (score !== null && score !== undefined) out[c.id] = Number(score);
    });
    return out;
}

async function xBuildRecap() {
    const now = Date.now();
    const weekAgo = now - 7 * X_DAY;
    const data = typeof assignments?.then === "function" ? await assignments : [];
    const week = filterHiddenCourses(data).filter(it => isTodoTaskType(it) && it.plannable_type !== "planner_note" && it.plannable_type !== "announcement")
        .filter(it => { const t = new Date(it.plannable_date).getTime(); return t > weekAgo && t <= now; });
    const isDone = it => (hasFinishedSubmission(it) || it.planner_override?.marked_complete === true) && !isPinnedIncomplete(it);
    const done = week.filter(isDone), missed = week.filter(it => !isDone(it));
    const streak = typeof computeStreak === "function" ? computeStreak(filterHiddenCourses(data)).days : null;

    // grade movement against a snapshot taken about a week ago
    let deltas = [];
    try {
        const current = await xGradeSnapshot();
        const stored = (await chrome.storage.local.get("x_grade_history")).x_grade_history || [];
        const older = stored.filter(s => now - s.at >= 5 * X_DAY).sort((a, b) => b.at - a.at)[0];
        if (older) {
            deltas = Object.keys(current).filter(id => older.grades[id] !== undefined).map(id => ({ id, now: current[id], diff: current[id] - older.grades[id] }));
        }
        const newest = stored.sort((a, b) => b.at - a.at)[0];
        if (!newest || now - newest.at > 6 * X_DAY) {
            stored.push({ at: now, grades: current });
            chrome.storage.local.set({ x_grade_history: stored.sort((a, b) => b.at - a.at).slice(0, 8) });
        }
    } catch (e) { /* grades are optional in the recap */ }
    return { done, missed, streak, deltas };
}

async function xTickRecap() {
    const host = document.querySelector("#DashboardCard_Container");
    if (!host) return;
    if (options.weekly_recap === false) { xUnmountWidget("cr-recap"); return; }
    const day = new Date().getDay();
    if (day !== 0 && day !== 1) { xUnmountWidget("cr-recap"); return; }
    const key = xWeekKey(Date.now() - (day === 0 ? 0 : 0));
    if (document.getElementById("cr-recap")) return;
    const seen = (await chrome.storage.local.get("x_recap_seen")).x_recap_seen;
    if (seen === key) return;
    if (xRecapBuilding) return;
    xRecapBuilding = true;
    try {
        const r = await xBuildRecap();
        if (!r.done.length && !r.missed.length) return;
        const card = document.createElement("section");
        card.id = "cr-recap";
        card.className = "cr-recap";
        const head = document.createElement("div");
        head.className = "cr-w-head";
        const title = document.createElement("span");
        title.className = "cr-w-title";
        title.textContent = "Your week";
        const close = document.createElement("button");
        close.type = "button";
        close.className = "cr-w-close";
        close.textContent = "Dismiss";
        close.addEventListener("click", () => { chrome.storage.local.set({ x_recap_seen: key }); xUnmountWidget("cr-recap"); });
        head.append(title, close);

        const stats = document.createElement("div");
        stats.className = "cr-rc-stats";
        const stat = (n, label, cls) => {
            const s = document.createElement("div");
            s.className = "cr-rc-stat" + (cls ? " " + cls : "");
            const num = document.createElement("span");
            num.className = "cr-rc-n";
            num.textContent = String(n);
            const lab = document.createElement("span");
            lab.className = "cr-rc-l";
            lab.textContent = label;
            s.append(num, lab);
            return s;
        };
        stats.appendChild(stat(r.done.length, r.done.length === 1 ? "turned in" : "turned in", "is-good"));
        stats.appendChild(stat(r.missed.length, r.missed.length === 1 ? "missed" : "missed", r.missed.length ? "is-bad" : ""));
        if (r.streak !== null) stats.appendChild(stat(r.streak, r.streak === 1 ? "day streak" : "day streak", ""));
        card.append(head, stats);

        if (r.deltas.length) {
            const list = document.createElement("div");
            list.className = "cr-rc-grades";
            r.deltas.slice(0, 6).forEach(d => {
                const row = document.createElement("div");
                row.className = "cr-rc-grade";
                row.style.setProperty("--cr-course", courseRingColor(String(d.id), 0));
                const name = document.createElement("span");
                name.className = "cr-rc-gname";
                name.textContent = xCourseName(d.id) || "Course";
                const val = document.createElement("span");
                val.className = "cr-rc-gval";
                const diff = Math.round(d.diff * 10) / 10;
                val.textContent = (Math.round(d.now * 10) / 10) + "%" + (diff === 0 ? "" : " (" + (diff > 0 ? "+" : "") + diff + ")");
                if (diff > 0) val.classList.add("is-up"); else if (diff < 0) val.classList.add("is-down");
                row.append(name, val);
                list.appendChild(row);
            });
            card.appendChild(list);
        }
        xMountWidget(card, 1);
    } catch (e) {
        console.warn("Checkmate: recap", e);
    } finally {
        xRecapBuilding = false;
    }
}
let xRecapBuilding = false;

xRegister({
    id: "widgets",
    tick() { xTickUpNext(); xTickRecap(); },
    onChange(keys) {
        if (keys.includes("upnext_card") || keys.includes("upnext_size") || keys.includes("upnext_count") || keys.includes("upnext_exams")) { xUpNextBuiltAt = 0; if (options.upnext_card === false) xUnmountWidget("cr-upnext"); }
        if (keys.includes("weekly_recap") && options.weekly_recap === false) xUnmountWidget("cr-recap");
    },
});
