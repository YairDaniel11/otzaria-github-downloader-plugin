// חלון "הורדת המסד", דף העזרה, מעבר בין התצוגות וחלון ההמלצה ב"הורד הכל".
// נטען אחרי app.js ומשתמש בפונקציות הגלובליות שלו (fetchText, describeFetchError, describeFolderError, errorText)
// ובלוגיקה הטהורה של dbmodule.js (DbModule). שום דבר כאן לא רץ בטעינה מלבד חיווט; אין חלון קופץ בעת הטעינה.
(function () {
    'use strict';

    const D = DbModule;
    const $ = id => document.getElementById(id);
    const KEY_FOLDER = 'db_download_folder';     // התיקייה האחרונה של המסד (לתצוגה בלבד, כמו download_folder)
    const KEY_HIDE_RECOMMEND = 'hide_db_recommend';
    const KEY_LAST_DOWNLOAD = 'db_last_download_folder';   // התיקייה שאליה ירד המסד בהצלחה (לאזהרה בהורדה חוזרת)
    let lastDownloadFolder = null;
    const ATTEMPTS = 3;

    let dbInfo = null;            // תוצאת D.pickLatestDbRelease (state: ready | no-asset) או null אם לא נטען
    let dbInfoError = '';         // הסיבה לכישלון הטעינה האחרון, להצגה רכה
    let dbFolderMemo = null;      // תיקייה שנבחרה בריצה הנוכחית (רק אליה מותר לכתוב)
    let dbFolderHint = null;      // התיקייה מההפעלה הקודמת, לתצוגה בלבד
    let downloading = false;
    let timer = null;

    // ─── תצוגות ──────────────────────────────────────────────────────

    function showView(name) {
        for (const key of ['db', 'help', 'txt']) {
            const el = $('view-' + key);
            if (el) el.hidden = key !== name;
        }
        const content = document.querySelector('#view-' + name + ' .app-content');
        if (content) content.scrollTop = 0;
    }
    window.showView = showView;

    // ─── אחסון ───────────────────────────────────────────────────────

    async function storageGet(key) {
        try {
            if (typeof Otzaria !== 'undefined') return (await Otzaria.call('storage.get', { key }))?.data;
            return JSON.parse(localStorage.getItem(key));
        } catch { return undefined; }
    }

    async function storageSet(key, value) {
        try {
            if (typeof Otzaria !== 'undefined') await Otzaria.call('storage.set', { key, value });
            else localStorage.setItem(key, JSON.stringify(value));
        } catch { /* העדפה/רמז בלבד: כשל אינו משפיע על ההורדה */ }
    }

    // ─── פרטי המסד (GitHub API: releases) ────────────────────────────

    function linkButton(text, onclick) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'link-btn';
        b.textContent = text;
        b.onclick = onclick;
        return b;
    }

    /// פותחת את דף ה-release בדפדפן (app.openUrl). אם אינה זמינה, מציגה את הכתובת להעתקה.
    async function openReleasePage(url) {
        try {
            const r = await Otzaria.call('app.openUrl', { url });
            if (r === false || r?.success === false) throw new Error('נכשל');
        } catch {
            showError('לא ניתן לפתוח את הדפדפן מהתוסף. פתחו ידנית את הכתובת: ' + url);
        }
    }

    function renderInfo() {
        const ready = dbInfo && dbInfo.state === 'ready';
        const chips = D.describeChips(dbInfo, !dbInfo);   // renderInfo נקראת רק אחרי סיום הטעינה
        const vc = $('db-version-chip'), sc = $('db-size-chip');
        vc.textContent = chips.version; vc.hidden = !chips.version;
        sc.textContent = chips.size;    sc.hidden = !chips.size;
        $('db-download-btn').disabled = downloading || startGuard.busy || !!(dbInfo && !ready);
        const note = $('db-info-note');
        note.textContent = '';
        if (ready) {
            note.textContent = 'הפרטים נקראו מגרסאות המאגר ב-GitHub.';
            return;
        }
        if (dbInfo) {   // no-asset
            note.appendChild(document.createTextNode(
                `המסד עדיין לא זמין להורדה דרך התוסף. גרסה ${dbInfo.version} פורסמה, אך קובץ המסד הרגיל ` +
                'עדיין לא צורף אליה. אפשר לנסות שוב מאוחר יותר, או להוריד ידנית מדף הגרסה. '));
            note.appendChild(linkButton('פתח את דף הגרסה', () => openReleasePage(dbInfo.pageUrl)));
            note.appendChild(document.createTextNode(' · '));
            note.appendChild(linkButton('בדוק שוב', () => loadDbInfo()));
            return;
        }
        note.appendChild(document.createTextNode(
            'פרטי הגרסה אינם זמינים כרגע' + (dbInfoError ? ' (' + dbInfoError + ')' : '') + '. '));
        note.appendChild(linkButton('נסה שוב', () => loadDbInfo()));
    }

    /// קוראת את רשימת ה-releases ובוחרת את הגבוה ביותר בתבנית db-v<N>. כשל אינו שגיאה: "לא זמין".
    async function loadDbInfo() {
        dbInfo = null;
        dbInfoError = '';
        $('db-info-note').textContent = 'טוען פרטי גרסה...';
        $('db-version-chip').hidden = true;
        $('db-size-chip').hidden = false;
        $('db-size-chip').textContent = 'טוען...';
        try {
            if (typeof Otzaria === 'undefined') throw new Error('התוסף פועל רק בתוך אוצריא');
            const res = await fetchText(D.DB_RELEASES_URL, { headers: { Accept: 'application/vnd.github+json' } });
            if (!res.ok) throw new Error(D.describeApiStatus(res.status) || `גיטאב החזיר שגיאה ${res.status}`);
            dbInfo = D.pickLatestDbRelease(res.body);
            if (!dbInfo) throw new Error('לא נמצאה גרסת מסד בגיטאב');
        } catch (e) {
            dbInfo = null;
            dbInfoError = String(errorText(e) || '').replace(/^Exception:\s*/, '').slice(0, 120);
        }
        renderInfo();
        return dbInfo;
    }

    // ─── תיקיית המסדים ───────────────────────────────────────────────

    function renderFolder() {
        const path = $('db-folder-path');
        const lbl = path.parentElement.querySelector('.lbl');
        if (dbFolderMemo) {
            path.textContent = dbFolderMemo; path.title = dbFolderMemo; lbl.textContent = 'תיקיית המסדים:';
        } else if (dbFolderHint) {
            path.textContent = dbFolderHint; path.title = dbFolderHint; lbl.textContent = 'בפעם הקודמת:';
        } else {
            path.textContent = 'לא נבחרה'; path.title = ''; lbl.textContent = 'תיקיית המסדים:';
        }
        const hasPath = !!(dbFolderMemo || dbFolderHint);
        path.dir = hasPath ? 'ltr' : 'rtl';
        path.style.textAlign = hasPath ? 'left' : 'right';
        path.style.unicodeBidi = 'isolate';
        $('db-pick-btn').textContent = dbFolderMemo ? 'שנה' : 'בחר תיקייה';
    }

    /// מחזירה את תיקיית המסדים לריצה הזו, או null אם בוטל/נכשל. כמו בתצוגת TXT: ההרשאה לכתוב
    /// בתיקייה תקפה רק לריצה הנוכחית, ולכן נדרשת בחירה אחת בכל הפעלה.
    async function ensureFolder({ force = false } = {}) {
        if (dbFolderMemo && !force) return dbFolderMemo;
        const title = 'בחר תיקייה ייעודית למסדים' +
            (dbFolderHint && !force ? ` (בפעם הקודמת: ${dbFolderHint})` : '');
        let res;
        try {
            res = await Otzaria.call('ui.pickFolder', { title });
        } catch {
            showError('בחירת תיקייה אינה נתמכת בגרסה זו של אוצריא');
            return null;
        }
        if (res?.error) { showError(describeFolderError(res.error)); return null; }
        if (!res?.success || !res?.data?.path) return null;   // ביטול משתמש: שקט
        dbFolderMemo = res.data.path;
        dbFolderHint = res.data.path;
        await storageSet(KEY_FOLDER, res.data.path);
        renderFolder();
        return dbFolderMemo;
    }

    // ─── הודעות ומצב הורדה ───────────────────────────────────────────

    function clearNotices() {
        $('db-done').style.display = 'none';
        $('db-error').style.display = 'none';
    }

    function showError(msg) {
        const el = $('db-error');
        el.textContent = 'שגיאה: ' + msg;
        el.style.display = 'block';
    }

    function showDone(folder, version) {
        const el = $('db-done');
        el.textContent = '';
        const add = (text, bold) => {
            const n = document.createElement(bold ? 'b' : 'span');
            n.textContent = text;
            el.appendChild(n);
        };
        add(`✓ המסד (גרסה ${version}) הורד אל התיקייה:`, true);
        el.appendChild(document.createElement('br'));
        const p = document.createElement('span');
        p.textContent = folder;
        p.dir = 'ltr';
        p.style.cssText = 'display:inline-block;font-weight:600;unicode-bidi:isolate;direction:ltr;max-width:100%;overflow-wrap:anywhere;';
        el.appendChild(p);
        el.appendChild(document.createElement('br'));
        add('הצעד הבא: ', true);
        // שמות קבצים ונתיבים נעטפים ב-bdi כדי שלא יישברו ולא יתהפכו בטקסט עברי
        const ltr = (text) => {
            const n = document.createElement('bdi');
            n.dir = 'ltr';
            n.className = 'ltr';
            n.textContent = text;
            el.appendChild(n);
        };
        add('באוצריא היכנסו אל הגדרות ← ספרייה ← מסדי ספרים אישיים ← "ייבא קובץ מסד", ובחרו את הקובץ ');
        ltr(D.DB_LOCAL_NAME);
        add(' מהתיקייה הזו. המסד יצורף ויוצג כ"חתום · ');
        ltr('github.com');
        add('". ');
        el.appendChild(document.createElement('br'));
        add('חלופה: "הוסף תיקיית מסדים" ובחירת התיקייה. אוצריא מצרפת כל קובץ ');
        ltr('.db');
        add(' שבה.');
        el.style.display = 'block';
    }

    function setBusy(busy, text) {
        downloading = busy;
        $('db-download-btn').disabled = busy;
        $('db-pick-btn').disabled = busy;
        $('db-progress').style.display = busy ? 'block' : 'none';
        clearInterval(timer);
        if (busy) {
            $('db-progress-text').textContent = text || 'מוריד...';
            const t0 = Date.now();
            $('db-progress-time').textContent = D.formatElapsed(0);
            timer = setInterval(() => {
                $('db-progress-time').textContent = D.formatElapsed((Date.now() - t0) / 1000);
            }, 1000);
        }
    }

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    /// הורדה עם המשך (resume) וניסיונות חוזרים. מחזירה { ok } או { ok:false, message }.
    async function downloadDb(url, destPath, version) {
        let message = 'נכשל';
        for (let i = 1; i <= ATTEMPTS; i++) {
            $('db-progress-text').textContent = i === 1
                ? `מוריד את המסד (גרסה ${version})...`
                : `מוריד את המסד (גרסה ${version}), ניסיון ${i} מתוך ${ATTEMPTS}, לרוב ממשיך מהנקודה שנעצרה...`;
            let raw;
            try {
                const res = await Otzaria.call('network.download', { url, destPath, resume: true });
                if (res?.success) return { ok: true };
                raw = res?.error ?? 'נכשל';
            } catch (e) {
                raw = e;
            }
            const text = errorText(raw);
            message = describeFetchError(raw);
            if (/\b404\b|not[ _]found/i.test(text)) {
                message = `קובץ המסד של גרסה ${version} לא נמצא ב-GitHub. ייתכן שהוא טרם פורסם. נסו שוב מאוחר יותר. (${text.slice(0, 120)})`;
                break;   // ניסיון חוזר לא יעזור
            }
            if (text.includes('error.forbidden') || text.includes('error.permission_denied')) break;
            if (i < ATTEMPTS) await sleep(3000 * i);
        }
        return { ok: false, message };
    }

    const startGuard = D.createGuard();

    /// נועלת מיד בכניסה (לפני כל await), כך שלחיצה כפולה לא מפעילה שני תהליכים, גם בזמן בחירת תיקייה.
    async function startDbDownload() {
        if (!startGuard.tryEnter()) return;
        const dl = $('db-download-btn'), pick = $('db-pick-btn');
        dl.disabled = true;
        pick.disabled = true;
        try {
            await runDbDownload();
        } finally {
            startGuard.leave();
            pick.disabled = false;
            dl.disabled = !!(dbInfo && dbInfo.state !== 'ready');
        }
    }

    async function runDbDownload() {
        clearNotices();
        if (typeof Otzaria === 'undefined') {
            showError('הורדת המסד זמינה רק בתוך אוצריא.');
            return;
        }
        if (!dbInfo) await loadDbInfo();
        if (!dbInfo) {
            showError('לא ניתן לקבוע את גרסת המסד האחרונה, ולכן אי אפשר להוריד כרגע' +
                (dbInfoError ? ' (' + dbInfoError + ')' : '') + '. בדקו חיבור לאינטרנט ונסו שוב.');
            return;
        }
        if (dbInfo.state !== 'ready') {
            showError('המסד עדיין לא זמין להורדה דרך התוסף. אפשר להוריד ידנית מדף הגרסה או לנסות שוב מאוחר יותר.');
            return;
        }
        const info = dbInfo;
        const folder = await ensureFolder();
        if (!folder) return;

        const url = info.url;
        const dest = D.buildDbDestPath(folder);
        if (!url || !dest) { showError('לא ניתן לבנות את כתובת ההורדה.'); return; }

        // הורדה חוזרת אל אותה תיקייה דורסת את הקובץ, ועלולה לדרוס מסד שכבר מצורף ופתוח באוצריא.
        if (D.sameFolder(folder, lastDownloadFolder) &&
            !confirm('הורדת את המסד לתיקייה הזו כבר. אם הוא מצורף באוצריא, אין צורך להוריד שוב: העדכונים מגיעים דרך אוצריא.\n' +
                     'הורדה חוזרת כותבת ישירות על הקובץ, ועלולה להיכשל או להשאיר קובץ חלקי אם הוא בשימוש.\n' +
                     'מומלץ להוריד לתיקייה אחרת. להמשיך בכל זאת?')) return;

        setBusy(true, `מוריד את המסד (גרסה ${info.version})...`);
        let result;
        try {
            result = await downloadDb(url, dest, info.version);
        } catch (e) {
            result = { ok: false, message: errorText(e) || 'שגיאה לא צפויה' };
        }
        setBusy(false);
        if (result.ok) {
            lastDownloadFolder = folder;
            storageSet(KEY_LAST_DOWNLOAD, folder);
            showDone(folder, info.version);
        } else {
            showError('ההורדה נכשלה: ' + result.message + ' אפשר ללחוץ שוב על "הורד את המסד"; לרוב ההורדה תמשיך מהנקודה שנעצרה.');
        }
    }

    // ─── חלון ההמלצה ב"הורד הכל" ─────────────────────────────────────

    const recommendGuard = D.createGuard();

    /// נקראת מכפתור "הורד הכל" (app.js). [proceed] ממשיכה לפעולה הקיימת.
    /// המנעול נתפס מיד בכניסה (לפני כל await), ו-closing מונע סגירה כפולה בזמן ה-await של השמירה.
    async function confirmFullDownload(proceed) {
        if (!recommendGuard.tryEnter()) return;
        let stored;
        try { stored = await storageGet(KEY_HIDE_RECOMMEND); } catch { stored = undefined; }
        if (!D.shouldShowRecommend(stored === true)) { recommendGuard.leave(); proceed(); return; }

        let closing = false;
        const modal = $('recommend-modal');
        const box = $('recommend-dont-show');
        const prevFocus = document.activeElement;
        box.checked = false;
        modal.hidden = false;
        $('recommend-db-btn').focus();

        const close = async (action) => {
            if (closing) return;
            closing = true;                 // לפני כל await: לחיצה כפולה לא תריץ proceed/showView פעמיים
            const remember = action !== 'cancel' && box.checked;
            modal.hidden = true;
            cleanup();
            if (remember) await storageSet(KEY_HIDE_RECOMMEND, true);
            recommendGuard.leave();
            if (prevFocus && prevFocus.focus) { try { prevFocus.focus(); } catch { /* לא קריטי */ } }
            if (action === 'db') showView('db');
            else if (action === 'txt') proceed();
        };
        const onDb = () => close('db');
        const onTxt = () => close('txt');
        const onCancel = () => close('cancel');
        const onKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); onCancel(); return; }
            if (e.key !== 'Tab') return;
            const items = [...modal.querySelectorAll('button, input')].filter(x => !x.disabled);
            const first = items[0], last = items[items.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        };
        const onScrim = (e) => { if (e.target === modal) onCancel(); };
        function cleanup() {
            $('recommend-db-btn').removeEventListener('click', onDb);
            $('recommend-txt-btn').removeEventListener('click', onTxt);
            $('recommend-cancel-btn').removeEventListener('click', onCancel);
            document.removeEventListener('keydown', onKey, true);
            modal.removeEventListener('mousedown', onScrim);
        }
        $('recommend-db-btn').addEventListener('click', onDb);
        $('recommend-txt-btn').addEventListener('click', onTxt);
        $('recommend-cancel-btn').addEventListener('click', onCancel);
        document.addEventListener('keydown', onKey, true);
        modal.addEventListener('mousedown', onScrim);
    }
    window.confirmFullDownload = confirmFullDownload;

    // ─── תמונות עזרה: שלב שלא נמצא מציג מסגרת מקום, בלי כשל ───────────

    function wireHelpImages() {
        document.querySelectorAll('.shot img').forEach(img => {
            const fig = img.closest('.shot');
            const missing = () => fig.classList.add('missing');
            img.addEventListener('error', missing);
            img.addEventListener('load', () => fig.classList.remove('missing'));
            if (img.complete && img.naturalWidth === 0) missing();
        });
    }

    // ─── חיווט ───────────────────────────────────────────────────────

    let inited = false;
    async function init() {
        if (inited) return;
        inited = true;
        const hint = await storageGet(KEY_FOLDER);
        dbFolderHint = (typeof hint === 'string' && hint) ? hint : null;
        const last = await storageGet(KEY_LAST_DOWNLOAD);
        lastDownloadFolder = (typeof last === 'string' && last) ? last : null;
        renderFolder();
        loadDbInfo();
    }

    function wire() {
        $('open-help-btn').onclick = () => showView('help');
        $('help-back-btn').onclick = () => showView('db');
        $('open-txt-btn').onclick = () => showView('txt');
        $('txt-back-btn').onclick = () => showView('db');
        $('db-download-btn').onclick = startDbDownload;
        $('db-pick-btn').onclick = async () => {
            if (typeof Otzaria === 'undefined') { showError('בחירת תיקייה זמינה רק בתוך אוצריא.'); return; }
            clearNotices();
            await ensureFolder({ force: true });
        };
        wireHelpImages();
        renderFolder();

        if (window.Otzaria) Otzaria.on('plugin.boot', init);
        setTimeout(() => {
            if (typeof Otzaria !== 'undefined') init();
            else { dbInfoError = 'התוסף פועל רק בתוך אוצריא'; renderInfo(); }
        }, 500);
    }

    wire();
})();
