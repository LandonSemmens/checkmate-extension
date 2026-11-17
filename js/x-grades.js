// Checkmate extras: grade target calculator, the "can still improve" list, grade-change alerts.
// Relies on x-core.js and content.js helpers.

// ---- Grade target calculator ---------------------------------------------------------------------
// On a course's Grades page: pick a grade to aim for and see the average the remaining work needs.
// Mirrors Canvas's own arithmetic: ungraded work is left out of the current grade, and when the
// course weights its assignment groups, each group counts by its weight among groups with work.
function xGradeMath(groups, weighted, targetPct) {
    const rows = groups.map(g => {
        let earned = 0, graded = 0, remaining = 0, count = 0;
        (g.assignments || []).forEach(a => {
            const pts = Number(a.points_possible) || 0;
            const s = a.submission || {};
            if (a.omit_from_final_grade || a.published === false || s.excused || pts <= 0) return;
            if (s.score !== null && s.score !== undefined) { earned += Number(s.score); graded += pts; }
            else { remaining += pts; count++; }
        });
        return { name: g.name, weight: Number(g.group_weight) || 0, earned, graded, remaining, count };
    }).filter(r => r.graded + r.remaining > 0);

    const useWeights = weighted && rows.some(r => r.weight > 0);
    let current = null;
    if (useWeights) {
        const done = rows.filter(r => r.graded > 0);
        const w = done.reduce((t, r) => t + r.weight, 0);
        if (w > 0) current = done.reduce((t, r) => t + r.weight * (r.earned / r.graded), 0) / w;
    } else {
        const e = rows.reduce((t, r) => t + r.earned, 0), p = rows.reduce((t, r) => t + r.graded, 0);
        if (p > 0) current = e / p;
    }

    // final(x) = A + B * x, where x is the average fraction earned on everything left
    let A = 0, B = 0;
    if (useWeights) {
        const W = rows.reduce((t, r) => t + r.weight, 0);
        rows.forEach(r => { const total = r.graded + r.remaining; A += (r.weight / W) * (r.earned / total); B += (r.weight / W) * (r.remaining / total); });
    } else {
        const total = rows.reduce((t, r) => t + r.graded + r.remaining, 0);
        A = rows.reduce((t, r) => t + r.earned, 0) / total;
        B = rows.reduce((t, r) => t + r.remaining, 0) / total;
    }
    const target = targetPct / 100;
    return {
        rows, useWeights, current: current === null ? null : current * 100,
        worst: A * 100, best: (A + B) * 100,
        remainingPts: rows.reduce((t, r) => t + r.remaining, 0),
        remainingCount: rows.reduce((t, r) => t + r.count, 0),
        need: B > 0 ? ((target - A) / B) * 100 : null,
        hasRemaining: B > 0,
    };
}

function xGradeLetters() {
    const bounds = options.gpa_calc_bounds || {};
    const list = Object.keys(bounds).filter(k => k !== "F").map(k => ({ letter: k, cutoff: Number(bounds[k].cutoff) })).filter(x => !Number.isNaN(x.cutoff));
    if (!list.length) return [{ letter: "A", cutoff: 93 }, { letter: "A-", cutoff: 90 }, { letter: "B+", cutoff: 87 }, { letter: "B", cutoff: 83 }, { letter: "B-", cutoff: 80 }, { letter: "C", cutoff: 73 }];
    return list.sort((a, b) => b.cutoff - a.cutoff);
}

function xRenderGradeResult(box, math, target) {
    box.replaceChildren();
    const fmt = (n) => (Math.round(n * 10) / 10) + "%";
    const line = (text, cls) => { const p = document.createElement("p"); p.className = "cr-gt-line" + (cls ? " " + cls : ""); p.textContent = text; box.appendChild(p); };
    if (!math.hasRemaining) { line("Everything is graded, so your grade is final at " + (math.current === null ? "n/a" : fmt(math.current)) + ".", ""); return; }
    if (math.need > 100.0001) {
        line("Out of reach: even 100% on everything left only gets you to " + fmt(math.best) + ".", "is-bad");
    } else if (math.need <= 0) {
        line("You've already got it. Even zeros on the rest would leave you at " + fmt(math.worst) + ".", "is-good");
    } else {
        line("Average " + fmt(math.need) + " on what's left.", math.need > 95 ? "is-warn" : "is-good");
        line(math.remainingCount + (math.remainingCount === 1 ? " assignment" : " assignments") + " to go, " + (Math.round(math.remainingPts * 10) / 10) + " points.", "is-sub");
    }
}

// The latest answer, shared with the Grade analytics overview (it shows a "To reach 90%" card).
let xTargetSummary = null;

