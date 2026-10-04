// v3.2.4 — שינוי שם/מיקום של תיקייה במאגר (PATH_RENAMES) מוזז עכשיו גם
// בפועל בדיסק של המשתמש, לא רק בסטטוס ("מעודכן"/"חדש"): ראו
// migrateRenamedFoldersOnDisk. דורש fs.moveEntry (אוצריא 0.9.98+, לא עדיין
// בגרסה יציבה) — כשל שקט אצל משתמשים ישנים יותר, אין נסיגה בפונקציונליות.
// v3.2.3 — תיקון הודעת שגיאה מטעה כשבחירת תיקייה נדחית (למשל תיקייה בתוך
// תיקיית אוצריא/מערכת): הוצגה בטעות הודעת "רשימת ההיתר לרשת" כי
// describeFetchError וקוד הדחייה של ui.pickFolder חולקים אותו קידומת
// error.forbidden. ראו describeFolderError.
// v3.2.2 — נוספה הרשאת fs.folder_access (חסרה מה-manifest; בלעדיה
// ui.pickFolder נכשל בשקט עם permission_denied וכפתורי ההורדה לא עשו דבר)
// v3.2.1 — network.fetch הוחלף ב-network.fetchStream (הוסר באוצריא 0.9.98)
// מאגר ההפצה הפעיל. Open-Otzarya-Projects הוקפא ב-29/6/2026 וחסרים בו 17
// מ-85 קבצי ה-zip, ולכן הרשימה וההורדות עברו לכאן.
//
// דורש אישור ברשימת ההיתר של אוצריא (plugin_network_allowlist) — שלוש
// הכתובות של הריפו הזה תחת api.github.com, github.com ו-raw.githubusercontent.
// עד שהאישור נכנס לתוקף, network.fetch נחסם והרשימה לא נטענת כלל.
// raw.githubusercontent נחסם לפעמים גם לאחר האישור ע"י מסנני תוכן (למשל NetFree
// מחזיר עמוד חסימה במקום התוכן) — לכן יש גיבוי דרך Contents API, ראה fetchBooksData.
const GITHUB_REPO    = 'YairDaniel11/Otzarya-Unofficial-Books';
const LATEST_DL      = `https://github.com/${GITHUB_REPO}/releases/latest/download/`;
// cache-buster: raw.githubusercontent מוגש דרך CDN שמחזיק תשובה עד 5 דקות,
// ובלעדיו רענון מיד אחרי דחיפת רשימה חדשה היה מחזיר את הגרסה הקודמת.
const BOOKS_DATA_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/books_data.js`;
function booksDataUrl() {
    return `${BOOKS_DATA_URL}?t=${Date.now()}`;
}
// גיבוי כש-raw.githubusercontent חסום (מסנני תוכן כמו NetFree מחזירים עמוד
// חסימה במקומו) — Contents API של גיטהאב עצמו, שאינו נחסם באותו אופן.
const CONTENTS_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/contents/books_data.js?ref=main`;

let expandedPaths  = new Set();
let booted         = false;
let currentManifest = [];
let filterNewOnly  = false;

// "שס וגשל" בתוך "תלמוד בבלי" הוא ~475MB מתוך ~612MB. מי שלא מוריד אותו
// עדיין רוצה לדעת מה חדש ב"תלמוד בבלי" — לכן ההגדרה הזו מוציאה את התיקייה
// מחישובי הסטטוס וההורדה של התיקייה שמעליה.
const SHAS_PATH = 'תלמוד בבלי/שס וגשל';
let ignoreShas  = false;
let cachedHashes   = {};   // טעון פעם אחת ב-boot, מתעדכן ב-saveHash
let dlDone = 0, dlTotal = 0;
let cancelRequested = false;   // מסומן ע"י כפתור "עצור"; נבדק בין קבצים/ניסיונות (לא ניתן לבטל הורדת קובץ בודד תוך כדי, אין API לכך)


// ─── אייקונים — SVG paths מ-google/material-design-icons (GitHub) ──
const MI_CHECK_CIRCLE =
    'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z' +
    'm-2 14.5l-4.5-4.5 1.41-1.41L10 13.67l7.09-7.09 1.41 1.41L10 16.5z';
const MI_SYNC =
    'M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46' +
    'C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6' +
    ' 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z';

function makeSvgIcon(d, color) {
    const ns  = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width',  '16');
    svg.setAttribute('height', '16');
    svg.classList.add('status-icon');
    svg.style.fill = color;
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
    return svg;
}

// ─── fetch ─────────────────────────────────────────────────────────

/// סיבת הכישלון האחרונה של [fetchBooksData], להצגה למשתמש. `null` = הצליח.
///
/// בעבר כל כישלון נבלע ב-`catch { return null }` והוצג כ"לא ניתן לטעון את
/// רשימת הספרים" — הודעה זהה לאין-אינטרנט, ל-404, לכתובת חסומה ול-JSON שבור.
/// אוצריא כן מחזירה סיבה מדויקת (למשל `error.forbidden` כשהכתובת אינה
/// ברשימת ההיתר), וכאן היא נשמרת במקום להיזרק.
let lastFetchError = null;

/// מחלצת טקסט קריא משגיאה שיכולה להגיע כמחרוזת, כ-Error, או כאובייקט
/// `{code, message}` מהגשר. `String(obj)` היה מחזיר "[object Object]".
function errorText(raw) {
    if (raw == null) return '';
    if (typeof raw === 'string') return raw;
    if (raw instanceof Error) return raw.message || String(raw);
    if (typeof raw === 'object') {
        const parts = [raw.code, raw.message, raw.error, raw.details]
            .filter(v => typeof v === 'string' && v);
        if (parts.length) return parts.join(': ');
        try {
            const json = JSON.stringify(raw);
            if (json && json !== '{}') return json;
        } catch { /* מבנה מעגלי */ }
        return '';
    }
    return String(raw);
}

/// ממפה שגיאה גולמית להודעה בעברית שאומרת למשתמש מה לעשות.
///
/// הטקסט הגולמי (`raw`) מצורף בסוגריים בכל מקרה — גם כשהוא נופל תחת אחת
/// מהקטגוריות המוכרות — כי הקטגוריות מבוססות על ניחוש דפוסים, וכשהניחוש שגוי
/// (למשל "network" מופיע גם בשגיאות שאינן קשורות לרשת בפועל) הטקסט הגולמי הוא
/// הדרך היחידה לאבחן מה קרה באמת.
function describeFetchError(raw) {
    const text = errorText(raw);
    const suffix = text ? ` (גולמי: ${text.replace(/^Exception:\s*/, '').slice(0, 200)})` : '';
    if (text.includes('error.forbidden')) {
        return 'הכתובת אינה ברשימת ההיתר לגישת רשת של תוספים באוצריא. ' +
               `יש לאשר את ${GITHUB_REPO} ברשימת ההיתר.${suffix}`;
    }
    if (text.includes('error.permission_denied')) {
        return `לתוסף אין הרשאת גישה לאינטרנט. ניתן להפעיל בהגדרות → ניהול תוספים.${suffix}`;
    }
    if (/timeout|timed out/i.test(text)) return `הבקשה לגיטאב פגה בזמן.${suffix}`;
    if (/SocketException|Failed host lookup|network|ClientException/i.test(text)) {
        return `אין חיבור לאינטרנט או שגיטאב אינו נגיש.${suffix}`;
    }
    if (text) return text.replace(/^Exception:\s*/, '').slice(0, 300);
    return 'לא התקבל פירוט מאוצריא. נסה שוב, ואם זה חוזר — בדוק חיבור לאינטרנט.';
}

