// בדיקות ל-src/dbmodule.js. הרצה: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../src/dbmodule.js');

test('normalizeVersion: מספר שלם חיובי בלבד', () => {
    assert.equal(D.normalizeVersion(12), 12);
    assert.equal(D.normalizeVersion('7'), 7);
    assert.equal(D.normalizeVersion(' 7 '), 7);
    for (const bad of [0, -1, 1.5, '0', '1.2', 'abc', '', null, undefined, NaN, {}, '1/../2']) {
        assert.equal(D.normalizeVersion(bad), null, String(bad));
    }
});

test('buildDbDownloadUrl: release db-v<N> ונכס otzarya-unofficial-books-<N>.db', () => {
    assert.equal(
        D.buildDbDownloadUrl(5),
        'https://github.com/YairDaniel11/Otzarya-Unofficial-Books/releases/download/db-v5/otzarya-unofficial-books-5.db',
    );
    assert.equal(D.buildDbDownloadUrl('12'), D.buildDbDownloadUrl(12));
    assert.equal(D.buildDbDownloadUrl('../x'), null);
    assert.equal(D.buildDbDownloadUrl(undefined), null);
});

const P = 'https://github.com/YairDaniel11/Otzarya-Unofficial-Books';
const rel = (n, over = {}, withAsset = true) => ({
    tag_name: `db-v${n}`, draft: false, prerelease: false,
    html_url: `${P}/releases/tag/db-v${n}`,
    assets: withAsset ? [
        { name: `otzarya-unofficial-books-${n}.db`, size: 1024 * 1024 * n, browser_download_url: `${P}/releases/download/db-v${n}/otzarya-unofficial-books-${n}.db` },
        { name: 'manifest.json', size: 300, browser_download_url: `${P}/releases/download/db-v${n}/manifest.json` },
    ] : [{ name: 'manifest.json', size: 300, browser_download_url: `${P}/releases/download/db-v${n}/manifest.json` }],
    ...over,
});

test('כתובות ה-API וההורדה תחת הקידומת שב-allowlist של התוסף', () => {
    assert.ok(D.buildDbDownloadUrl(1).startsWith(P + '/'));
    assert.equal(D.DB_RELEASES_URL, 'https://api.github.com/repos/YairDaniel11/Otzarya-Unofficial-Books/releases?per_page=100');
});

test('pickLatestDbRelease: כמה releases, נבחר הגבוה ביותר (מספרית: db-v10 > db-v9)', () => {
    const r = D.pickLatestDbRelease(JSON.stringify([rel(2), rel(10), rel(9), { tag_name: 'v3.4.0', assets: [] }, rel(1)]));
    assert.equal(r.state, 'ready');
    assert.equal(r.version, 10);
    assert.equal(r.url, `${P}/releases/download/db-v10/otzarya-unofficial-books-10.db`);
    assert.equal(r.size, 10 * 1024 * 1024);
    assert.equal(r.sizeText, '10 MB');
    assert.equal(r.pageUrl, `${P}/releases/tag/db-v10`);
});

test('pickLatestDbRelease: draft ו-prerelease מדולגים', () => {
    const r = D.pickLatestDbRelease([rel(12, { draft: true }), rel(11, { prerelease: true }), rel(5)]);
    assert.equal(r.version, 5);
    assert.equal(D.pickLatestDbRelease([rel(3, { draft: true })]), null);
});

test('pickLatestDbRelease: הגבוה ביותר בלי הנכס -> no-asset (לא נופל לגרסה נמוכה יותר)', () => {
    const r = D.pickLatestDbRelease([rel(3), rel(4, {}, false)]);
    assert.deepEqual(r, { state: 'no-asset', version: 4, pageUrl: `${P}/releases/tag/db-v4` });
});

test('pickLatestDbRelease: נכס בשם של גרסה אחרת אינו נחשב', () => {
    const bad = rel(6, { assets: [{ name: 'otzarya-unofficial-books-5.db', size: 1, browser_download_url: `${P}/x` }] });
    assert.equal(D.pickLatestDbRelease([bad]).state, 'no-asset');
});