async function xMountGradeTarget() {
    const m = location.pathname.match(/^\/courses\/(\d+)\/grades\/?$/);
    const existing = document.getElementById("cr-grade-target");
    if (!m || options.grade_target === false) { existing?.remove(); xTargetSummary = null; return; }
    // With Grade analytics on, the target lives in its "Target" tab; otherwise it stands alone above the table.
    const host = document.getElementById("canvasrefined-ga-target");
    const embedded = options.grade_analytics === true;
    if (embedded) {
        if (!host) return; // wait for the analytics panel to be built
        if (existing && existing.parentNode !== host) existing.remove();
        if (host.querySelector(".cr-gt") && host.dataset.course === m[1]) return;
    } else {
        if (existing && existing.dataset.course === m[1] && existing.parentNode !== host) return;
        existing?.remove();
    }
    const anchor = embedded ? host : (document.querySelector("#grades_summary") || document.querySelector("#content"));
    if (!anchor) return;
    const courseId = m[1];
    // Guard against two overlapping loads (the page watcher fires repeatedly while Canvas builds the page).
    if (xGradeTargetLoading === courseId) return;
    xGradeTargetLoading = courseId;
    try {
        const [course, groups] = await Promise.all([
            xFetchJson(domain + "/api/v1/courses/" + courseId),
            xFetchJson(domain + "/api/v1/courses/" + courseId + "/assignment_groups?include[]=assignments&include[]=submission&per_page=100"),
        ]);
        if (!Array.isArray(groups) || !groups.length || document.getElementById("cr-grade-target")) return;
        if (embedded && !document.getElementById("canvasrefined-ga-target")) return;
        const weighted = !!(course && course.apply_assignment_group_weights);
        const saved = Number(options.grade_targets?.[courseId]);
        let target = saved > 0 ? saved : 90;

        const card = document.createElement("section");
        card.id = "cr-grade-target";
        card.className = "cr-gt";
        card.dataset.course = courseId;

        const head = document.createElement("div");
        head.className = "cr-gt-head";
        const title = document.createElement("span");
        title.className = "cr-gt-title";
        title.textContent = "Grade target";
        const now = document.createElement("span");
        now.className = "cr-gt-now";
        head.append(title, now);

        const controls = document.createElement("div");
        controls.className = "cr-gt-controls";
        const label = document.createElement("label");
        label.textContent = "Aim for";
        const select = document.createElement("select");
        select.setAttribute("aria-label", "Letter grade to aim for");
        const letters = xGradeLetters();
        letters.forEach(l => { const o = document.createElement("option"); o.value = String(l.cutoff); o.textContent = l.letter + " (" + l.cutoff + "%)"; select.appendChild(o); });
        const custom = document.createElement("option"); custom.value = "custom"; custom.textContent = "Custom"; select.appendChild(custom);
        const input = document.createElement("input");
        input.type = "number"; input.min = "1"; input.max = "100"; input.step = "0.5";
        input.setAttribute("aria-label", "Percent to aim for");
        const pct = document.createElement("span");
        pct.textContent = "%";
        controls.append(label, select, input, pct);

        const result = document.createElement("div");
        result.className = "cr-gt-result";
        result.setAttribute("aria-live", "polite");

        const table = document.createElement("table");
        table.className = "cr-gt-groups";
        const thead = document.createElement("thead");
        const hr = document.createElement("tr");
        ["Group", "Weight", "So far", "Left"].forEach(t => { const th = document.createElement("th"); th.textContent = t; hr.appendChild(th); });
        thead.appendChild(hr);
        table.appendChild(thead);
        const tbody = document.createElement("tbody");
        table.appendChild(tbody);

        const refresh = () => {
            const math = xGradeMath(groups, weighted, target);
            now.textContent = math.current === null ? "No grades yet" : "Now " + (Math.round(math.current * 10) / 10) + "%";
            xTargetSummary = { courseId: Number(courseId), target, need: math.hasRemaining ? math.need : null };
            if (typeof renderGaStats === "function") renderGaStats();
            xRenderGradeResult(result, math, target);
            tbody.replaceChildren();
            math.rows.forEach(r => {
                const tr = document.createElement("tr");
                const cells = [r.name, math.useWeights ? (Math.round(r.weight * 10) / 10) + "%" : "–", r.graded > 0 ? (Math.round((r.earned / r.graded) * 1000) / 10) + "%" : "–", r.remaining > 0 ? (Math.round(r.remaining * 10) / 10) + " pts" : "–"];
                cells.forEach(t => { const td = document.createElement("td"); td.textContent = t; tr.appendChild(td); });
                tbody.appendChild(tr);
            });
        };
        const syncSelect = () => { const hit = letters.find(l => l.cutoff === target); select.value = hit ? String(hit.cutoff) : "custom"; };
        const persist = () => {
            const next = Object.assign({}, options.grade_targets || {}, { [courseId]: target });
            options.grade_targets = next;
            chrome.storage.sync.set({ grade_targets: next });
        };
        input.value = String(target);
        syncSelect();
        select.addEventListener("change", () => {
            if (select.value === "custom") { input.focus(); return; }
            target = Number(select.value); input.value = String(target); persist(); refresh();
        });
        input.addEventListener("input", () => {
            const v = Number(input.value);
            if (!(v > 0 && v <= 100)) return;
            target = v; syncSelect(); persist(); refresh();
        });
        refresh();

        card.append(head, controls, result, table);
        if (embedded) {
            card.classList.add("cr-gt--embedded");
            host.dataset.course = courseId;
            host.replaceChildren(card);
        } else {
            const parent = anchor.id === "grades_summary" ? anchor.parentNode : anchor;
            if (anchor.id === "grades_summary") parent.insertBefore(card, anchor);
            else parent.prepend(card);
        }
    } finally {
        xGradeTargetLoading = null;
    }
}
let xGradeTargetLoading = null;