/// ממפה שגיאה מ-`ui.pickFolder` להודעה בעברית.
///
/// **לא** משתמשת ב-[describeFetchError]: שתי הפעולות מקודדות שגיאת דחייה
/// באותו קוד (`error.forbidden`) מסיבות שונות לגמרי — כתובת רשת לא מאושרת
/// מול תיקייה מוגנת (מערכת/אוצריא/תיקיית הבית/רשת) — ו-describeFetchError
/// הייתה מציגה בטעות את הודעת "רשימת ההיתר לרשת" גם כשהבעיה היא שהתיקייה
/// שנבחרה נמצאת בתוך תיקיית אוצריא. ה-message שאוצריא מחזירה כאן היא כבר
/// טקסט עברי קריא (למשל "תיקיות המערכת ותיקיות אוצריא אינן מותרות
/// לתוספים") — מציגים אותו כמות שהוא, בלי לנחש קטגוריה.
function describeFolderError(raw) {
    const text = errorText(raw);
    if (text.includes('error.permission_denied')) {
        return 'לתוסף אין הרשאת גישה לתיקיות. ניתן להפעיל בהגדרות → ניהול תוספים.';
    }
    if (text.includes('error.forbidden')) {
        const reason = text.replace(/^error\.forbidden:\s*/, '').trim();
        return (reason || 'התיקייה שנבחרה אינה מותרת לתוספים') +
               ' — בחר תיקייה אחרת (למשל תת-תיקייה חדשה תחת המסמכים שלך, לא בתוך תיקיית אוצריא עצמה).';
    }
    return describeFetchError(raw);
}

function parseBooksDataText(text) {
    const json = text.replace(/^\s*const BOOKS_DATA\s*=\s*/, '').replace(/\s*;\s*$/, '');
    return JSON.parse(json);
}

/// `network.fetch` הוסר באוצריא 0.9.98 (מחזיר `error.unknown_method`) — התחליף
/// הרשמי הוא `network.fetchStream`, שמחזיר AsyncIterable של chunks במקום תשובה
/// אחת. העטיפה הזו צוברת אותם בחזרה לתשובה אחת כדי שהקוד סביבה יישאר כמו שהיה.
async function fetchText(url, options) {
    let meta = null, body = '';
    for await (const chunk of Otzaria.call('network.fetchStream', { url, ...(options || {}) })) {
        if (chunk.type === 'response') meta = chunk;
        else if (chunk.type === 'data') body += chunk.body;
    }
    if (!meta) throw new Error('no response');
    return { status: meta.status, ok: meta.ok, headers: meta.headers, body };
}

async function fetchBooksData() {
    lastFetchError = null;
    if (typeof Otzaria === 'undefined') {
        lastFetchError = 'התוסף פועל רק בתוך אוצריא.';
        return null;
    }

    try {
        const res = await fetchText(booksDataUrl());
        if (!res.ok) throw `גיטאב החזיר שגיאה ${res.status}.`;
        return parseBooksDataText(res.body);
    } catch (rawFail) {
        // ננסה גיבוי רק כשזו כשל רשת אמיתי (למשל חסימה של raw.githubusercontent
        // ע"י מסנן תוכן) — לא כשהכתובת עצמה נדחתה (אין הרשאה), כי אז גם ה-API יידחה.
        const rawErrorText = describeFetchError(rawFail?.message ?? rawFail);
        if (rawErrorText.includes('ברשימת ההיתר') || rawErrorText.includes('הרשאת גישה')) {
            lastFetchError = rawErrorText;
            return null;
        }

        try {
            const res = await fetchText(CONTENTS_API_URL, { headers: { Accept: 'application/vnd.github.raw' } });
            if (!res.ok) throw `גיטאב החזיר שגיאה ${res.status}.`;
            return parseBooksDataText(res.body);
        } catch (apiFail) {
            lastFetchError = rawErrorText || describeFetchError(apiFail?.message ?? apiFail);
            return null;
        }
    }
}

// ─── boot ──────────────────────────────────────────────────────────

async function boot(payload) {
    if (booted) return;
    booted = true;

    const fetched = await fetchBooksData();
    const local   = typeof BOOKS_DATA !== 'undefined' ? BOOKS_DATA : null;
    const fetchedHasHash = fetched && fetched.some(i => i.hash);
    const localHasHash   = local  && local.some(i => i.hash);
    const data = (fetchedHasHash ? fetched : (localHasHash ? local : fetched)) || local;

    if (!data || !data.length) {
        hideLoading();
        showError(
            'לא ניתן לטעון את רשימת הספרים' +
            (lastFetchError ? ' — ' + lastFetchError : ''),
            { retry: true },
        );
        return;
    }

    if (!fetched) {
        showError(
            'לא ניתן להתחבר לגיטאב — מוצגת הרשימה המקומית' +
            (lastFetchError ? ' (' + lastFetchError + ')' : ''),
            { retry: true },
        );
    }

    currentManifest = data.map(item => ({ ...item, downloadUrl: LATEST_DL + item.zip }));

    cachedHashes = await getStoredHashes();
    await loadDestFolder();
    await loadIgnoreShas();

    hideLoading();
    renderFullLibraryBtn();
    renderSummary();
    renderTree(currentManifest);
    initSearch();
    await initFilterBtn();
}

if (window.Otzaria) {
    Otzaria.on('plugin.boot',   boot);
    Otzaria.on('plugin.boot',   p => applyTheme(p.theme));
    Otzaria.on('theme.changed', t => applyTheme(t));
}
setTimeout(() => boot({}), 500);

// ─── עץ ────────────────────────────────────────────────────────────

function buildTree(manifest, parentPath) {
    return manifest
        .filter(item => item.parent === parentPath)
        .map(item => ({ ...item, children: buildTree(manifest, item.path) }));
}

function renderTree(manifest) {
    const roots = buildTree(manifest, '');
    const container = document.getElementById('tree');
    container.innerHTML = '';
    if (!roots.length) {
        container.innerHTML = '<div class="empty">אין נתונים להצגה</div>';
        return;
    }
    roots.forEach(node => container.appendChild(createNode(node, 0)));
}

function createNode(node, depth) {
    const hasChildren = node.children && node.children.length > 0;
    const isExpanded  = expandedPaths.has(node.path);

    const wrapper = document.createElement('div');
    wrapper.className = 'tree-node';

    const row = document.createElement('div');
    row.className = 'tree-row';
    row.style.paddingRight = (16 + depth * 24) + 'px';

    // ▸ / ▾ / •
    const toggle = document.createElement('span');
    toggle.className = 'toggle';
    if (hasChildren) {
        toggle.textContent = isExpanded ? '▾' : '▸';
        toggle.addEventListener('click', () => toggleNode(node.path));
    } else {
        toggle.textContent = '•';
        toggle.style.opacity = '0.25';
        toggle.style.cursor  = 'default';
    }
    row.appendChild(toggle);

    // אייקון סטטוס — SVG מ-google/material-design-icons
    if (node.hash && !isIgnored(node)) {
        const status = itemStatus(node);
        if (status !== 'none') {
            const isOk = status === 'ok';
            const icon = makeSvgIcon(isOk ? MI_CHECK_CIRCLE : MI_SYNC, isOk ? '#22c55e' : '#f59e0b');
            icon.title = isOk ? 'מעודכן' : 'יש עדכון זמין';
            row.appendChild(icon);
        }
    }

    // שם
    const name = document.createElement('span');
    name.className = 'node-name' + (hasChildren ? ' folder' : '');
    name.textContent = node.name;
    if (hasChildren) name.addEventListener('click', () => toggleNode(node.path));
    row.appendChild(name);

    // גודל
    if (node.size) {
        const size = document.createElement('span');
        size.className = 'node-size';
        size.textContent = node.size;
        row.appendChild(size);
    }

    // כפתור הורד
    const btn = document.createElement('button');
    btn.className = 'dl-btn';
    btn.textContent = 'הורד';
    btn.onclick = () => startDownload(node, btn);
    row.appendChild(btn);

    wrapper.appendChild(row);

    if (hasChildren && isExpanded) {
        const sub = document.createElement('div');
        sub.className = 'tree-children';
        node.children.forEach(child => sub.appendChild(createNode(child, depth + 1)));
        wrapper.appendChild(sub);
    }

    return wrapper;
}