test('pickLatestDbRelease: גודל חסר אינו כשל; כתובת מחוץ למאגר מוחלפת בבנויה', () => {
    const a = rel(7);
    delete a.assets[0].size;
    assert.equal(D.pickLatestDbRelease([a]).sizeText, '');
    assert.equal(D.pickLatestDbRelease([a]).size, null);
    const evil = rel(8);
    evil.assets[0].browser_download_url = 'https://evil.example/x.db';
    evil.html_url = 'https://evil.example/';
    const r = D.pickLatestDbRelease([evil]);
    assert.equal(r.url, D.buildDbDownloadUrl(8));
    assert.equal(r.pageUrl, `${P}/releases/tag/db-v8`);
});

test('pickLatestDbRelease: קלט פגום -> null', () => {
    for (const bad of ['', 'לא json', '{}', 'null', '[]', '[null, 5, {"tag_name": 7}]', '[{"tag_name":"db-v0"}]',
                       '[{"tag_name":"db-v1x"}]', '[{"tag_name":"xdb-v2"}]', undefined, null]) {
        assert.equal(D.pickLatestDbRelease(bad), null, String(bad));
    }
    assert.equal(D.pickLatestDbRelease([{ tag_name: 'db-v2', assets: null }]).state, 'no-asset');
});

test('formatBytes', () => {
    assert.equal(D.formatBytes(0), '0 בייט');
    assert.equal(D.formatBytes(1023), '1023 בייט');
    assert.equal(D.formatBytes(1024), '1 KB');
    assert.equal(D.formatBytes(1536), '1.5 KB');
    assert.equal(D.formatBytes(1024 * 1024 * 300), '300 MB');
    assert.equal(D.formatBytes(1024 ** 3 * 1.5), '1.5 GB');
    assert.equal(D.formatBytes('2048'), '2 KB');
    assert.equal(D.formatBytes(-5), '');
    assert.equal(D.formatBytes(NaN), '');
    assert.equal(D.formatBytes(undefined), '');
});

test('buildDbDestPath: שם קבוע בלי גרסה, בלי מפרידים כפולים', () => {
    assert.equal(D.buildDbDestPath('C:\\Dbs'), 'C:\\Dbs\\otzarya-unofficial-books.db');
    assert.equal(D.buildDbDestPath('C:\\Dbs\\'), 'C:\\Dbs\\otzarya-unofficial-books.db');
    assert.equal(D.buildDbDestPath('/home/u/dbs/'), '/home/u/dbs/otzarya-unofficial-books.db');
    assert.equal(D.buildDbDestPath('/home/u/dbs'), '/home/u/dbs/otzarya-unofficial-books.db');
    assert.equal(D.buildDbDestPath(''), null);
    assert.equal(D.buildDbDestPath(null), null);
    assert.equal(D.DB_LOCAL_NAME, 'otzarya-unofficial-books.db');
});

test('shouldShowRecommend: רק true שמור מסתיר', () => {
    assert.equal(D.shouldShowRecommend(undefined), true);
    assert.equal(D.shouldShowRecommend(null), true);
    assert.equal(D.shouldShowRecommend(false), true);
    assert.equal(D.shouldShowRecommend(true), false);
});

test('formatElapsed', () => {
    assert.equal(D.formatElapsed(0), '0:00');
    assert.equal(D.formatElapsed(65), '1:05');
    assert.equal(D.formatElapsed(3599.9), '59:59');
    assert.equal(D.formatElapsed(-3), '0:00');
    assert.equal(D.formatElapsed('x'), '0:00');
});

test('safeAssetUrl: רק הכתובת המדויקת של נכס אותה גרסה', () => {
    const ok = `${P}/releases/download/db-v5/otzarya-unofficial-books-5.db`;
    assert.equal(D.safeAssetUrl(ok, 5), ok);
    for (const bad of [
        `${P}/releases/download/db-v5/../db-v4/otzarya-unofficial-books-5.db`,   // ..
        `${P}/releases/download/db-v5/otzarya-unofficial-books-4.db`,           // גרסה אחרת בשם הקובץ
        `${P}/releases/download/db-v4/otzarya-unofficial-books-5.db`,           // גרסה אחרת בתג
        `${P}/raw/main/otzarya-unofficial-books-5.db`,                          // נתיב אחר מתחת למאגר
        `${P}/releases/download/db-v5/manifest.json`,
        `${P}/releases/download/db-v5/otzarya-unofficial-books-5.db?x=1`,
        `${P}/releases/download/db-v5/otzarya-unofficial-books-5.db/`,
        `http://github.com/YairDaniel11/Otzarya-Unofficial-Books/releases/download/db-v5/otzarya-unofficial-books-5.db`,
        'https://evil.example/x.db', '', null, undefined, 5,
    ]) assert.equal(D.safeAssetUrl(bad, 5), '', String(bad));
    assert.equal(D.safeAssetUrl(ok, 'x'), '');
});