// ---- "Can still improve" list ----------------------------------------------------------------------
// Tool-based homework (Wiley, Connect) allows repeat attempts and Canvas calls it "graded" after the
// first one, so a 63% looks finished. This lists those assignments, lowest score first, in the Tasks list.
let xImproveItems = [];
let xImproveRequested = false;

async function xLoadImprove() {
    if (options.todo_improve === false) { xImproveItems = []; return; }
    const rows = await xGetCourseAssignments();
    const ignored = new Set(Array.isArray(options.improve_ignored) ? options.improve_ignored : []);
    const below = Number(options.improve_below) > 0 ? Number(options.improve_below) : 100;
    const now = Date.now();
    const items = rows.filter(a => {
        const s = a.submission || {};
        const pts = Number(a.points_possible) || 0;
        const types = a.submission_types || [];
        if (!types.includes("external_tool")) return false;
        if (pts <= 0 || a.published === false || a.locked_for_user === true || s.excused) return false;
        if (s.score === null || s.score === undefined || s.score >= pts) return false;
        if ((s.score / pts) * 100 >= below) return false;
        if (/attendance|roll call|orientation|survey/i.test(a.name || "")) return false;
        if (ignored.has("assignment_" + a.id)) return false;
        const attempts = a.allowed_attempts;
        const unlimited = attempts === null || attempts === undefined || attempts === -1;
        if (!unlimited && !((s.attempt || 0) < attempts)) return false;
        if (a.due_at && new Date(a.due_at).getTime() < now && !(a.lock_at && new Date(a.lock_at).getTime() > now)) return false;
        return true;
    }).map(a => {
        const s = a.submission;
        const pct = Math.round((s.score / a.points_possible) * 100);
        let path = "";
        try { path = new URL(a.html_url).pathname; } catch (e) { path = "/courses/" + a.course_id + "/assignments/" + a.id; }
        return {
            improve: true,
            plannable_id: a.id,
            plannable_type: "assignment",
            course_id: a.course_id,
            plannable_date: a.due_at || null,
            plannable: { title: a.name, points_possible: a.points_possible, course_id: a.course_id },
            html_url: path,
            submissions: { submitted: true, graded: true },
            improvePct: pct,
            improveText: pct + "% · attempt " + (s.attempt || 1) + " · can still improve",
        };
    }).sort((x, y) => x.improvePct - y.improvePct).slice(0, 10);
    xImproveItems = items;
}

function xEnsureImproveLoaded() {
    if (xImproveRequested) return;
    xImproveRequested = true;
    xLoadImprove().then(() => {
        const list = document.querySelector("#canvasrefined-todo-list");
        if (list && document.getElementById("better-todo-main")) { clearTodoList(); createTodoSections(list); }
    }).catch(() => { /* try again on the next page load */ });
}

function visibleImproveItems() {
    if (options.todo_improve === false) return [];
    let items = getTodoScopedData(xImproveItems, getCurrentCourseId());
    if (betterTodoProgressFilter != null) items = items.filter(it => String(it.course_id) === String(betterTodoProgressFilter));
    return items.filter(it => it.planner_override?.marked_complete !== true);
}

function xIgnoreImprove(item) {
    const key = "assignment_" + item.plannable_id;
    const list = (Array.isArray(options.improve_ignored) ? options.improve_ignored : []).filter(k => k !== key).concat(key).slice(-80);
    options.improve_ignored = list;
    chrome.storage.sync.set({ improve_ignored: list });
    xImproveItems = xImproveItems.filter(it => it.plannable_id !== item.plannable_id);
}