function toggleNode(path) {
    expandedPaths.has(path) ? expandedPaths.delete(path) : expandedPaths.add(path);
    renderTree(currentManifest);
}

// ─── storage ───────────────────────────────────────────────────────

// שינויי שם של תיקיות במאגר: סטטוס ההורדה נשמר לפי path, ולכן שינוי שם
// מנתק את הסטטוס והאוסף מוצג כ"חדש" גם למי שכבר הורידו. המפתח הישן מועבר
// לחדש בטעינה (ראו migrateHashPaths), והתיקייה עצמה מוזזת בדיסק בפועל
// (ראו migrateRenamedFoldersOnDisk). מפתח ישן -> מפתח חדש; חלים גם על
// תתי-נתיבים.
const PATH_RENAMES = {
    "שו''ת": 'שו״ת',
};

// דגל: בוצע כבר ניסיון הזזה בדיסק בהרצה הנוכחית של התוסף (לא לפני שיש
// destFolder מאושר — ראו migrateRenamedFoldersOnDisk).
let diskRenamesMigrated = false;

/// מזיזה בפועל בדיסק כל תיקייה שברשימת [PATH_RENAMES], בתוך destFolder —
/// כדי שהמשתמש לא ייתקע עם שתי עותקים (הישן שנשאר, החדש שיירד בנפרד) אחרי
/// שינוי שם/מיקום במאגר המרוחק. דורשת fs.moveEntry (אוצריא 0.9.98+).
///
/// לא בודקת מראש אם המקור/היעד קיימים — אין API לכך בתוך תיקיית
/// ui.pickFolder (רק fs.extractZip/fs.deleteFile/fs.moveEntry/fs.deleteFolder).
/// במקום זה, פשוט קוראת ל-fs.moveEntry ומפרשת את השגיאה: error.not_found
/// (המקור לא קיים — כבר הוזז, או שהמשתמש מעולם לא הוריד את זה) ו-
/// error.invalid_params (היעד כבר קיים) הן שתיהן מצב יציב תקין, לא כשל
/// אמיתי. error.unknown_method — אוצריא ישנה מ-0.9.98: אין ברירה אלא
/// להשאיר את התיקייה הישנה במקומה עד שהמשתמש יעדכן.
async function migrateRenamedFoldersOnDisk(destFolder) {
    if (diskRenamesMigrated || typeof Otzaria === 'undefined') return;
    diskRenamesMigrated = true;
    for (const [from, to] of Object.entries(PATH_RENAMES)) {
        try {
            await Otzaria.call('fs.moveEntry', {
                from: destFolder + '/' + from,
                to: destFolder + '/' + to,
            });
        } catch {
            // ראו תיעוד הפונקציה — כל כשל כאן שקט ולא-קריטי.
        }
    }
}

/// מחיל את [PATH_RENAMES] על מפת ה-hashes. מחזיר את המפה ודגל אם השתנתה.
function migrateHashPaths(hashes) {
    let changed = false;
    const out = {};
    for (const [path, hash] of Object.entries(hashes)) {
        let key = path;
        for (const [from, to] of Object.entries(PATH_RENAMES)) {
            if (key === from) { key = to; break; }
            if (key.startsWith(from + '/')) { key = to + key.slice(from.length); break; }
        }
        if (key !== path) changed = true;
        // אם שני המפתחות קיימים — החדש קובע, שלא נדרוס מידע עדכני בישן.
        if (!(key in out) || key === path) out[key] = hash;
    }
    return { hashes: out, changed };
}

async function getStoredHashes() {
    try {
        let stored;
        if (typeof Otzaria !== 'undefined') {
            const res = await Otzaria.call('storage.get', { key: 'downloaded_hashes' });
            stored = res?.data || {};
        } else {
            stored = JSON.parse(localStorage.getItem('downloaded_hashes') || '{}');
        }
        // שתי מיגרציות: שינויי שם תיקייה (ישן), ומעבר ממפתח-נתיב למפתח-zip.
        const { hashes, changed } = migrateHashPaths(stored);
        const upgraded = migrateToStableKeys(hashes);
        if (upgraded.changed || changed) {
            await persistHashes(upgraded.hashes);
        }
        return upgraded.hashes;
    } catch { return {}; }
}

/// ממיר רשומות שנשמרו לפי `path` לרשומות לפי [statusKey] (שם ה-zip).
/// רשומה שאין לה פריט מתאים במאגר נשמרת כמות שהיא — אולי המאגר עוד ייטען.
function migrateToStableKeys(hashes) {
    if (!currentManifest.length) return { hashes, changed: false };
    const byPath = new Map(currentManifest.map(i => [i.path, i]));
    let changed = false;
    const out = {};
    for (const [key, hash] of Object.entries(hashes)) {
        const item = byPath.get(key);
        const target = item ? statusKey(item) : key;
        if (target !== key) changed = true;
        out[target] = hash;
    }
    return { hashes: out, changed };
}

async function persistHashes(hashes) {
    if (typeof Otzaria !== 'undefined') {
        await Otzaria.call('storage.set', { key: 'downloaded_hashes', value: hashes });
    } else {
        localStorage.setItem('downloaded_hashes', JSON.stringify(hashes));
    }
}

/// מפתח הסטטוס של פריט. שם קובץ ה-zip (`folder_0148.zip`) קבוע במאגר גם
/// כששם התיקייה משתנה, ולכן הוא עמיד בפני שינויי שם — בעוד `path` נשבר בהם
/// (למשל שו''ת -> שו״ת) וגורם להורדה מחדש של אוסף שלם.
function statusKey(item) {
    return item.zip || item.path;
}

/// כל הפריטים שבתוך [item] (כולל הוא עצמו) שיש להם zip ו-hash.
/// בזכות זה אפשר לדעת *מה* השתנה בתוך אוסף ולא רק *ש*הוא השתנה.
function subtreeOf(item, { respectIgnore = false } = {}) {
    const prefix = item.path + '/';
    return currentManifest.filter(
        i => i.hash && i.zip
            && (i.path === item.path || i.path.startsWith(prefix))
            && !(respectIgnore && isIgnored(i)),
    );
}

/// האם [item] הוא "שס וגשל" (או בתוכו) והמשתמש ביקש להתעלם ממנו.
function isIgnored(item) {
    return ignoreShas
        && (item.path === SHAS_PATH || item.path.startsWith(SHAS_PATH + '/'));
}

/// האם [item] הוא תיקיית-אב של התיקייה המתעלמת (כלומר "תלמוד בבלי"). ה-hash
/// וה-zip שלו כוללים את השס, ולכן אי אפשר להסתמך עליהם כשמתעלמים ממנו.
function hasIgnoredInside(item) {
    return ignoreShas && SHAS_PATH.startsWith(item.path + '/');
}

/// סטטוס יעיל של פריט: 'none' (לא הורד) | 'ok' | 'update'.
/// פריט רגיל נקבע לפי ה-hash שלו; אב של תיקייה מתעלמת — לפי שאר תתי-הפריטים.
function itemStatus(item) {
    if (!hasIgnoredInside(item)) {
        const stored = storedHashFor(item);
        if (!stored) return 'none';
        return stored === item.hash ? 'ok' : 'update';
    }
    const subs = subtreeOf(item, { respectIgnore: true }).filter(n => n.path !== item.path);
    if (!subs.some(n => storedHashFor(n))) return 'none';
    return subs.every(n => storedHashFor(n) === n.hash) ? 'ok' : 'update';
}

/// הפריטים המינימליים להורדה כדי לעדכן את [item]. לפריט רגיל — הוא עצמו;
/// לאב של תיקייה מתעלמת — רק תתי-התיקיות שהשתנו (לא נוגעים בשס).
function updateTargets(item) {
    if (!hasIgnoredInside(item)) return [item];
    const { added, updated } = changesInside(item);
    const changed = [...added, ...updated];
    return changed.filter(
        n => !changed.some(o => o.path !== n.path && n.path.startsWith(o.path + '/')),
    );
}

