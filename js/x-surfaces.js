// Checkmate extras: light-surface repair for Canvas' own screens in dark mode.
// Dark mode restyles Canvas with fixed selectors, so a new or rarely used screen (rubrics, discussion toolbars,
// dialogs) can still come up as a white box with dark or washed-out text. This pass looks at what is actually
// painted: any near-white surface becomes the theme's surface colour, and any text that would then be hard to
// read takes the theme's text colour. Instructor pages (.user_content) have their own pass and are skipped.
// Fixes are attributes (data-cmsf, data-cmsf-text) applied by rules in themed.css, so nothing inline is edited
// and everything is undone when dark mode turns off. Relies on x-core.js and content.js helpers.

const X_SURF_SKIP = ".user_content, #better-sidebar-container, #cr-toasts, #cr-focus, .cr-card, .ic-DashboardCard, [id^='cr-'], [class*='canvasrefined'], iframe, img, video, canvas, picture";
const X_SURF_BATCH = 2500;
let xSurfBg = null;
let xSurfPage = null;
let xSurfMore = false;

function xSurfActive() {
    return (options.dark_mode === true || options.device_dark === true) && options.theming_off !== true && !!options.dark_preset && !quizSafeModeActive();
}

// What an element's text sits on: the nearest ancestor with a visible background (marked surfaces count as the
// theme surface), else the page background.
function xSurfBehind(el, cache) {
    let node = el;
    const chain = [];
    let result = null;
    while (node && node.nodeType === 1) {
        if (cache.has(node)) { result = cache.get(node); break; }
        chain.push(node);
        if (node.getAttribute("data-cmsf") === "s") { result = xSurfBg; break; }
        const bg = cssToRgba(getComputedStyle(node).backgroundColor);
        if (bg && bg[3] > 0.5) { result = bg; break; }
        node = node.parentElement;
    }
    if (!result) result = xSurfPage;
    chain.forEach(n => cache.set(n, result));
    return result;
}

function xSurfPass() {
    if (!xSurfActive() || !document.body) return;
    xSurfBg = cssToRgba(options.dark_preset["background-1"]);
    xSurfPage = cssToRgba(options.dark_preset["background-0"]);
    if (!xSurfBg || !xSurfPage) return;

    const candidates = [];
    const all = document.body.getElementsByTagName("*");
    for (let i = 0; i < all.length && candidates.length < X_SURF_BATCH; i++) {
        const el = all[i];
        if (el.hasAttribute("data-cmsf-seen")) continue;
        if (el.closest(X_SURF_SKIP)) { el.setAttribute("data-cmsf-seen", "skip"); continue; }
        candidates.push(el);
    }
    xSurfMore = candidates.length >= X_SURF_BATCH;

    // 1) Light surfaces. Parents come before children in document order, so text checks below see them.
    candidates.forEach(el => {
        el.setAttribute("data-cmsf-seen", "1");
        if (el instanceof SVGElement) return; // icons are handled in step 3
        const cs = getComputedStyle(el);
        if (cs.backgroundImage && cs.backgroundImage !== "none") return;
        const bg = cssToRgba(cs.backgroundColor);
        if (bg && bg[3] >= 0.9 && relativeLuminance(bg) > 0.8) el.setAttribute("data-cmsf", "s");
        // A pale, semi-transparent sheet over the whole window (a dialog's backdrop) becomes a dark veil.
        else if (bg && bg[3] >= 0.3 && bg[3] < 0.9 && relativeLuminance(bg) > 0.8 && cs.position === "fixed") {
            const r = el.getBoundingClientRect();
            if (r.width >= window.innerWidth * 0.9 && r.height >= window.innerHeight * 0.9) el.setAttribute("data-cmsf", "m");
        }
    });

    // 2) Text that has become hard to read on what is behind it.
    const cache = new Map();
    candidates.forEach(el => {
        if (el instanceof SVGElement) return;
        let hasText = false;
        for (let n = el.firstChild; n; n = n.nextSibling) {
            if (n.nodeType === 3 && n.nodeValue.trim()) { hasText = true; break; }
        }
        const iconOnly = !hasText && (el.tagName === "BUTTON" || el.tagName === "A" || el.getAttribute("role") === "button") && !!el.querySelector(":scope > svg, :scope > span > svg");
        if (!hasText && !iconOnly && !(el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")) return;
        const fg = cssToRgba(getComputedStyle(el).color);
        if (!fg) return;
        const behind = xSurfBehind(el, cache);
        // Only grey-ish text is recoloured; coloured text (errors, links, badges) keeps its meaning.
        const spread = Math.max(fg[0], fg[1], fg[2]) - Math.min(fg[0], fg[1], fg[2]);
        if (spread < 60 && contrastRatio(fg, behind) < 3.2) el.setAttribute("data-cmsf-text", "1");
    });

    // 3) Icons drawn in black or dark grey (the fill is set on the SVG, not through the text colour).
    candidates.forEach(el => {
        if (!(el instanceof SVGElement) || el.tagName.toLowerCase() === "svg" && el.closest("[data-cmsf-seen='skip']")) return;
        const cs = getComputedStyle(el);
        const host = el.closest("svg");
        const around = host && host.parentElement ? xSurfBehind(host.parentElement, cache) : xSurfPage;
        const dim = (value) => {
            if (!value || value === "none") return false;
            const c = cssToRgba(value);
            if (!c || c[3] < 0.3) return false;
            const spread = Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
            return spread < 60 && contrastRatio(c, around) < 3.2;
        };
        if (dim(cs.fill)) el.setAttribute("data-cmsf-fill", "1");
        if (dim(cs.stroke)) el.setAttribute("data-cmsf-stroke", "1");
    });
}

function xSurfReset() {
    document.querySelectorAll("[data-cmsf], [data-cmsf-text], [data-cmsf-seen], [data-cmsf-fill], [data-cmsf-stroke]").forEach(el => {
        el.removeAttribute("data-cmsf");
        el.removeAttribute("data-cmsf-text");
        el.removeAttribute("data-cmsf-seen");
        el.removeAttribute("data-cmsf-fill");
        el.removeAttribute("data-cmsf-stroke");
    });
}

xRegister({
    id: "surfaces",
    init() { try { xSurfPass(); } catch (e) { console.warn("Checkmate: surface pass", e); } },
    tick() {
        if (!xSurfActive()) { if (document.querySelector("[data-cmsf-seen]")) xSurfReset(); return; }
        xSurfPass();
        if (xSurfMore) xScheduleTick(300);
    },
    onChange(keys) {
        if (keys.some(k => k === "dark_mode" || k === "device_dark" || k === "dark_preset" || k === "theming_off")) { xSurfReset(); xScheduleTick(200); }
    },
});
