// Checkmate: shared plumbing for the extra features (grade target, retry list, coming up,
// recap, notes and so on). This file loads right after content.js, in the same content-script
// world, so it can call content.js helpers directly (options, domain, assignments, ...).
//
// Each feature file registers itself with xRegister({ id, init, tick, onChange }):
//   init()           once, after the student's options are loaded
//   tick()           whenever the page changes (debounced) and on a slow timer
//   onChange(keys)   when a stored option changes
const xFeatures = [];
function xRegister(feature) { xFeatures.push(feature); }

const X_DAY = 86400000;
const X_HOUR = 3600000;

// GET a Canvas API url as JSON, following "next" links for list endpoints. Returns null on
// any failure so callers can simply skip the feature for now.
async function xFetchJson(url, maxPages = 6) {
    let out = null;
    let next = url;
    for (let page = 0; next && page < maxPages; page++) {
        let response;
        try {
            response = await fetch(next, { headers: { "Accept": "application/json" } });
        } catch (e) { return out; }
        if (!response.ok) return out;
        let data;
        try { data = await response.json(); } catch (e) { return out; }
        if (Array.isArray(data)) out = (out || []).concat(data);
        else return data;
        const link = response.headers.get("Link") || "";
        const m = link.match(/<([^>]+)>;\s*rel="next"/);
        next = m ? m[1] : null;
    }
    return out;
}

// The classes shown on the dashboard (an old orientation course can still count as an active
// enrollment, so the dashboard list is the better definition of "my classes").
async function xCourseIds() {
    let active = null;
    try { active = await fetchActiveCourseIds(); } catch (e) { active = null; }
    const cards = options.custom_cards || {};
    const onDashboard = Object.keys(cards).filter(id => cards[id]?.hidden !== true);
    if (onDashboard.length) return onDashboard.filter(id => !active || active.has(id) || active.has(Number(id)));
    return active ? Array.from(active).map(String) : [];
}

function xCourseName(courseId) {
    const c = options.custom_cards?.[courseId] || {};
    return c.name || c.fullName || c.default || "";
}

// Every assignment (with the student's submission) for every dashboard class, cached for a few
// minutes in memory so the retry list, grade alerts and recap share one set of requests.
const xAssignCache = { at: 0, promise: null };
function xGetCourseAssignments(force = false) {
    if (!force && xAssignCache.promise && Date.now() - xAssignCache.at < 8 * 60000) return xAssignCache.promise;
    xAssignCache.at = Date.now();
    xAssignCache.promise = (async () => {
        const ids = await xCourseIds();
        const rows = await Promise.all(ids.slice(0, 12).map(async id => {
            const list = await xFetchJson(domain + "/api/v1/courses/" + id + "/assignments?include[]=submission&per_page=100");
            return (list || []).map(a => Object.assign({}, a, { course_id: Number(id) }));
        }));
        return rows.flat();
    })();
    return xAssignCache.promise;
}

// Small values (a few hundred bytes to a few KB) cached in storage.local with an expiry.
async function xCacheGet(key, maxAgeMs) {
    try {
        const stored = (await chrome.storage.local.get(key))[key];
        if (stored && Date.now() - stored.at < maxAgeMs) return stored.value;
    } catch (e) { /* no cache */ }
    return null;
}
function xCacheSet(key, value) {
    try { chrome.storage.local.set({ [key]: { at: Date.now(), value } }); } catch (e) { /* ignore */ }
}

function xStripHtml(html) {
    return String(html || "").replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/tr>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/[ \t]+/g, " ").replace(/\n\s*/g, "\n").trim();
}

// ---- Dashboard widgets: one host above the course cards, ordered by rank ---------------------
function xWidgetHost() {
    const container = document.querySelector("#DashboardCard_Container");
    if (!container) return null;
    let host = document.getElementById("cr-widgets");
    if (!host) {
        host = document.createElement("div");
        host.id = "cr-widgets";
        const parent = container.parentNode;
        const pinned = document.querySelector(".canvasrefined-pinned-card");
        if (parent) parent.insertBefore(host, pinned && pinned.parentNode === parent ? pinned : container);
        else container.prepend(host);
    }
    return host;
}
function xMountWidget(el, rank) {
    const host = xWidgetHost();
    if (!host) return false;
    el.dataset.rank = String(rank);
    if (el.parentNode !== host) {
        const after = Array.from(host.children).find(c => Number(c.dataset.rank) > rank);
        host.insertBefore(el, after || null);
    }
    return true;
}
function xUnmountWidget(id) {
    document.getElementById(id)?.remove();
    const host = document.getElementById("cr-widgets");
    if (host && !host.children.length) host.remove();
}

// ---- Start-up ----------------------------------------------------------------------------------
let xObserver = null;
let xTimer = null;
let xStarted = false;

function xRunTicks() {
    xTimer = null;
    xFeatures.forEach(f => { try { f.tick && f.tick(); } catch (e) { console.warn("Checkmate extra:", f.id, e); } });
}
function xScheduleTick(delay = 500) {
    if (xTimer) return;
    xTimer = setTimeout(xRunTicks, delay);
}

function initExtras() {
    if (xStarted) return;
    xStarted = true;
    xFeatures.forEach(f => { try { f.init && f.init(); } catch (e) { console.warn("Checkmate extra:", f.id, e); } });
    xObserver = new MutationObserver(() => xScheduleTick(600));
    xObserver.observe(document.documentElement, { childList: true, subtree: true });
    [100, 1800, 4500].forEach(d => setTimeout(xRunTicks, d));
    setInterval(xRunTicks, 60 * 1000);

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "sync") return;
        Object.keys(changes).forEach(k => { options[k] = changes[k].newValue; });
        xFeatures.forEach(f => { try { f.onChange && f.onChange(Object.keys(changes)); } catch (e) { console.warn("Checkmate extra:", f.id, e); } });
        xScheduleTick(200);
    });
}