/// שומר את ה-hash של [item] ושל כל מה שתחתיו. אוסף מורד כיחידה אחת, ולכן
/// בסיום ההורדה גם תתי-הפריטים שלו מעודכנים בפועל — רישומם מאפשר להציג
/// בהמשך אילו ספרים בתוך האוסף השתנו.
async function saveHash(pathOrItem, hash) {
    const item = typeof pathOrItem === 'string'
        ? currentManifest.find(i => i.path === pathOrItem)
        : pathOrItem;
    if (!item || !hash) return;

    for (const node of subtreeOf(item)) {
        cachedHashes[statusKey(node)] = node.hash;
    }
    cachedHashes[statusKey(item)] = hash;

    if (typeof Otzaria !== 'undefined') {
        await Otzaria.call('storage.set', { key: 'downloaded_hashes', value: cachedHashes });
    } else {
        localStorage.setItem('downloaded_hashes', JSON.stringify(cachedHashes));
    }
}

/// ה-hash השמור של [item], אם ירד. תומך גם ברשומות ישנות שנשמרו לפי path.
function storedHashFor(item) {
    return cachedHashes[statusKey(item)] ?? cachedHashes[item.path];
}

/// מה השתנה בתוך [item]: פריטים חדשים ופריטים שעודכנו מאז ההורדה האחרונה.
/// מדלג על [item] עצמו — הוא הכותרת, לא פרט.
function changesInside(item) {
    const added = [], updated = [];
    for (const node of subtreeOf(item, { respectIgnore: true })) {
        if (node.path === item.path) continue;
        const stored = storedHashFor(node);
        if (!stored) added.push(node);
        else if (stored !== node.hash) updated.push(node);
    }
    return { added, updated };
}

// ─── הגדרה: התעלמות משס וגשל ──────────────────────────────────────

async function loadIgnoreShas() {
    try {
        const res = await Otzaria.call('storage.get', { key: 'ignore_shas' });
        ignoreShas = res?.data === true;
    } catch {
        try { ignoreShas = localStorage.getItem('ignore_shas') === '1'; } catch { ignoreShas = false; }
    }
    const box = document.getElementById('ignore-shas');
    if (box) box.checked = ignoreShas;
}

async function setIgnoreShas(value) {
    ignoreShas = !!value;
    try {
        if (typeof Otzaria !== 'undefined') {
            await Otzaria.call('storage.set', { key: 'ignore_shas', value: ignoreShas });
        } else {
            localStorage.setItem('ignore_shas', ignoreShas ? '1' : '0');
        }
    } catch {}
    refreshTree();
}

// ─── סיכום סטטוס + רענון עץ ──────────────────────────────────────

function renderSummary() {
    const roots = currentManifest.filter(i => i.depth === 0 && i.hash);
    let upToDate = 0, needsUpdate = 0, notDownloaded = 0;
    for (const item of roots) {
        const status = itemStatus(item);
        if (status === 'none') notDownloaded++;
        else if (status === 'update') needsUpdate++;
        else upToDate++;
    }

    const el = document.getElementById('summary');
    const txt = document.getElementById('summary-text');
    if (txt) txt.textContent = `${upToDate} מעודכנים · ${needsUpdate} דורשים עדכון · ${notDownloaded} לא הורדו`;
    if (el) el.style.display = roots.length > 0 ? 'block' : 'none';

    const updateBtn = document.getElementById('update-changes-btn');
    if (updateBtn) updateBtn.style.display = needsUpdate > 0 ? 'inline-flex' : 'none';

    const resetBtn = document.getElementById('reset-status-btn');
    if (resetBtn) resetBtn.style.display = Object.keys(cachedHashes).length > 0 ? 'inline' : 'none';
}

async function resetHashes() {
    if (!confirm('לאפס את סטטוס ההורדות? "הורד הכל" יוריד הכל מחדש.')) return;
    cachedHashes = {};
    if (typeof Otzaria !== 'undefined') {
        await Otzaria.call('storage.set', { key: 'downloaded_hashes', value: {} });
    } else {
        localStorage.removeItem('downloaded_hashes');
    }
    refreshTree();
}

function refreshTree() {
    const q = document.getElementById('search-input')?.value?.trim();
    if (filterNewOnly) renderNewUpdatedList();
    else if (q) renderSearchResults(q);
    else renderTree(currentManifest);
    renderSummary();
}

// ─── פילטר חדש/עדכון ───────────────────────────────────────────────

async function initFilterBtn() {
    if (!currentManifest.some(i => i.hash)) return;
    const bar = document.getElementById('filter-bar');
    if (bar) bar.style.display = 'block';
}

async function toggleNewFilter() {
    filterNewOnly = !filterNewOnly;
    const btn = document.getElementById('filter-btn');
    const lbl = document.getElementById('filter-label');

    if (filterNewOnly) {
        btn.style.background  = 'var(--primary)';
        btn.style.color       = 'var(--on-primary)';
        btn.style.borderColor = 'var(--primary)';
        lbl.textContent = 'מציג חדשים ועדכונים ✓';
        renderNewUpdatedList();
    } else {
        btn.style.background  = 'var(--surface-container)';
        btn.style.color       = 'var(--on-surface)';
        btn.style.borderColor = 'var(--outline)';
        lbl.textContent = 'הצג חדשים ועדכונים';
        const q = document.getElementById('search-input')?.value?.trim();
        if (q) renderSearchResults(q); else renderTree(currentManifest);
    }
}

function renderNewUpdatedList() {
    const results = currentManifest.filter(item => {
        if (!item.hash || item.depth !== 0) return false;
        return itemStatus(item) !== 'ok';
    });

    const container = document.getElementById('tree');
    container.innerHTML = '';

    if (!results.length) {
        container.innerHTML = '<div class="empty">הכל מעודכן — אין ספרים חדשים או משופרים</div>';
        return;
    }

    results.forEach(item => {
        const isNew = itemStatus(item) === 'none';

        const badge = document.createElement('span');
        badge.style.cssText = `
            font-size:0.7rem;font-weight:700;padding:2px 7px;border-radius:99px;flex-shrink:0;
            background:${isNew ? 'var(--primary)' : '#f59e0b'};
            color:${isNew ? 'var(--on-primary)' : '#fff'};
        `;
        badge.textContent = isNew ? 'חדש' : 'עודכן';

        const row = document.createElement('div');
        row.className = 'tree-row';
        row.style.paddingRight = '14px';

        const name = document.createElement('span');
        name.className = 'node-name';
        name.textContent = item.name;
        row.appendChild(name);
        row.appendChild(badge);

        if (item.parent) {
            const path = document.createElement('span');
            path.className = 'search-path';
            path.textContent = item.parent;
            row.appendChild(path);
        }

        if (item.size) {
            const size = document.createElement('span');
            size.className = 'node-size';
            size.textContent = item.size;
            row.appendChild(size);
        }

        const btn = document.createElement('button');
        btn.className = 'dl-btn';
        btn.textContent = 'הורד';
        btn.onclick = () => startDownload(item, btn);
        row.appendChild(btn);

        const wrapper = document.createElement('div');
        wrapper.className = 'tree-node';
        wrapper.appendChild(row);

        // מה השתנה *בתוך* האוסף. "עודכן" על אוסף של 68 ספרים לא אומר למשתמש
        // אם נוסף ספר אחד או עשרים, והוא מוריד בעיוורון. הנתונים לרזולוציה
        // הזו קיימים ב-books_data (יש hash לכל פריט) — כאן הם מוצגים.
        if (!isNew) {
            const detail = buildChangeDetail(item);
            if (detail) wrapper.appendChild(detail);
        }

        container.appendChild(wrapper);
    });
}

