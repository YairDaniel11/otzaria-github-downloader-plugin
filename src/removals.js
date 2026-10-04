// מחיקת קבצים ישנים אחרי עדכון.
//
// התוסף מחלץ zip מעל התיקייה של המשתמש ולא מוחק קבצים שהוסרו או שינו שם במאגר, ולכן אחרי עדכון נשארים
// הקבצים הישנים לצד החדשים (באוצריא: אותו ספר פעמיים). המאגר מפרסם את removed_files.json
// (נבנה ב-workflow מההיסטוריה של git): רשומות {t, path, to?}, כשהנתיב יחסי לתיקיית הספרים.
//
//   path  נתיב ישן שאינו קיים עוד
//   to    היעד החדש, רק כשהקובץ הועבר או שונה שמו וקיים היום
//   t     זמן (epoch) של הקומיט האחרון שהשפיע על הרשומה
//
// מדיניות: רשומה נמחקת רק אחרי שהאוסף שהיא שייכת אליו ירד וחולץ בהצלחה. אוסף שייך לרשומה אם הוא תיקיית-אב של
// ה-"to" (העברה) או של ה-path (מחיקה). כך משתמש לא נשאר בלי הספר: הישן נמחק רק כשהחדש כבר בדיסק.
// ההורדה הראשונה של אוסף לא מוחקת כלום, כי אין בדיסק מה לנקות.
(function (root) {
    'use strict';

    /// נתיב בטוח למחיקה: יחסי, בלי "." או ".." או קטעים ריקים, בלי backslash, בלי אות כונן ובלי תווי בקרה.
    /// אוצריא כבר חוסמת מחיקה מחוץ לתיקייה שנבחרה. זו הגנה נוספת מפני רשימה שהשתנתה: גם בתוך התיקייה
    /// מוחקים רק מה שנראה כנתיב ספר.
    const UNSAFE_CHARS = /[\\\u0000-\u001f]/;
    const ABSOLUTE = /^[\/]|^[A-Za-z]:/;
    function isSafePath(p) {
        if (typeof p !== 'string' || !p || p.length > 600) return false;
        if (UNSAFE_CHARS.test(p) || ABSOLUTE.test(p)) return false;
        return p.split('/').every(seg => seg && seg !== '.' && seg !== '..' && seg.trim() === seg);
    }

    /// פענוח התוכן של removed_files.json. מחזיר מערך רשומות תקינות (ריק אם הקובץ פגום).
    function parseRemovals(text) {
        try {
            const d = JSON.parse(text);
            const arr = Array.isArray(d) ? d : (d && d.removed);
            if (!Array.isArray(arr)) return [];
            return arr.filter(e => e && Number.isFinite(e.t) && isSafePath(e.path) &&
                (e.to === undefined || isSafePath(e.to)));
        } catch { return []; }
    }

    function belongsTo(entry, nodePath) {
        const p = entry.to || entry.path;
        return p.startsWith(nodePath + '/');
    }

    /// הרשומות של אוסף ([nodePath]) שטרם הוחלו, לפי הזמן שהוחל עד כה ([appliedT]).
    function pendingFor(entries, nodePath, appliedT) {
        return entries
            .filter(e => belongsTo(e, nodePath) && e.t > (appliedT || 0))
            .sort((a, b) => a.t - b.t);
    }

    function classify(err) {
        const s = String(err && (err.code || err.message || err) || '').toLowerCase();
        if (s.includes('not_found') || s.includes('not found') || s.includes('no such file') || s.includes('enoent')) return 'missing';
        if (s.includes('unknown_method') || s.includes('unknown method')) return 'unsupported';
        return 'failed';
    }

    async function deleteOne(call, path) {
        try {
            const res = await call('fs.deleteFile', { path });
            if (res && res.success === false) return classify(res.error);
            return 'deleted';
        } catch (e) { return classify(e); }
    }

    /// מוחק את הרשומות הממתינות של האוסף מתיקיית היעד.
    /// מחזיר { deleted, missing, failed, unsupported, appliedT }, כש-appliedT הוא הזמן החדש לשמירה.
    /// אם נכשל אפילו קובץ אחד (או שאוצריא אינה תומכת במחיקה), הזמן אינו מתקדם והניסיון יחזור בפעם הבאה.
    async function applyRemovals({ entries, nodePath, destFolder, appliedT, call }) {
        const todo = pendingFor(entries, nodePath, appliedT);
        const out = { deleted: 0, missing: 0, failed: 0, unsupported: false, appliedT: appliedT || 0 };
        for (const e of todo) {
            const r = await deleteOne(call, destFolder + '/' + e.path);
            if (r === 'deleted') out.deleted++;
            else if (r === 'missing') out.missing++;
            else if (r === 'unsupported') { out.unsupported = true; break; }
            else out.failed++;
        }
        if (!out.unsupported && out.failed === 0 && todo.length) out.appliedT = todo[todo.length - 1].t;
        return out;
    }

    /// הזמן המרבי של רשומות האוסף (לסימון "הוחל" בהורדה ראשונה, שבה אין מה למחוק).
    function maxTFor(entries, nodePath) {
        return entries.filter(e => belongsTo(e, nodePath)).reduce((m, e) => Math.max(m, e.t), 0);
    }

    const api = { isSafePath, parseRemovals, belongsTo, pendingFor, applyRemovals, maxTFor };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.Removals = api;
})(typeof window !== 'undefined' ? window : globalThis);
