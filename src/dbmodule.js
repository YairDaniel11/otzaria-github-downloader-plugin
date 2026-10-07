// לוגיקה טהורה של חלון "הורדת המסד": קריאת המניפסט של המסד, בניית כתובת ההורדה, עיצוב גודל ונתיב יעד.
// בלי תלות ב-DOM וב-Otzaria, כדי שאפשר לבדוק אותה ב-node (tests/dbmodule.test.js).
(function (root) {
    'use strict';

    const REPO = 'YairDaniel11/Otzarya-Unofficial-Books';
    const DB_DISPLAY_NAME = 'מאגר ספרים לא רשמי';
    /// השם המקומי של הקובץ: קבוע וללא מספר גרסה, כדי שאוצריא תחליף אותו במקומו בעדכון.
    const DB_LOCAL_NAME = 'otzarya-unofficial-books.db';
    /// קבוע בשם הנכס ב-release: otzarya-unofficial-books-<N>.db
    const DB_ASSET_PREFIX = 'otzarya-unofficial-books-';
    /// גילוי הגרסה דרך GitHub API (כתובת שכבר מותרת בתוסף). את manifest.json לא קוראים: הכתובת שלו מפנה (302)
    /// לאחסון release-assets.githubusercontent.com שאינו ב-allowlist.
    const DB_RELEASES_URL = `https://api.github.com/repos/${REPO}/releases?per_page=100`;
    const REPO_PREFIX = `https://github.com/${REPO}/`;

    /// מספר גרסה תקין: מספר שלם חיובי (מספר או מחרוזת ספרות). אחרת null.
    function normalizeVersion(v) {
        if (typeof v === 'number') return Number.isSafeInteger(v) && v > 0 ? v : null;
        if (typeof v === 'string' && /^\d{1,9}$/.test(v.trim())) {
            const n = Number(v.trim());
            return n > 0 ? n : null;
        }
        return null;
    }

    /// גודל בבתים לטקסט קריא (MB/GB, עם נקודה עשרונית). לא תקין -> ''.
    function formatBytes(n) {
        if (typeof n === 'string' && /^\d+(\.\d+)?$/.test(n.trim())) n = Number(n);
        if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '';
        const units = ['בייט', 'KB', 'MB', 'GB', 'TB'];
        let i = 0, v = n;
        while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
        const text = i === 0 ? String(Math.round(v)) : (v >= 100 ? v.toFixed(0) : v.toFixed(1)).replace(/\.0$/, '');
        return `${text} ${units[i]}`;
    }

    /// בוחרת מתוך תשובת releases של GitHub את ה-release הגבוה ביותר בתבנית db-v<N> (לא draft ולא prerelease;
    /// השוואה מספרית, כך ש-db-v10 > db-v9). מחזירה:
    ///   null                                    אין release מתאים, או שהתשובה פגומה
    ///   { state:'no-asset', version, pageUrl }  יש release אך עדיין בלי הנכס otzarya-unofficial-books-<N>.db
    ///   { state:'ready', version, size, sizeText, url, pageUrl }  הנכס קיים; url = browser_download_url
    /// גודל חסר או לא תקין אינו כשל: sizeText ריק.
    function pickLatestDbRelease(input) {
        let list;
        try { list = typeof input === 'string' ? JSON.parse(input) : input; } catch { return null; }
        if (!Array.isArray(list)) return null;
        let best = null, bestV = 0;
        for (const r of list) {
            if (!r || typeof r !== 'object' || r.draft || r.prerelease) continue;
            const m = typeof r.tag_name === 'string' ? /^db-v(\d{1,9})$/.exec(r.tag_name) : null;
            const v = m ? normalizeVersion(m[1]) : null;
            if (v && v > bestV) { best = r; bestV = v; }
        }
        if (!best) return null;
        const name = assetName(bestV);
        const assets = Array.isArray(best.assets) ? best.assets : [];
        const asset = assets.find(a => a && a.name === name);
        const pageUrl = `${REPO_PREFIX}releases/tag/db-v${bestV}`;   // תמיד נבנית מהגרסה, לא נלקחת מהתשובה
        if (!asset) return { state: 'no-asset', version: bestV, pageUrl };
        const url = safeAssetUrl(asset.browser_download_url, bestV) || buildDbDownloadUrl(bestV);
        const sizeText = formatBytes(asset.size);
        return { state: 'ready', version: bestV, size: sizeText ? Number(asset.size) : null, sizeText, url, pageUrl };
    }

    /// כתובת הנכס מהתשובה, רק אם היא בדיוק
    /// https://github.com/YairDaniel11/Otzarya-Unofficial-Books/releases/download/db-v<N>/otzarya-unofficial-books-<N>.db
    /// (אותה גרסה בתג ובשם הקובץ, בלי "..", בלי נתיב אחר ובלי שאילתה). אחרת ''.
    function safeAssetUrl(u, version) {
        const v = normalizeVersion(version);
        return v && typeof u === 'string' && u === buildDbDownloadUrl(v) ? u : '';
    }

    /// הודעה בעברית לסטטוס שגיאה של api.github.com. 403/429 = הגבלת קצב זמנית. אחרת ''.
    function describeApiStatus(status) {
        if (status === 403 || status === 429) return 'GitHub הגביל זמנית את הבקשות; נסה שוב בעוד כמה דקות';
        return '';
    }

    /// טקסט הצ'יפים של הגרסה והגודל. גודל מוצג רק כשיש נכס; גרסה בלי נכס: "הקובץ הרגיל עדיין לא פורסם";
    /// כשל API: "לא ניתן לטעון את פרטי הגרסה". טקסט ריק = הצ'יפ מוסתר.
    function describeChips(info, failed) {
        if (info && info.state === 'ready') {
            return { version: `גרסה אחרונה: ${info.version}`, size: info.sizeText ? `גודל: ${info.sizeText}` : '' };
        }
        if (info && info.state === 'no-asset') {
            return { version: `גרסה אחרונה: ${info.version}`, size: 'הקובץ הרגיל עדיין לא פורסם' };
        }
        if (failed) return { version: '', size: 'לא ניתן לטעון את פרטי הגרסה' };
        return { version: '', size: '' };
    }

    /// האם שני נתיבי תיקייה זהים (מפרידים, סלש סופי ואותיות גדולות/קטנות בכונן של Windows אינם משנים).
    function sameFolder(a, b) {
        if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
        const norm = p => {
            const n = p.replace(/\\/g, '/').replace(/\/+$/, '');
            return /^[A-Za-z]:/.test(n) ? n.toLowerCase() : n;
        };
        return norm(a) === norm(b);
    }

    /// מנעול כניסה יחידה: מונע הרצה כפולה של פעולה אסינכרונית (לחיצה כפולה). tryEnter() מחזיר false אם תפוס.
    function createGuard() {
        let busy = false;
        return {
            tryEnter() { if (busy) return false; busy = true; return true; },
            leave() { busy = false; },
            get busy() { return busy; },
        };
    }

    function assetName(version) {
        const v = normalizeVersion(version);
        return v ? `${DB_ASSET_PREFIX}${v}.db` : null;
    }

    /// כתובת ההורדה: releases/download/db-v<N>/otzarya-unofficial-books-<N>.db. גרסה לא תקינה -> null.
    function buildDbDownloadUrl(version) {
        const v = normalizeVersion(version);
        return v ? `https://github.com/${REPO}/releases/download/db-v${v}/${assetName(v)}` : null;
    }

    /// נתיב היעד המלא בתוך התיקייה שנבחרה, בלי להכפיל מפרידים ובלי לשנות את סוג המפריד של התיקייה.
    function buildDbDestPath(folder) {
        if (typeof folder !== 'string' || !folder.trim()) return null;
        const f = folder.replace(/[\\/]+$/, '');
        const sep = f.includes('\\') && !f.includes('/') ? '\\' : '/';
        return f + sep + DB_LOCAL_NAME;
    }

    /// האם להציג את חלון ההמלצה בלחיצה על "הורד הכל". ההעדפה השמורה true = "אל תציג שוב".
    function shouldShowRecommend(stored) {
        return stored !== true;
    }

    /// שניות שחלפו -> "m:ss" (להצגת מצב הורדה).
    function formatElapsed(seconds) {
        const s = Math.max(0, Math.floor(Number(seconds) || 0));
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }

    const api = {
        REPO, DB_DISPLAY_NAME, DB_LOCAL_NAME, DB_RELEASES_URL, REPO_PREFIX,
        normalizeVersion, formatBytes, pickLatestDbRelease, safeAssetUrl, describeApiStatus, createGuard, sameFolder, describeChips, assetName,
        buildDbDownloadUrl, buildDbDestPath, shouldShowRecommend, formatElapsed,
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.DbModule = api;
})(typeof window !== 'undefined' ? window : globalThis);