/// שורת פירוט מתקפלת: כמה פריטים נוספו/עודכנו בתוך [item], ואילו.
/// מחזירה `null` כשאין תתי-פריטים שהשתנו (למשל אוסף בלי ילדים).
function buildChangeDetail(item) {
    const { added, updated } = changesInside(item);
    if (!added.length && !updated.length) return null;

    const parts = [];
    if (added.length) parts.push(`${added.length} חדשים`);
    if (updated.length) parts.push(`${updated.length} עודכנו`);

    const box = document.createElement('div');
    box.style.cssText =
        'padding:2px 30px 8px;font-size:0.78rem;opacity:0.85;line-height:1.7;';

    const summary = document.createElement('span');
    summary.textContent = `בתוך האוסף: ${parts.join(' · ')}`;
    summary.style.cssText = 'cursor:pointer;text-decoration:underline dotted;';

    const list = document.createElement('div');
    list.style.cssText = 'display:none;padding-top:4px;';
    const addedSet = new Set(added.map(n => n.path));

    // רק תת-הפריטים המינימליים: אם תיקייה וגם תיקיית-האב שלה השתנו, הורדת
    // האב כוללת ממילא את הבן, והצגת שניהם הייתה גורמת להורדה כפולה.
    const changed  = [...added, ...updated];
    const outermost = changed.filter(
        n => !changed.some(o => o.path !== n.path && n.path.startsWith(o.path + '/')),
    );

    // "הורד רק את השינויים" — הנקודה כולה: אוסף שורש נארז כזיפ אחד ענק, אבל
    // לכל תת-תיקייה יש זיפ משלה. הורדת התת-תיקיות שהשתנו מביאה בדיוק את אותם
    // ספרים בשבריר מהנפח.
    const onlyChanged = document.createElement('button');
    onlyChanged.className = 'dl-btn';
    onlyChanged.textContent = `הורד רק את השינויים (${outermost.length})`;
    onlyChanged.style.cssText = 'margin:6px 8px 2px;';
    onlyChanged.onclick = () => startDownloadSubset(outermost, item, onlyChanged);

    for (const node of changed) {
        const line = document.createElement('div');
        line.style.cssText =
            'display:flex;align-items:center;gap:8px;padding-right:8px;padding-block:2px;';

        const nm = document.createElement('span');
        nm.textContent = `• ${node.name} (${addedSet.has(node.path) ? 'חדש' : 'עודכן'})`;
        nm.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;';
        line.appendChild(nm);

        if (node.size) {
            const sz = document.createElement('span');
            sz.className = 'node-size';
            sz.textContent = node.size;
            line.appendChild(sz);
        }

        const btn = document.createElement('button');
        btn.className = 'dl-btn';
        btn.textContent = 'הורד';
        btn.onclick = () => startDownload(node, btn);
        line.appendChild(btn);

        list.appendChild(line);
    }

    summary.addEventListener('click', () => {
        list.style.display = list.style.display === 'none' ? 'block' : 'none';
    });

    box.appendChild(summary);
    box.appendChild(onlyChanged);
    box.appendChild(list);
    return box;
}

/// מוריד קבוצת תת-פריטים שהשתנו בתוך [parent], במקום את האוסף כולו.
async function startDownloadSubset(nodes, parent, btn) {
    if (typeof Otzaria === 'undefined') {
        showError('התוסף פועל רק בתוך אוצריא.');
        return;
    }
    if (!nodes.length) return;

    const destFolder = await resolveDestFolder(`בחר תיקייה לעדכון "${parent.name}"`);
    if (!destFolder) return;

    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = '...';
    dlDone = 0;
    dlTotal = nodes.length;
    cancelRequested = false;

    let succeeded = 0;
    const failed = [];
    let cancelled = false;

    for (let i = 0; i < nodes.length; i++) {
        if (cancelRequested) { cancelled = true; break; }
        const node = nodes[i];
        showProgress(`מעדכן ${i + 1}/${nodes.length}: ${node.name}`,
                     Math.round(i / nodes.length * 100));
        const r = await downloadItemRecursive(node, destFolder);
        succeeded += r.succeeded;
        failed.push(...r.failed);
        if (r.cancelled) { cancelled = true; break; }
    }

    if (cancelled) {
        updateProgress(null, 'נעצר');
        showError(`העדכון נעצר — ${succeeded} פריטים הספיקו לרדת`);
    } else {
        updateProgress(100, 'הושלם');
        if (!failed.length) {
            await reconcileAncestors(nodes[0]);
            showSuccess(`"${parent.name}" עודכן — ${succeeded} פריטים, בלי להוריד את האוסף כולו`);
        } else {
            showError(succeeded > 0
                ? `${succeeded} פריטים עודכנו. נכשלו ${failed.length}`
                : `העדכון נכשל — ${failed.length} פריטים`);
            showFailedPanel(failed);
        }
    }

    btn.disabled = false;
    btn.textContent = label;
    setTimeout(hideProgress, 1500);
    refreshTree();
}

/// מסמנת אוסף-אב כמעודכן ברגע שכל מה שבתוכו מעודכן.
///
/// בלי זה, מי שהוריד רק את תת-התיקייה שהשתנתה היה ממשיך לראות את האוסף כולו
/// מסומן "דורש עדכון" — כי ה-hash השמור של השורש נשאר ישן — וההצעה להוריד
/// רק את השינויים הייתה מאבדת את טעמה.
async function reconcileAncestors(node) {
    let path = node.parent;
    while (path) {
        const anc = currentManifest.find(i => i.path === path);
        if (!anc) break;
        // ה-hash של אב שמכיל תיקייה מתעלמת כולל אותה — לא רושמים אותו.
        if (hasIgnoredInside(anc)) break;
        const { added, updated } = changesInside(anc);
        if (added.length || updated.length) break;
        if (anc.hash) cachedHashes[statusKey(anc)] = anc.hash;
        path = anc.parent;
    }
    await persistHashes(cachedHashes);
}

// ─── חיפוש ─────────────────────────────────────────────────────────

function initSearch() {
    const input = document.getElementById('search-input');
    const clear = document.getElementById('search-clear');
    if (!input) return;

    input.addEventListener('input', () => {
        const q = input.value.trim();
        clear.style.display = q ? 'block' : 'none';
        if (q) renderSearchResults(q);
        else renderTree(currentManifest);
    });

    clear.addEventListener('click', () => {
        input.value = '';
        clear.style.display = 'none';
        renderTree(currentManifest);
        input.focus();
    });
}

function renderSearchResults(query) {
    const q = query.trim().toLowerCase();
    const matches = currentManifest.filter(item =>
        item.name.toLowerCase().includes(q) || item.path.toLowerCase().includes(q)
    );

    const container = document.getElementById('tree');
    container.innerHTML = '';

    if (!matches.length) {
        container.innerHTML = '<div class="empty">לא נמצאו תוצאות עבור "' + query + '"</div>';
        return;
    }

    matches.forEach(item => {
        const row = document.createElement('div');
        row.className = 'tree-row';
        row.style.paddingRight = '14px';

        const name = document.createElement('span');
        name.className = 'node-name';
        name.textContent = item.name;
        row.appendChild(name);

        if (item.parent) {
            const path = document.createElement('span');
            path.className = 'search-path';
            path.textContent = item.parent;
            row.appendChild(path);
        }

        if (item.size) {
            const size = document.createElement('span');
            size.className = 'node-size';
            size.textContent = item.size;
            row.appendChild(size);
        }

        const btn = document.createElement('button');
        btn.className = 'dl-btn';
        btn.textContent = 'הורד';
        btn.onclick = () => startDownload(item, btn);
        row.appendChild(btn);

        const wrapper = document.createElement('div');
        wrapper.className = 'tree-node';
        wrapper.appendChild(row);
        container.appendChild(wrapper);
    });
}