test('pickLatestDbRelease: browser_download_url חשוד מוחלף בכתובת הבנויה', () => {
    const r1 = rel(5);
    r1.assets[0].browser_download_url = `${P}/releases/download/db-v5/../db-v1/otzarya-unofficial-books-5.db`;
    assert.equal(D.pickLatestDbRelease([r1]).url, D.buildDbDownloadUrl(5));
    const r2 = rel(6);
    r2.assets[0].browser_download_url = `${P}/raw/main/otzarya-unofficial-books-6.db`;
    assert.equal(D.pickLatestDbRelease([r2]).url, D.buildDbDownloadUrl(6));
});

test('describeApiStatus: 403/429 הם הגבלת קצב', () => {
    assert.equal(D.describeApiStatus(403), 'GitHub הגביל זמנית את הבקשות; נסה שוב בעוד כמה דקות');
    assert.equal(D.describeApiStatus(429), D.describeApiStatus(403));
    assert.equal(D.describeApiStatus(404), '');
    assert.equal(D.describeApiStatus(500), '');
});

test('createGuard: לחיצה כפולה לא נכנסת פעמיים, ואחרי leave אפשר שוב', async () => {
    const g = D.createGuard();
    let runs = 0;
    const handler = async () => {
        if (!g.tryEnter()) return;
        try { runs++; await new Promise(r => setTimeout(r, 5)); } finally { g.leave(); }
    };
    await Promise.all([handler(), handler(), handler()]);
    assert.equal(runs, 1);
    assert.equal(g.busy, false);
    await handler();
    assert.equal(runs, 2);
});

test('createGuard: leave אחרי חריגה משחרר', async () => {
    const g = D.createGuard();
    await assert.rejects(async () => { g.tryEnter(); try { throw new Error('x'); } finally { g.leave(); } });
    assert.equal(g.tryEnter(), true);
});

test('sameFolder: מפרידים, סלש סופי ואותיות בכונן', () => {
    assert.equal(D.sameFolder('C:\\Dbs', 'c:/dbs/'), true);
    assert.equal(D.sameFolder('C:\\Dbs\\', 'C:\\Dbs'), true);
    assert.equal(D.sameFolder('/home/U/dbs', '/home/u/dbs'), false);
    assert.equal(D.sameFolder('C:\\Dbs', 'C:\\Other'), false);
    assert.equal(D.sameFolder('', 'C:\\Dbs'), false);
    assert.equal(D.sameFolder(null, null), false);
});

test('describeChips: גודל רק כשיש נכס; בלי נכס וכשל API מקבלים טקסט ברור', () => {
    const ready = D.pickLatestDbRelease([rel(4)]);
    assert.deepEqual(D.describeChips(ready, false), { version: 'גרסה אחרונה: 4', size: 'גודל: 4 MB' });
    const noSize = D.pickLatestDbRelease([(() => { const r = rel(4); delete r.assets[0].size; return r; })()]);
    assert.deepEqual(D.describeChips(noSize, false), { version: 'גרסה אחרונה: 4', size: '' });
    const noAsset = D.pickLatestDbRelease([rel(4, {}, false)]);
    assert.deepEqual(D.describeChips(noAsset, false), { version: 'גרסה אחרונה: 4', size: 'הקובץ הרגיל עדיין לא פורסם' });
    assert.ok(!/גודל/.test(D.describeChips(noAsset, false).size));
    assert.deepEqual(D.describeChips(null, true), { version: '', size: 'לא ניתן לטעון את פרטי הגרסה' });
    assert.deepEqual(D.describeChips(null, false), { version: '', size: '' });
});