function xAttachImproveDismiss(root, item) {
    const btn = root.querySelector(".cr-card-dismiss");
    if (!btn) return;
    btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        xIgnoreImprove(item);
        root.remove();
    });
}

// ---- Grade change alerts ------------------------------------------------------------------------------
// Compares each graded score with the last one seen (kept in storage.local) and shows a card when a grade
// posts or changes. The first run only records a baseline, so nothing floods in on install.
async function xCheckGradeAlerts() {
    if (options.grade_alerts === false || quizSafeModeActive()) return;
    const stored = (await chrome.storage.local.get(["x_grade_snapshot", "x_grade_checked"]));
    if (Date.now() - (stored.x_grade_checked || 0) < 9 * 60000) return;
    chrome.storage.local.set({ x_grade_checked: Date.now() });
    const rows = await xGetCourseAssignments();
    if (!rows.length) return;
    const now = {};
    rows.forEach(a => { const s = a.submission || {}; if (s.score !== null && s.score !== undefined && !s.excused) now[a.id] = s.score; });
    const before = stored.x_grade_snapshot;
    chrome.storage.local.set({ x_grade_snapshot: now });
    if (!before) return;
    const changes = rows.filter(a => a.id in now && (!(a.id in before) || Math.abs(before[a.id] - now[a.id]) > 0.001) && (a.points_possible || 0) > 0)
        .map(a => ({ a, from: a.id in before ? before[a.id] : null, to: now[a.id] }));
    if (!changes.length) return;
    const pctOf = (score, a) => Math.round((score / a.points_possible) * 100) + "%";
    xShowGradeToast(changes.slice(0, 5).map(c => ({
        href: domain + (function () { try { return new URL(c.a.html_url).pathname; } catch (e) { return "/courses/" + c.a.course_id + "/assignments/" + c.a.id; } })(),
        name: c.a.name,
        meta: (c.from === null ? "New grade · " + pctOf(c.to, c.a) : pctOf(c.from, c.a) + " → " + pctOf(c.to, c.a)) + " · " + xCourseName(c.a.course_id),
        cid: String(c.a.course_id),
    })), changes.length);
}

function xShowGradeToast(rows, total) {
    document.getElementById("canvasrefined-grades")?.remove();
    if (!document.body) return;
    const toast = document.createElement("section");
    toast.id = "canvasrefined-grades";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    const head = document.createElement("div");
    head.className = "cr-ds-head";
    const title = document.createElement("span");
    title.className = "cr-ds-title cr-ds-title--grade";
    title.textContent = total === 1 ? "1 grade update" : total + " grade updates";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "cr-ds-close";
    close.setAttribute("aria-label", "Dismiss");
    close.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    close.addEventListener("click", () => toast.remove());
    head.append(title, close);
    const list = document.createElement("div");
    list.className = "cr-ds-list";
    rows.forEach(r => {
        const a = document.createElement("a");
        a.className = "cr-ds-item";
        a.href = r.href;
        a.style.setProperty("--cr-course", r.cid ? courseRingColor(r.cid, 0) : "var(--cr-mute)");
        const name = document.createElement("span");
        name.className = "cr-ds-name";
        name.textContent = r.name;
        const meta = document.createElement("span");
        meta.className = "cr-ds-meta";
        meta.textContent = r.meta;
        a.append(name, meta);
        list.appendChild(a);
    });
    const actions = document.createElement("div");
    actions.className = "cr-ds-actions";
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "cr-ds-btn cr-ds-btn--primary";
    ok.textContent = "Got it";
    ok.addEventListener("click", () => toast.remove());
    actions.appendChild(ok);
    toast.append(head, list, actions);
    crToastPrepend(toast);
}

xRegister({
    id: "grades",
    init() { setTimeout(() => { xCheckGradeAlerts().catch(() => {}); }, 4000); },
    tick() {
        xMountGradeTarget().catch(() => {});
        xCheckGradeAlerts().catch(() => {});
    },
    onChange(keys) {
        if (keys.includes("grade_target") || keys.includes("grade_analytics")) { document.getElementById("cr-grade-target")?.remove(); if (document.getElementById("canvasrefined-ga-target")) document.getElementById("canvasrefined-ga-target").dataset.course = ""; }
        if (keys.includes("todo_improve") || keys.includes("improve_ignored") || keys.includes("improve_below")) {
            xImproveRequested = false;
            if (document.getElementById("better-todo-main")) xEnsureImproveLoaded();
        }
    },
});