// ─── תיקיית ההורדה ────────────────────────────────────────────────

/// התיקייה שנבחרה בריצה הנוכחית, ומשמשת לכל ההורדות שאחריה.
///
/// **מדוע רק לריצה הנוכחית:** אוצריא מתירה כתיבה, חילוץ ומחיקה בדיסק אך ורק
/// בתוך תיקייה שהמשתמש בחר דרך `ui.pickFolder`, והרשימה הזו מתאפסת בכל טעינה
/// מחדש של התוסף. נתיב ששוחזר מהאחסון אינו מאושר, וההורדה אליו הייתה נדחית.
/// לכן בכל הפעלה נדרשת בחירה אחת — ומשם ואילך אין יותר דיאלוגים.
let destFolderMemo = null;

/// התיקייה מההפעלה הקודמת. לתצוגה בלבד: היא מוצגת למשתמש כדי שידע לאן בחר
/// בפעם הקודמת, ואינה משמשת לכתיבה.
let lastFolderHint = null;

async function loadDestFolder() {
    try {
        const res = await Otzaria.call('storage.get', { key: 'download_folder' });
        const p = res?.data;
        lastFolderHint = (typeof p === 'string' && p) ? p : null;
    } catch { lastFolderHint = null; }
    renderFolderBar();
}

async function persistDestFolder(path) {
    destFolderMemo = path || null;
    lastFolderHint = path || lastFolderHint;
    try {
        await Otzaria.call('storage.set', { key: 'download_folder', value: path || '' });
    } catch { /* לתצוגה בלבד — כשל כאן אינו משפיע על ההורדה */ }
    renderFolderBar();
}

/// מחזירה את תיקיית היעד להורדה, או `null` אם המשתמש ביטל.
///
/// [force] — לפתוח את בורר התיקיות גם כשכבר נבחרה תיקייה (כפתור "שנה").
async function resolveDestFolder(title, { force = false } = {}) {
    if (destFolderMemo && !force) {
        await migrateRenamedFoldersOnDisk(destFolderMemo);
        return destFolderMemo;
    }

    // הצגת התיקייה הקודמת בכותרת הדיאלוג — אין API להעביר תיקייה התחלתית
    // לבורר, ולכן זו הדרך היחידה לכוון את המשתמש חזרה לאותו מקום.
    const full = lastFolderHint && !force
        ? `${title} (בפעם הקודמת: ${lastFolderHint})`
        : title;

    let folderRes;
    try {
        folderRes = await Otzaria.call('ui.pickFolder', { title: full });
    } catch {
        showError('בחירת תיקייה אינה נתמכת בגרסה זו של אוצריא');
        return null;
    }
    // כשל עם קוד שגיאה (למשל permission_denied) מוצג למשתמש — אחרת הכפתור
    // "לא עושה כלום" בלי שום רמז למה. ביטול משתמש (אין error) נשאר שקט.
    if (folderRes?.error) {
        showError(describeFolderError(folderRes.error));
        return null;
    }
    if (!folderRes?.success || !folderRes?.data?.path) return null;

    await persistDestFolder(folderRes.data.path);
    await migrateRenamedFoldersOnDisk(folderRes.data.path);
    return folderRes.data.path;
}

/// מציגה את התיקייה הזכורה ולצידה כפתור להחלפתה. בלי זה המשתמש לא יודע
/// לאן ההורדה הולכת, שכן שוב לא נפתח בורר תיקיות.
function renderFolderBar() {
    const bar = document.getElementById('folder-bar');
    if (!bar) return;
    if (!destFolderMemo) { bar.style.display = 'none'; return; }

    bar.style.display = 'flex';
    bar.innerHTML = '';

    const label = document.createElement('span');
    label.textContent = 'תיקיית ההורדה:';
    label.style.cssText = 'opacity:0.6;flex-shrink:0;';
    bar.appendChild(label);

    const path = document.createElement('span');
    path.textContent = destFolderMemo;
    path.title = destFolderMemo;
    path.style.cssText =
        'direction:ltr;text-align:left;overflow:hidden;text-overflow:ellipsis;' +
        'white-space:nowrap;flex:1;min-width:0;font-weight:600;';
    bar.appendChild(path);

    const change = document.createElement('button');
    change.textContent = 'שנה';
    change.style.cssText =
        'background:none;border:1px solid var(--outline);border-radius:20px;' +
        'padding:3px 12px;color:var(--primary);font-weight:600;cursor:pointer;' +
        'font-family:inherit;font-size:0.8rem;flex-shrink:0;';
    change.onclick = () => resolveDestFolder('בחר תיקייה להורדת ספרים', { force: true });
    bar.appendChild(change);
}

// ─── הורדה ─────────────────────────────────────────────────────────

function requestCancel() {
    if (cancelRequested) return;
    cancelRequested = true;
    const stopBtn = document.querySelector('.progress-stop-btn');
    if (stopBtn) stopBtn.disabled = true;
    updateProgress(null, 'עוצר לאחר סיום הפריט הנוכחי...');
}

// מסמן אנימציית "עדיין עובד" על הפס — בזמן הורדה/חילוץ של קובץ בודד אין אחוז אמיתי
// (אין API לכך ב-network.download), אז לפחות מוצג שמשהו קורה במקום פס קפוא
function setActivity(active) {
    const fill = document.querySelector('.progress-fill');
    if (fill) fill.classList.toggle('active', active);
}

async function downloadWithRetry(url, destPath, attempts = 3) {
    for (let i = 1; i <= attempts; i++) {
        if (cancelRequested) return { success: false, cancelled: true };
        try {
            const res = await Otzaria.call('network.download', { url, destPath });
            if (res?.success) return { success: true };
            const code = res?.error?.code || '';
            const msg  = res?.error?.message || 'נכשל';
            if (code === 'error.timeout' || msg.toLowerCase().includes('timed out')) {
                return { success: false, timeout: true, message: 'timeout' };
            }
            if (cancelRequested) return { success: false, cancelled: true };
            if (i < attempts) await new Promise(r => setTimeout(r, 3000 * i));
            else return { success: false, timeout: false, message: msg };
        } catch (e) {
            if (i === attempts) return { success: false, timeout: false, message: e.message };
            if (cancelRequested) return { success: false, cancelled: true };
            await new Promise(r => setTimeout(r, 3000 * i));
        }
    }
}

async function extractWithRetry(zipPath, destFolder, attempts = 3) {
    for (let i = 1; i <= attempts; i++) {
        if (cancelRequested) return { success: false, cancelled: true };
        try {
            const res = await Otzaria.call('fs.extractZip', { zipPath, destFolder });
            if (res?.success) return { success: true };
            const code = res?.error?.code || '';
            const msg  = res?.error?.message || 'נכשל';
            if (code === 'error.timeout' || msg.toLowerCase().includes('timed out')) {
                return { success: false, message: 'חילוץ ארך יותר מ-10 דקות' };
            }
            if (cancelRequested) return { success: false, cancelled: true };
            if (i < attempts) await new Promise(r => setTimeout(r, 2000 * i));
            else return { success: false, message: msg };
        } catch (e) {
            if (i === attempts) return { success: false, message: e.message };
            if (cancelRequested) return { success: false, cancelled: true };
            await new Promise(r => setTimeout(r, 2000 * i));
        }
    }
}

