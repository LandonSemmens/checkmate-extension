// Checkmate extras: day/night themes and notes with steps on assignment pages.
// Relies on x-core.js and content.js helpers.

// ---- Day and night themes ------------------------------------------------------------------------------
// The popup saves the current look into two slots (theme_slot_day, theme_slot_night). While the schedule is
// on, this swaps the slot in at the day and night start times. A manual change in between is left alone
// until the next boundary, because only a boundary (or the schedule being switched on) triggers a swap.
const X_THEME_KEYS = ["dark_preset", "dark_mode", "customBackgroundLink", "customBackgroundScale", "fitImageToScreen", "custom_font"];

function xParseClock(value, fallback) {
    const [h, m] = String(value || fallback).split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
}
function xWantedThemeSlot(now = new Date()) {
    const cur = now.getHours() * 60 + now.getMinutes();
    const day = xParseClock(options.theme_day_start, "07:00");
    const night = xParseClock(options.theme_night_start, "19:00");
    const isNight = day < night ? (cur >= night || cur < day) : (cur >= night && cur < day);
    return isNight ? "night" : "day";
}

async function xApplyThemeSchedule() {
    if (options.theme_schedule !== true) return;
    const slot = xWantedThemeSlot();
    const values = options["theme_slot_" + slot];
    if (!values || typeof values !== "object") return;
    const stored = await chrome.storage.local.get("x_theme_active");
    if (stored.x_theme_active === slot) return;
    const patch = {};
    X_THEME_KEYS.forEach(k => { if (k in values) patch[k] = values[k]; });
    await chrome.storage.local.set({ x_theme_active: slot });
    if (Object.keys(patch).length) chrome.storage.sync.set(patch);
}

// ---- Notes and steps on assignment pages --------------------------------------------------------------
// A small card under the title: a checklist of steps and free-form notes, saved per assignment in
// storage.local. Tasks cards show a "2/5 steps" chip when an assignment has steps.
let xNotes = {};
let xNotesLoaded = false;

async function xLoadNotes() {
    if (xNotesLoaded) return;
    xNotesLoaded = true;
    try { xNotes = (await chrome.storage.local.get("x_notes")).x_notes || {}; } catch (e) { xNotes = {}; }
}
function xSaveNotes() {
    const keys = Object.keys(xNotes);
    if (keys.length > 300) keys.slice(0, keys.length - 300).forEach(k => delete xNotes[k]);
    chrome.storage.local.set({ x_notes: xNotes });
}

function xNotesChipHtml(item) {
    const n = xNotes[todoPinKey(item)];
    if (options.assignment_notes === false || !n || !Array.isArray(n.steps) || !n.steps.length) return "";
    const done = n.steps.filter(s => s.d).length;
    return ' <span class="cr-steps-chip' + (done === n.steps.length ? " is-done" : "") + '" title="Your steps for this assignment">' + done + "/" + n.steps.length + " steps</span>";
}

function xBuildNotesCard(key) {
    const entry = xNotes[key] || { text: "", steps: [] };
    xNotes[key] = entry;
    const card = document.createElement("details");
    card.id = "cr-notes";
    card.className = "cr-notes";
    card.dataset.key = key;
    card.open = !!(entry.text || entry.steps.length);

    const summary = document.createElement("summary");
    summary.className = "cr-notes-summary";
    const label = document.createElement("span");
    label.textContent = "My notes and steps";
    const progress = document.createElement("span");
    progress.className = "cr-notes-progress";
    summary.append(label, progress);

    const list = document.createElement("ul");
    list.className = "cr-notes-steps";
    const add = document.createElement("input");
    add.type = "text";
    add.className = "cr-notes-add";
    add.placeholder = "Add a step and press Enter";
    add.setAttribute("aria-label", "Add a step");
    const area = document.createElement("textarea");
    area.className = "cr-notes-text";
    area.placeholder = "Notes for this assignment";
    area.rows = 3;
    area.setAttribute("aria-label", "Notes");
    area.value = entry.text || "";

    const renderSteps = () => {
        list.replaceChildren();
        entry.steps.forEach((step, i) => {
            const li = document.createElement("li");
            li.className = "cr-step" + (step.d ? " is-done" : "");
            const box = document.createElement("input");
            box.type = "checkbox";
            box.checked = !!step.d;
            box.setAttribute("aria-label", "Done: " + step.t);
            box.addEventListener("change", () => { step.d = box.checked; xSaveNotes(); renderSteps(); });
            const text = document.createElement("span");
            text.textContent = step.t;
            const del = document.createElement("button");
            del.type = "button";
            del.className = "cr-step-del";
            del.setAttribute("aria-label", "Remove step");
            del.textContent = "×";
            del.addEventListener("click", () => { entry.steps.splice(i, 1); xSaveNotes(); renderSteps(); });
            li.append(box, text, del);
            list.appendChild(li);
        });
        const done = entry.steps.filter(s => s.d).length;
        progress.textContent = entry.steps.length ? done + "/" + entry.steps.length : "";
    };
    add.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        const t = add.value.trim();
        if (!t) return;
        entry.steps.push({ t: t.slice(0, 140), d: false });
        add.value = "";
        xSaveNotes();
        renderSteps();
    });
    let timer = null;
    area.addEventListener("input", () => {
        entry.text = area.value.slice(0, 4000);
        clearTimeout(timer);
        timer = setTimeout(xSaveNotes, 500);
    });
    renderSteps();
    card.append(summary, list, add, area);
    return card;
}

async function xTickNotes() {
    const existing = document.getElementById("cr-notes");
    const ref = options.assignment_notes === false || typeof pageAssignmentRef !== "function" ? null : pageAssignmentRef();
    if (!ref) { existing?.remove(); return; }
    const key = ref.type + "_" + ref.id;
    if (existing && existing.dataset.key === key && existing.isConnected) return;
    existing?.remove();
    await xLoadNotes();
    const heading = document.querySelector("#content h1.title, #content h1, h1.title, #content h2.title");
    if (!heading) return;
    let anchor = heading;
    while (anchor.parentElement && anchor.parentElement.id !== "content" && anchor.parentElement.tagName !== "BODY" && !anchor.parentElement.classList.contains("ic-Layout-contentMain")) anchor = anchor.parentElement;
    if (document.getElementById("cr-notes")) return;
    anchor.insertAdjacentElement("afterend", xBuildNotesCard(key));
}

xRegister({
    id: "themes-notes",
    init() {
        xLoadNotes();
        xApplyThemeSchedule();
    },
    tick() {
        xApplyThemeSchedule().catch(() => {});
        xTickNotes().catch(() => {});
    },
    onChange(keys) {
        if (keys.some(k => k.startsWith("theme_"))) {
            if (options.theme_schedule === true) chrome.storage.local.remove("x_theme_active");
            xApplyThemeSchedule().catch(() => {});
        }
        if (keys.includes("assignment_notes") && options.assignment_notes === false) document.getElementById("cr-notes")?.remove();
    },
});
