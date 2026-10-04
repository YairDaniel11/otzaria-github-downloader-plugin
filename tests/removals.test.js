// בדיקות ל-src/removals.js. הרצה: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/removals.js');

const E = (t, path, to) => (to ? { t, path, to } : { t, path });

test('parseRemovals: מקבל אובייקט או מערך, ומסנן רשומות פגומות', () => {
    const good = [E(5, 'א/ב.txt', 'א/ג.txt'), E(7, 'ד/ה.txt')];
    assert.deepEqual(R.parseRemovals(JSON.stringify({ version: 1, removed: good })), good);
    assert.deepEqual(R.parseRemovals(JSON.stringify(good)), good);
    assert.deepEqual(R.parseRemovals(JSON.stringify({ removed: [{ path: 'x' }, null, { t: 1, path: '' }, E(1, 'y')] })), [E(1, 'y')]);
    assert.deepEqual(R.parseRemovals('לא json'), []);
    assert.deepEqual(R.parseRemovals('{"removed": 5}'), []);
});

test('pendingFor: האוסף של ה-to בהעברה ושל ה-path במחיקה, ורק מה שחדש מהזמן שהוחל', () => {
    const entries = [E(10, 'ישן/א.txt', 'חדש/א.txt'), E(20, 'חדש/ב.txt'), E(30, 'אחר/ג.txt')];
    assert.deepEqual(R.pendingFor(entries, 'חדש', 0).map(e => e.path), ['ישן/א.txt', 'חדש/ב.txt']);
    assert.deepEqual(R.pendingFor(entries, 'ישן', 0), []);                       // ההעברה שייכת ליעד, לא למקור
    assert.deepEqual(R.pendingFor(entries, 'חדש', 10).map(e => e.path), ['חדש/ב.txt']);
    assert.deepEqual(R.pendingFor(entries, 'חד', 0), []);                        // קידומת חלקית של שם אינה תיקייה
});

function fakeCall(files, opts = {}) {
    const calls = [];
    const fn = async (method, params) => {
        calls.push([method, params.path]);
        if (opts.unsupported) return { success: false, error: { code: 'error.unknown_method' } };
        if (opts.fail && opts.fail.has(params.path)) throw new Error('disk error');
        if (!files.has(params.path)) return { success: false, error: { code: 'error.not_found' } };
        files.delete(params.path);
        return { success: true };
    };
    fn.calls = calls;
    return fn;
}

test('applyRemovals: מוחק קיימים, מתעלם מלא-קיימים, ומקדם את הזמן', async () => {
    const dest = 'C:/ספרים';
    const files = new Set([`${dest}/ישן/א.txt`, `${dest}/חדש/ב.txt`]);
    const entries = [E(10, 'ישן/א.txt', 'חדש/א.txt'), E(20, 'חדש/ב.txt'), E(25, 'חדש/לא-קיים.txt')];
    const call = fakeCall(files);
    const r = await R.applyRemovals({ entries, nodePath: 'חדש', destFolder: dest, appliedT: 0, call });
    assert.deepEqual([r.deleted, r.missing, r.failed, r.unsupported, r.appliedT], [2, 1, 0, false, 25]);
    assert.equal(files.size, 0);
    // הרצה חוזרת: אין מה לעשות
    const again = await R.applyRemovals({ entries, nodePath: 'חדש', destFolder: dest, appliedT: r.appliedT, call: fakeCall(files) });
    assert.deepEqual([again.deleted, again.appliedT], [0, 25]);
});

test('applyRemovals: כשל במחיקה אינו מקדם את הזמן (ינסה שוב), אבל ממשיך לשאר', async () => {
    const dest = 'D:/x';
    const files = new Set([`${dest}/ת/א.txt`, `${dest}/ת/ב.txt`]);
    const entries = [E(1, 'ת/א.txt'), E(2, 'ת/ב.txt')];
    const r = await R.applyRemovals({ entries, nodePath: 'ת', destFolder: dest, appliedT: 0,
        call: fakeCall(files, { fail: new Set([`${dest}/ת/א.txt`]) }) });
    assert.deepEqual([r.deleted, r.failed, r.appliedT], [1, 1, 0]);
    assert.ok(!files.has(`${dest}/ת/ב.txt`));
});

test('applyRemovals: אוצריא ישנה (unknown_method) עוצרת, בלי להתקדם', async () => {
    const call = fakeCall(new Set(), { unsupported: true });
    const r = await R.applyRemovals({ entries: [E(1, 'ת/א.txt'), E(2, 'ת/ב.txt')], nodePath: 'ת', destFolder: 'D:/x', appliedT: 0, call });
    assert.equal(r.unsupported, true);
    assert.equal(r.appliedT, 0);
    assert.equal(call.calls.length, 1);
});

test('maxTFor: הזמן המרבי של האוסף (להורדה ראשונה)', () => {
    const entries = [E(10, 'א/ב.txt'), E(40, 'ג/ד.txt', 'א/ה.txt'), E(99, 'ו/ז.txt')];
    assert.equal(R.maxTFor(entries, 'א'), 40);
    assert.equal(R.maxTFor(entries, 'ח'), 0);
});