// מוריד פריט אחד ישירות — מחזיר { ok, timeout, cancelled, msg }
async function downloadOneItem(node, destFolder) {
    if (cancelRequested) return { ok: false, cancelled: true };

    const zipPath     = destFolder + '/' + node.zip;
    const extractPath = destFolder + '/' + node.path;
    const counter     = dlTotal > 0 ? ` [${dlDone + 1}/${dlTotal}]` : '';

    updateProgress(null, `${counter} מוריד: ${node.name}...`);
    setActivity(true);
    const dlRes = await downloadWithRetry(node.downloadUrl, zipPath);
    if (!dlRes.success) {
        setActivity(false);
        return { ok: false, timeout: !!dlRes.timeout, cancelled: !!dlRes.cancelled, msg: dlRes.message };
    }

    updateProgress(null, `${counter} מחלץ: ${node.name}...`);
    const extRes = await extractWithRetry(zipPath, extractPath);
    setActivity(false);
    await Otzaria.call('fs.deleteFile', { path: zipPath }).catch(() => {});
    if (!extRes.success) {
        return { ok: false, timeout: false, cancelled: !!extRes.cancelled, msg: extRes.cancelled ? undefined : 'חילוץ נכשל — ' + extRes.message };
    }

    dlDone++;
    await saveHash(node.path, node.hash);
    return { ok: true };
}

// מוריד פריט רקורסיבית.
// על כל כשל — אם יש ילדים, מוריד כל ילד בנפרד (לא רק על timeout).
// עלה בלי ילדים — מנסה פעם נוספת לפני ויתור.
// מחזיר { succeeded, failed: [{name, msg, url}], cancelled }
async function downloadItemRecursive(node, destFolder) {
    if (cancelRequested) return { succeeded: 0, failed: [], cancelled: true };

    // אב של תיקייה מתעלמת: ה-zip שלו כולל אותה, אז מורידים את הילדים בנפרד
    // (בלי המתעלמת) ולא רושמים hash לאב.
    if (hasIgnoredInside(node)) {
        let succeeded = 0;
        const failed  = [];
        for (const child of currentManifest.filter(c => c.parent === node.path && !isIgnored(c))) {
            const r = await downloadItemRecursive(child, destFolder);
            succeeded += r.succeeded;
            failed.push(...r.failed);
            if (r.cancelled) return { succeeded, failed, cancelled: true };
        }
        return { succeeded, failed };
    }

    const res = await downloadOneItem(node, destFolder);
    if (res.ok) return { succeeded: 1, failed: [] };
    if (res.cancelled) return { succeeded: 0, failed: [], cancelled: true };

    const children = currentManifest.filter(c => c.parent === node.path);

    if (children.length) {
        // כשל כלשהו + יש ילדים — הורד כל ילד בנפרד
        let succeeded = 0;
        const failed  = [];
        let cancelled = false;
        for (const child of children) {
            if (cancelRequested) { cancelled = true; break; }
            const r = await downloadItemRecursive(child, destFolder);
            succeeded += r.succeeded;
            failed.push(...r.failed);
            if (r.cancelled) { cancelled = true; break; }
        }
        if (failed.length === 0 && !cancelled) await saveHash(node.path, node.hash);
        return { succeeded, failed, cancelled };
    }

    // עלה בלי ילדים — נסה פעם נוספת
    updateProgress(null, `מנסה שוב: ${node.name}...`);
    const retry = await downloadOneItem(node, destFolder);
    if (retry.ok) return { succeeded: 1, failed: [] };
    if (retry.cancelled) return { succeeded: 0, failed: [], cancelled: true };
    return { succeeded: 0, failed: [{ name: node.name, msg: retry.msg || res.msg, url: node.downloadUrl }] };
}

// הורדת פריט בודד
async function startDownload(node, btn) {
    if (typeof Otzaria === 'undefined') {
        showError('התוסף פועל רק בתוך אוצריא.');
        return;
    }

    const destFolder = await resolveDestFolder(`בחר תיקייה להורדת "${node.name}"`);
    if (!destFolder) return;

    btn.disabled = true;
    btn.textContent = '...';
    dlDone = 0;
    dlTotal = 1;
    cancelRequested = false;
    showProgress(node.name, 0);

    try {
        const { succeeded, failed, cancelled } = await downloadItemRecursive(node, destFolder);
        if (cancelled) {
            updateProgress(null, 'נעצר');
            showError(succeeded > 0 ? `ההורדה נעצרה — ${succeeded} פריטים כבר הורדו` : 'ההורדה נעצרה');
        } else {
            updateProgress(100, 'הושלם');
            if (!failed.length) {
                await reconcileAncestors(node);
                showSuccess(`"${node.name}" הורד וחולץ בהצלחה`);
            } else if (succeeded > 0) {
                showError(`חלק הורד (${succeeded} פריטים). נכשלו: ${failed.map(f => f.name).join(', ')}`);
            } else {
                showError(`ההורדה נכשלה: ${failed[0]?.msg || 'שגיאה'}`);
                showFailedPanel(failed);
            }
        }
    } catch (e) {
        showError('שגיאה: ' + e.message);
    } finally {
        resetBtn(btn);
        setTimeout(hideProgress, 1200);
        refreshTree();
    }
}

function resetBtn(btn) {
    btn.disabled = false;
    btn.textContent = 'הורד';
}

// ─── כפתורי המאגר המלא / עדכון שינויים ────────────────────────────

function renderFullLibraryBtn() {
    const btn = document.getElementById('full-library-btn');
    if (!btn) return;
    btn.onclick = () => startDownloadAll(btn);
    btn.style.display = 'inline-flex';
}

async function startDownloadAll(btn) {
    if (typeof Otzaria === 'undefined') {
        showError('הורדת המאגר המלא זמינה רק באוצריא');
        return;
    }

    const rootItems = currentManifest.filter(item => item.depth === 0);
    if (!rootItems.length) return;

    // דלג על מה שכבר מעודכן
    const pending = rootItems.flatMap(n => {
        const status = itemStatus(n);
        if (status === 'ok') return [];
        return status === 'none' ? [n] : updateTargets(n);
    });

    if (!pending.length) {
        showSuccess('כל הפריטים כבר מעודכנים!');
        return;
    }

    const destFolder = await resolveDestFolder('בחר תיקייה להורדת המאגר המלא');
    if (!destFolder) return;

    btn.disabled = true;
    btn.textContent = '...';
    dlDone = 0;
    dlTotal = pending.length;
    cancelRequested = false;

    let totalSucceeded = 0;
    const allFailed = [];
    let wasCancelled = false;

    for (let i = 0; i < pending.length; i++) {
        if (cancelRequested) { wasCancelled = true; break; }
        const node = pending[i];
        showProgress(`מוריד ${i + 1}/${pending.length}: ${node.name}`, Math.round(i / pending.length * 100));

        const { succeeded, failed, cancelled } = await downloadItemRecursive(node, destFolder);
        totalSucceeded += succeeded;
        allFailed.push(...failed);
        if (cancelled) { wasCancelled = true; break; }
    }

    if (wasCancelled) {
        updateProgress(null, 'נעצר');
        showError(`ההורדה נעצרה — ${totalSucceeded} פריטים הספיקו להירד`);
    } else {
        updateProgress(100, 'הושלם');
        if (!allFailed.length) {
            showSuccess(`המאגר המלא הורד בהצלחה — ${totalSucceeded} פריטים`);
        } else {
            showError(totalSucceeded > 0
                ? `${totalSucceeded} פריטים הורדו. נכשלו ${allFailed.length} (ראה רשימה למטה)`
                : `ההורדה נכשלה — ${allFailed.length} פריטים`);
            showFailedPanel(allFailed);
        }
    }

    btn.disabled = false;
    btn.textContent = 'הורד הכל';
    setTimeout(hideProgress, 1500);
    refreshTree();
}

async function startDownloadUpdates(btn) {
    if (typeof Otzaria === 'undefined') {
        showError('עדכון שינויים זמין רק באוצריא');
        return;
    }

    // רק פריטים שהורדו כבר אבל ה-hash השתנה
    const toUpdate = currentManifest
        .filter(item => item.depth === 0 && item.hash && itemStatus(item) === 'update')
        .flatMap(updateTargets);

    if (!toUpdate.length) {
        showSuccess('אין עדכונים להורדה');
        return;
    }

    const destFolder = await resolveDestFolder('בחר תיקייה לעדכון הספרים');
    if (!destFolder) return;

    btn.disabled = true;
    btn.textContent = '...';
    dlDone = 0;
    dlTotal = toUpdate.length;
    cancelRequested = false;

    let totalSucceeded = 0;
    const allFailed = [];
    let wasCancelled = false;

    for (let i = 0; i < toUpdate.length; i++) {
        if (cancelRequested) { wasCancelled = true; break; }
        const node = toUpdate[i];
        showProgress(`מעדכן ${i + 1}/${toUpdate.length}: ${node.name}`, Math.round(i / toUpdate.length * 100));

        const { succeeded, failed, cancelled } = await downloadItemRecursive(node, destFolder);
        totalSucceeded += succeeded;
        allFailed.push(...failed);
        if (cancelled) { wasCancelled = true; break; }
    }

    if (wasCancelled) {
        updateProgress(null, 'נעצר');
        showError(`העדכון נעצר — ${totalSucceeded} פריטים הספיקו להתעדכן`);
    } else {
        updateProgress(100, 'הושלם');
        if (!allFailed.length) {
            showSuccess(`${toUpdate.length} קטגוריות עודכנו בהצלחה`);
        } else {
            showError(totalSucceeded > 0
                ? `${totalSucceeded} פריטים עודכנו. נכשלו ${allFailed.length}`
                : `העדכון נכשל — ${allFailed.length} פריטים`);
            showFailedPanel(allFailed);
        }
    }

    btn.disabled = false;
    btn.textContent = 'עדכן שינויים';
    setTimeout(hideProgress, 1500);
    refreshTree();
}

// ─── UI: progress ──────────────────────────────────────────────────

function showProgress(name, pct) {
    const el = document.getElementById('progress-bar');
    if (!el) return;
    el.style.display = 'block';
    el.querySelector('.progress-name').textContent  = name;
    el.querySelector('.progress-fill').style.width  = pct + '%';
    el.querySelector('.progress-fill').classList.remove('active');
    el.querySelector('.progress-label').textContent = pct + '%';
    const stopBtn = el.querySelector('.progress-stop-btn');
    if (stopBtn) { stopBtn.style.display = 'inline-flex'; stopBtn.disabled = false; }
}

function updateProgress(pct, label) {
    const el = document.getElementById('progress-bar');
    if (!el) return;
    if (pct !== null) el.querySelector('.progress-fill').style.width = pct + '%';
    el.querySelector('.progress-label').textContent = label || (pct + '%');
}

function hideProgress() {
    const el = document.getElementById('progress-bar');
    if (!el) return;
    el.style.display = 'none';
    el.querySelector('.progress-fill').classList.remove('active');
    const stopBtn = el.querySelector('.progress-stop-btn');
    if (stopBtn) { stopBtn.style.display = 'none'; stopBtn.disabled = false; }
}

function showSuccess(msg) {
    const el = document.getElementById('success-msg');
    if (!el) return;
    el.textContent = '✓ ' + msg;
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 7000);
}

function showFailedPanel(failed) {
    const el = document.getElementById('failed-panel');
    if (!el) return;
    el.innerHTML = '';
    failed.forEach(f => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:flex-start;gap:8px;padding:8px 0;border-bottom:1px solid rgba(0,0,0,.07);';

        const info = document.createElement('div');
        info.style.flex = '1';

        const name = document.createElement('div');
        name.style.cssText = 'font-size:0.85rem;font-weight:600;';
        name.textContent = f.name;
        info.appendChild(name);

        if (f.msg) {
            const err = document.createElement('div');
            err.style.cssText = 'font-size:0.72rem;opacity:0.5;margin-top:2px;direction:ltr;text-align:right;';
            err.textContent = f.msg;
            info.appendChild(err);
        }

        row.appendChild(info);

        if (f.url) {
            const btn = document.createElement('button');
            btn.textContent = 'הורד ידנית';
            btn.style.cssText = 'background:none;border:1px solid var(--outline);border-radius:12px;padding:3px 10px;color:var(--primary);font-weight:600;white-space:nowrap;font-size:0.82rem;flex-shrink:0;margin-top:2px;cursor:pointer;font-family:inherit;';
            btn.onclick = () => showFallback(f.url, f.name);
            row.appendChild(btn);
        }

        el.appendChild(row);
    });
    el.parentElement.style.display = 'block';
}

function showFallback(url, name) {
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).catch(() => {});
    const el = document.getElementById('copy-toast');
    if (!el) return;
    el.querySelector('.copy-name').textContent = name;
    el.querySelector('.copy-url').textContent  = url;
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 10000);
}

// ─── UI: loading / error ───────────────────────────────────────────

function hideLoading() {
    const el = document.getElementById('loading');
    if (el) el.style.display = 'none';
}

/// מציגה שגיאה, ולצידה כפתור "נסה שוב" כשהתקלה ניתנת לריענון.
///
/// עד כה תקלת רשת חייבה סגירה והפעלה מחדש של אוצריא כדי לנסות שוב, כי
/// [boot] נחסם ע"י הדגל `booted` שלא התאפס אף פעם.
function showError(msg, { retry = false } = {}) {
    const el = document.getElementById('error-msg');
    if (!el) return;
    el.textContent = '';
    el.style.display = 'block';

    const text = document.createElement('span');
    text.textContent = 'שגיאה: ' + msg;
    el.appendChild(text);

    if (!retry) return;

    const btn = document.createElement('button');
    btn.textContent = 'נסה שוב';
    btn.style.cssText =
        'margin-inline-start:10px;padding:3px 12px;border-radius:99px;cursor:pointer;' +
        'font:inherit;font-size:0.8rem;border:1px solid currentColor;' +
        'background:transparent;color:inherit;';
    btn.onclick = () => reloadBooksList(btn);
    el.appendChild(btn);
}

/// טוענת מחדש את רשימת הספרים בלי לסגור את אוצריא.
///
/// מאפסת את מצב האתחול ומריצה את [boot] שוב. הסטטוס השמור (`cachedHashes`)
/// נטען מחדש מהאחסון, ולכן אין אובדן מידע.
async function reloadBooksList(btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'טוען...'; }
    const err = document.getElementById('error-msg');
    if (err) err.style.display = 'none';
    const loading = document.getElementById('loading');
    if (loading) loading.style.display = 'block';

    const tree = document.getElementById('tree');
    if (tree && loading && !tree.contains(loading)) tree.innerHTML = '';

    booted = false;
    expandedPaths = new Set();
    filterNewOnly = false;
    await boot({});
}

// ─── ערכת נושא ─────────────────────────────────────────────────────

function applyTheme(theme) {
    if (!theme?.colorScheme) return;
    const cs = theme.colorScheme, r = document.documentElement.style;
    if (cs.primary)    r.setProperty('--primary',           cs.primary);
    if (cs.onPrimary)  r.setProperty('--on-primary',        cs.onPrimary);
    if (cs.surface)    r.setProperty('--surface',           cs.surface);
    if (cs.onSurface)  r.setProperty('--on-surface',        cs.onSurface);
    if (cs.surfaceContainerHighest || cs.surfaceContainer)
                       r.setProperty('--surface-container', cs.surfaceContainerHighest || cs.surfaceContainer);
    if (cs.outline)    r.setProperty('--outline',           cs.outline);
    // רקע פס הכותרת — surfaceContainerHigh, כמו הסרגל העליון של מסכי הספרים
    if (cs.surfaceContainerHigh)
                       r.setProperty('--topbar',            cs.surfaceContainerHigh);
    if (cs.onSurfaceVariant)
                       r.setProperty('--on-surface-variant', cs.onSurfaceVariant);
    if (theme.typography) {
        const t = theme.typography;
        if (t.fontFamily) r.setProperty('--font-family', t.fontFamily + ', system-ui, sans-serif');
        if (t.fontSize)   r.setProperty('--font-size',   t.fontSize + 'px');
        if (t.lineHeight) r.setProperty('--line-height', t.lineHeight);
    }
}
