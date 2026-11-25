# -*- coding: utf-8 -*-
"""ליבת ההתקנה של וקטורי החיפוש-לפי-משמעות של "מאגר ספרים לא רשמי" באוצריא (בלי ממשק).

מקור הלוגיקה: cmd_install (vectors_ci.py) ו-publish_generation (otzaria_personal_vectors.py) במאגר
YairDaniel11/Otzarya-Unofficial-Books, אחרי שהוסרה התלות ב-numpy. כל הודעות השגיאה (InstallError) כתובות
בעברית פשוטה, למשתמש שאינו טכני.

סדר הפעולות (CURRENT נכתב אחרון, ולכן כשל לפניו לא משאיר שינוי בסט):
  1 איתור תיקיית הוקטורים של אוצריא   2 אוצריא סגורה   3 הורדת המניפסט ואימות חתימה (ed25519)
  4 בדיקות התאמה (מודל, גרסת מסד, אין כבר וקטורים לספרי המאגר, מקום פנוי)
  5 הורדה ואימות sha256   6 פריסת zstd ואימות   7 יצירת דור חדש (נעילה, PREVIOUS, CURRENT)
"""
import base64
import hashlib
import json
import os
import re
import shutil
import sqlite3
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from pathlib import Path

REPO = "YairDaniel11/Otzarya-Unofficial-Books"
SLUG = "otzarya-unofficial-books"
# המפתח הציבורי שחותם את המסד ואת מניפסט הוקטורים (נמצא גם ב-schema_meta.update_public_key במסד)
PUBLIC_KEY_B64 = "mLRPx/L43Th/nAVhJ2rDecHFQH/vfdv2xRjIz/IvEBY="
MANIFEST_URL = f"https://github.com/{REPO}/releases/download/vectors/vectors-manifest.json"
SIG_URL = MANIFEST_URL + ".sig"
ASSET_URL = f"https://github.com/{REPO}/releases/download/vectors-v{{n}}/{{file}}"

MAGIC = b"OXVSEG\r\n"
HEADER_LEN = 4096
BOOK_NAMES = 0x0002
DEL_MAGIC, LINKS_MAGIC = b"OXVDEL1\n", b"OXVLNK1\n"
WORKER = "otzaria-personal-vectors 1.0"
OURS = ("otzaria-personal-vectors", "otzaria-sources personal export")
SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$")
MAX_MANIFEST_BYTES = 1 << 20


class InstallError(Exception):
    """שגיאה שאפשר להציג למשתמש כמות שהיא."""


class Cancelled(Exception):
    pass


# ------------------------------------------------------------------ כלים קטנים

def crc(b):
    return zlib.crc32(b) & 0xFFFFFFFF


def sha256_file(path, chunk=8 << 20):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(chunk), b""):
            h.update(b)
    return h.hexdigest()


def fmt_bytes(n):
    v = float(n)
    for u in ("בייט", "KB", "MB", "GB"):
        if v < 1024 or u == "GB":
            return f"{v:.0f} {u}" if u == "בייט" else f"{v:.1f} {u}"
        v /= 1024


def write_durable(path, data):
    tmp = Path(str(path) + ".tmp")
    with open(tmp, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


# ------------------------------------------------------------------ איתור אוצריא

def read_hive_strings(path):
    """ערכי המחרוזת של קופסת Hive (app_preferences.hive): מסגרות [u32 אורך][מפתח][ערך][crc32]; האחרונה גוברת."""
    data = Path(path).read_bytes()
    out, pos = {}, 0
    while pos + 9 <= len(data):
        ln = struct.unpack_from("<I", data, pos)[0]
        if ln < 9 or pos + ln > len(data):
            break
        f = data[pos + 4:pos + ln - 4]
        pos += ln
        if f[0] == 1:
            kl = f[1]
            key, v = f[2:2 + kl].decode("utf-8", "replace"), f[2 + kl:]
        elif f[0] == 0:
            key, v = struct.unpack_from("<I", f, 1)[0], f[5:]
        else:
            break
        if not v:
            out.pop(key, None)
        elif v[0] == 4 and len(v) >= 5:
            sl = struct.unpack_from("<I", v, 1)[0]
            out[key] = v[5:5 + sl].decode("utf-8", "replace")
        else:
            out.pop(key, None)
    return out


def _read_text(path):
    try:
        t = Path(path).read_text(encoding="utf-8-sig").strip()
        return t or None
    except OSError:
        return None


def locate(data_dir=None):
    """מאתרת את הגדרות אוצריא ואת תיקיית הוקטורים, כמו שאוצריא מאתרת אותן.
    מחזירה {"data", "vectors", "attached"}; vectors הוא None אם לא נמצא סט וקטורים."""
    data_dir = Path(data_dir) if data_dir else \
        Path(os.environ.get("APPDATA") or (Path.home() / "AppData" / "Roaming")) / "otzaria"
    try:
        prefs = read_hive_strings(data_dir / "app_preferences.hive")
    except OSError:
        prefs = {}
    lib = prefs.get("key-library-path") or _read_text(data_dir / "library_path.txt")
    pd = Path(os.environ.get("ProgramData") or r"C:\ProgramData") / "otzaria"
    cands = ([Path(lib)] if lib else []) + [data_dir / "books", pd / "books"]
    vectors = next((c.parent / "vectors" for c in cands if (c.parent / "vectors" / "CURRENT").exists()), None)
    try:
        attached = json.loads(prefs.get("key-attached-libraries") or "[]")
        attached = [x for x in attached if isinstance(x, dict) and x.get("path")]
    except ValueError:
        attached = []
    return {"data": data_dir, "vectors": vectors, "attached": attached}


def installed_db_version(attached, slug=SLUG):
    """גרסת המסד האישי המצורף (schema_meta.db_version), או None אם לא מותקן."""
    for e in attached:
        if str(e.get("slug")) != slug or not Path(e["path"]).exists():
            continue
        uri = "file:" + urllib.parse.quote(Path(e["path"]).as_posix(), safe="/:") + "?mode=ro"
        try:
            con = sqlite3.connect(uri, uri=True)
            try:
                row = con.execute("select value from schema_meta where key='db_version'").fetchone()
            finally:
                con.close()
            return int(row[0]) if row and str(row[0]).isdigit() else None
        except sqlite3.Error:
            return None
    return None


def installed_db_lines(attached, slug=SLUG):
    """{book.id: totalLines} של המסד האישי המצורף, או None אם אי אפשר לקרוא."""
    for e in attached:
        if str(e.get("slug")) != slug or not Path(e["path"]).exists():
            continue
        uri = "file:" + urllib.parse.quote(Path(e["path"]).as_posix(), safe="/:") + "?mode=ro"
        try:
            con = sqlite3.connect(uri, uri=True)
            try:
                return {int(i): int(n) for i, n in con.execute("select id, totalLines from book")}
            finally:
                con.close()
        except (sqlite3.Error, ValueError, TypeError):
            return None
    return None


# הוקטורים תקפים גם למסד חדש יותר כל עוד פריסת השורות של הספרים זהה (ה-hint הוא מיקום השורה בספר).
# עד 2% מהספרים (ולא פחות מ-5) רשאים להשתנות; מזהי הספרים יציבים בין גרסאות המסד.
STALE_RATIO = 0.02
STALE_MIN = 5


def layout_compat(man, have_lines):
    """(ok, stale): האם פריסת הספרים במסד המותקן תואמת למניפסט. בלי bookLines במניפסט או בלי have_lines: (False, [])."""
    want = {}
    try:
        want = {int(k): int(v) for k, v in (man["db"].get("bookLines") or {}).items()}
    except (ValueError, TypeError, AttributeError):
        pass
    if not want or have_lines is None:
        return False, []
    stale = [i for i, n in want.items() if i in have_lines and have_lines[i] != n]
    return len(stale) <= max(STALE_MIN, int(len(want) * STALE_RATIO)), stale


def otzaria_running():
    if os.name != "nt":
        return False
    try:
        out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq otzaria.exe", "/FO", "CSV", "/NH"],
                             capture_output=True, text=True, timeout=20,
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout
        return "otzaria.exe" in out.lower()
    except Exception:
        return False


# ------------------------------------------------------------------ קבצי הסט של אוצריא

def read_header(path):
    with open(path, "rb") as f:
        h = f.read(HEADER_LEN)
    if len(h) < HEADER_LEN or h[:8] != MAGIC:
        raise ValueError(f"{path}: אינו מקטע וקטורים")
    if struct.unpack_from("<I", h, 4088)[0] != crc(h[:4088]):
        raise ValueError(f"{path}: כותרת פגומה")
    version, _hlen, flags, dim, codec, block, nsec = struct.unpack_from("<IIIHHII", h, 8)
    slots, extras, foreign, tombs = struct.unpack_from("<4Q", h, 112)
    books, frm, to = struct.unpack_from("<3I", h, 144)
    sections = []
    for i in range(nsec):
        kind, fl, es, off, ln, cnt, c = struct.unpack_from("<HHIQQQI", h, 224 + 40 * i)
        sections.append({"kind": kind, "off": off, "len": ln})
    return {"version": version, "id": h[32:48], "identity_digest": h[48:80], "slots": slots,
            "foreign": foreign, "books": books, "sections": sections}


def read_pointer(vdir, name):
    p = Path(vdir) / name
    return json.loads(p.read_text(encoding="utf-8-sig")) if p.exists() else None


class LiveSet:
    """הדור ש-CURRENT מצביע עליו: המסמך שלו וכותרות המקטעים."""

    def __init__(self, vdir):
        self.dir = Path(vdir)
        self.pointer = read_pointer(self.dir, "CURRENT")
        if not self.pointer:
            raise InstallError("לא נמצא סט וקטורים של אוצריא בתיקייה הזו (אין בה קובץ CURRENT).")
        self.set_path = self.dir / self.pointer["set"]
        raw = self.set_path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != self.pointer["set_sha256"]:
            raise InstallError("סט הוקטורים של אוצריא נראה פגום (CURRENT אינו תואם). ההתקנה נעצרה כדי לא להזיק.")
        self.doc = json.loads(raw.decode("utf-8"))
        self.gen_dir = self.set_path.parent
        self.headers = [read_header(self.dir / s["file"]) for s in self.doc["segments"]]


def is_ours(seg):
    return (seg.get("provenance") or {}).get("worker", {}).get("backend", "").startswith(OURS)


def has_repo_books(vdir, seg, header, slug=SLUG):
    """האם המקטע כבר מכיל וקטורים של ספרי המאגר (שמות db:<slug>:<id>). נבדק בקטע שמות הספרים בלבד."""
    needle = f"db:{slug}:".encode()
    s = next((x for x in header["sections"] if x["kind"] == BOOK_NAMES), None)
    if not s or s["len"] <= 0:
        return False
    with open(Path(vdir) / seg["file"], "rb") as f:
        f.seek(s["off"])
        return needle in f.read(min(s["len"], 256 << 20))


class SetLock:
    """<vectors>/.lock: נעילה אקסקלוסיבית, כמו שאוצריא לוקחת בהתקנה."""

    def __init__(self, vdir):
        self.f = open(Path(vdir) / ".lock", "a+b")
        try:
            if os.name == "nt":
                import msvcrt
                self.f.seek(0)
                msvcrt.locking(self.f.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.f.close()
            raise InstallError("סט הוקטורים נעול כרגע (אוצריא עדיין פתוחה או עובדת עליו). סגרו את אוצריא ונסו שוב.")

    def release(self):
        try:
            if os.name == "nt":
                import msvcrt
                self.f.seek(0)
                msvcrt.locking(self.f.fileno(), msvcrt.LK_UNLCK, 1)
        finally:
            self.f.close()


def next_generation(vdir):
    nums = [0]
    for d in Path(vdir).glob("gen-*"):
        try:
            nums.append(int(d.name[4:]))
        except ValueError:
            pass
    for name in ("CURRENT", "PREVIOUS"):
        try:
            nums.append(int((read_pointer(vdir, name) or {}).get("generation", 0)))
        except (ValueError, OSError):
            pass
    return max(nums) + 1


def publish_generation(live, written, package, device):
    """דור חדש: מקטעי הדור החי (בלי מקטע "שלנו" ישן, אם היה), ה-.del/.links שלהם, והמקטע החדש.
    CURRENT נכתב אחרון. מחזירה את מספר הדור. אם נכשל באמצע, תיקיית הדור החדש נמחקת ו-CURRENT לא משתנה."""
    vdir, doc = live.dir, live.doc
    gen = next_generation(vdir)
    gdir = vdir / f"gen-{gen:06d}"
    gdir.mkdir()
    try:
        others = [s for s in doc["segments"] if not is_ours(s)]
        for seg in others:
            for key in ("del", "links"):
                if seg.get(key):
                    shutil.copyfile(live.gen_dir / seg[key]["file"], gdir / seg[key]["file"])
        sid, n = written["id"], written["slots"]
        delb = DEL_MAGIC + struct.pack("<QQ", n, 0) + b"\0" * (8 * (-(-n // 64)))
        delb += struct.pack("<I", crc(delb))
        linkb = LINKS_MAGIC + struct.pack("<Q", 0)
        linkb += struct.pack("<I", crc(linkb))
        write_durable(gdir / f"{sid}.del", delb)
        write_durable(gdir / f"{sid}.links", linkb)
        v = written["version"]
        ours = {"id": sid, "file": f"segments/{sid}.oxv", "kind": "delta", "from": v, "to": v,
                "sha256": written["sha256"], "size": written["size"], "slots": n,
                "provenance": {"passage_package": package, "worker": {"backend": WORKER, "device": device}},
                "del": {"file": f"{sid}.del", "crc32": crc(delb[:-4]), "count": 0},
                "links": {"file": f"{sid}.links", "crc32": crc(linkb[:-4]), "count": 0}}
        segments = others + [ours]
        new = dict(doc)
        new["generation"] = gen
        new["segments"] = segments
        headers = {s["id"]: h for s, h in zip(doc["segments"], live.headers)}
        new["stats"] = {
            "slots": sum(s["slots"] for s in segments),
            "slots_dead": sum(s["del"]["count"] for s in segments),
            "foreign": sum(headers[s["id"]]["foreign"] for s in segments if s["id"] in headers),
            "foreign_unresolved": sum((s.get("links") or {}).get("count", 0) for s in segments),
            "bytes": sum(s["size"] for s in segments)}
        new["created_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        raw = json.dumps(new, ensure_ascii=False, indent=2).encode("utf-8")
        write_durable(gdir / "set.json", raw)
        pointer = json.dumps({"generation": gen, "set": f"gen-{gen:06d}/set.json",
                              "set_sha256": hashlib.sha256(raw).hexdigest()}, separators=(",", ":")).encode()
        write_durable(vdir / "PREVIOUS", (vdir / "CURRENT").read_bytes())
        write_durable(vdir / "CURRENT", pointer)   # אחרון: עד כאן אוצריא עדיין רואה את הסט הישן
    except BaseException:
        shutil.rmtree(gdir, ignore_errors=True)
        raise
    return gen


# ------------------------------------------------------------------ מניפסט וחתימה

def verify_signature(manifest_raw, sig_raw, public_key_b64=PUBLIC_KEY_B64):
    """ed25519 על בייטי המניפסט כפי שהורדו. חתימה = base64 של 64 בתים. מחזירה True/False, לא זורקת."""
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
        sig = base64.b64decode(sig_raw.decode("ascii").strip(), validate=True)
        if len(sig) != 64 or len(sig_raw) > 256:
            return False
        Ed25519PublicKey.from_public_bytes(base64.b64decode(public_key_b64)).verify(sig, manifest_raw)
        return True
    except Exception:
        return False


def parse_manifest(raw):
    try:
        man = json.loads(raw.decode("utf-8-sig"))
        files = man["files"]
        seg = man["segment"]
        ok = (man.get("kind") == "supplement" and man.get("compression") == "zstd" and files
              and isinstance(man["db"]["version"], int) and man["db"].get("slug") == SLUG
              and re.fullmatch(r"[0-9a-f]{32}", str(seg["id"]))
              and re.fullmatch(r"[0-9a-f]{64}", str(seg["sha256"]))
              and all(SAFE_NAME.match(str(e["file"])) and isinstance(e["size"], int) and e["size"] > 0
                      and re.fullmatch(r"[0-9a-f]{64}", str(e["sha256"])) for e in files)
              and isinstance(seg["size"], int) and isinstance(seg["slots"], int)
              and man["identityDigest"] and man["codecParamsSha256"])
        if not ok:
            raise ValueError("מבנה")
    except (ValueError, KeyError, TypeError):
        raise InstallError("קובץ הפרטים של הוקטורים בגיטאב אינו בפורמט שהתוכנה מכירה. ייתכן שיש גרסה חדשה של התוכנה.")
    return man


def http_get(url, timeout=60, limit=MAX_MANIFEST_BYTES):
    req = urllib.request.Request(url, headers={"User-Agent": "otzaria-vectors-installer"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read(limit + 1)
    if len(data) > limit:
        raise InstallError("הקובץ שהתקבל גדול מהצפוי.")
    return data


def fetch_manifest(get=http_get):
    """מוריד מניפסט וחתימה, מאמת. מחזיר את המניפסט המפוענח."""
    try:
        raw, sig = get(MANIFEST_URL), get(SIG_URL)
    except (urllib.error.URLError, OSError) as e:
        raise InstallError(f"אין חיבור לגיטאב כרגע. בדקו את האינטרנט ונסו שוב. ({e})")
    if not verify_signature(raw, sig):
        raise InstallError("החתימה של קובץ הוקטורים אינה תקינה, ולכן ההתקנה נעצרה. אל תמשיכו, ודווחו על כך.")
    return parse_manifest(raw)


# ------------------------------------------------------------------ בדיקות מקדימות

def check_preconditions(man, live, have_db_version, free_bytes, vdir, have_lines=None):
    """זורקת InstallError עם הסבר, או מחזירה 'installed' אם הסגמנט הזה כבר מותקן, או None אם אפשר להתקין."""
    doc = live.doc
    if doc["identity_digest"] != man["identityDigest"] or doc["codec_params_sha256"] != man["codecParamsSha256"]:
        raise InstallError("הוקטורים נבנו למודל חיפוש אחר מזה שבאוצריא שלכם (כנראה אוצריא התעדכנה). "
                           "אי אפשר להתקין כרגע; צריך לחכות לגרסה חדשה של הוקטורים.")
    seg = man["segment"]
    for s in doc["segments"]:
        if s["id"] == seg["id"]:
            return "installed"
    want = man["db"]["version"]
    if have_db_version is None:
        raise InstallError("המסד של מאגר הספרים לא מותקן באוצריא. התקינו אותו קודם (בתוסף \"הורדת ספרים\"), ואז חזרו לכאן.")
    if have_db_version < want:
        raise InstallError(f"הוקטורים מתאימים למסד גרסה {want}, ואצלכם מותקנת גרסה ישנה יותר ({have_db_version}). "
                           "עדכנו את המסד לגרסה האחרונה.")
    for s, h in zip(doc["segments"], live.headers):
        if is_ours(s):
            raise InstallError("כבר הותקנו אצלכם וקטורים של הגרסה הקודמת. עדכון לגרסה חדשה עדיין לא נתמך בכלי הזה, "
                               "כדי לא לפגוע בסט.")
        if has_repo_books(vdir, s, h):
            raise InstallError("אוצריא כבר מכילה וקטורים לספרי המאגר (כנראה שהוכללו בהתקנה קודמת ואוצריא איחדה אותם). "
                               "אין צורך להתקין שוב.")
    need = sum(e["size"] for e in man["files"]) + man["segment"]["size"] + (512 << 20)
    if free_bytes < need:
        raise InstallError(f"אין מספיק מקום פנוי בדיסק. נדרשים בערך {fmt_bytes(need)}, ופנויים {fmt_bytes(free_bytes)}.")
    return None


# ------------------------------------------------------------------ הורדה ופריסה

def download_file(url, dest, size, sha, progress, cancel, attempts=4):
    """הורדה לקובץ .part ושינוי שם רק כשהגודל וה-sha256 נכונים. השרת לא תומך בהמשך, ולכן כל ניסיון מתחיל מחדש."""
    part = Path(str(dest) + ".part")
    last = None
    for i in range(1, attempts + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "otzaria-vectors-installer"})
            h, n = hashlib.sha256(), 0
            with urllib.request.urlopen(req, timeout=60) as r, open(part, "wb") as out:
                while True:
                    if cancel():
                        raise Cancelled()
                    b = r.read(1 << 20)
                    if not b:
                        break
                    out.write(b)
                    h.update(b)
                    n += len(b)
                    progress(n, size, i)
            if n != size or h.hexdigest() != sha:
                raise InstallError("הקובץ שירד אינו תואם למקור (ייתכן שההורדה נקטעה).")
            os.replace(part, dest)
            return
        except Cancelled:
            part.unlink(missing_ok=True)
            raise
        except (urllib.error.URLError, OSError, InstallError) as e:
            last = e
            part.unlink(missing_ok=True)
            if isinstance(e, urllib.error.HTTPError) and e.code == 404:
                raise InstallError("קובץ הוקטורים לא נמצא בגיטאב (ייתכן שהוא עדיין לא פורסם). נסו שוב מאוחר יותר.")
            time.sleep(3 * i)
    raise InstallError(f"ההורדה נכשלה אחרי {attempts} ניסיונות. בדקו את החיבור ונסו שוב. ({last})")


class _Concat:
    def __init__(self, files):
        self.files, self.i, self.cur = [Path(f) for f in files], 0, None

    def read(self, n=-1):
        n = 8 << 20 if n is None or n < 0 else n
        out = []
        while n > 0:
            if self.cur is None:
                if self.i >= len(self.files):
                    break
                self.cur = open(self.files[self.i], "rb")
                self.i += 1
            b = self.cur.read(n)
            if not b:
                self.cur.close()
                self.cur = None
                continue
            out.append(b)
            n -= len(b)
        return b"".join(out)

    def close(self):
        if self.cur:
            self.cur.close()


def decompress_zst(parts, dst, sha, size, progress, cancel):
    import zstandard
    h, n = hashlib.sha256(), 0
    cat = _Concat(parts)
    try:
        with open(dst, "wb") as out, \
                zstandard.ZstdDecompressor(max_window_size=1 << 31).stream_reader(cat) as r:
            for chunk in iter(lambda: r.read(8 << 20), b""):
                if cancel():
                    raise Cancelled()
                out.write(chunk)
                h.update(chunk)
                n += len(chunk)
                progress(n, size, 1)
    finally:
        cat.close()
    if n != size or h.hexdigest() != sha:
        raise InstallError("הקובץ אחרי הפריסה אינו תואם למקור. ההתקנה נעצרה ושום דבר לא שונה.")


# ------------------------------------------------------------------ הזרימה המלאה

def run(vdir, man, have_db_version, report, cancel=lambda: False, files_dir=None, urlfor=None,
        free_bytes=None, check_running=True, have_lines=None):
    """מריצה את כל ההתקנה. report(שלב, טקסט, שבר 0..1 או None). מחזירה 'installed' או 'done'.
    files_dir: קבצים שכבר ירדו (לבדיקות). urlfor(file) -> כתובת הורדה."""
    vdir = Path(vdir)
    if check_running and otzaria_running():
        raise InstallError("אוצריא פתוחה. סגרו אותה לגמרי ונסו שוב.")
    live = LiveSet(vdir)
    if free_bytes is None:
        free_bytes = shutil.disk_usage(vdir).free
    if check_preconditions(man, live, have_db_version, free_bytes, vdir, have_lines) == "installed":
        return "installed"
    seg = man["segment"]
    work = vdir / "personal-vectors-download"
    work.mkdir(exist_ok=True)
    tmp = vdir / "segments" / "personal-vectors.oxv.tmp"
    tmp.parent.mkdir(exist_ok=True)
    final = vdir / "segments" / f"{seg['id']}.oxv"
    placed = False
    try:
        parts = []
        for e in man["files"]:
            dest = work / e["file"]
            parts.append(dest)
            if files_dir is not None:
                shutil.copyfile(Path(files_dir) / e["file"], dest)
                continue
            if dest.exists() and dest.stat().st_size == e["size"] and sha256_file(dest) == e["sha256"]:
                continue
            report("download", f"מוריד את הוקטורים ({fmt_bytes(e['size'])})...", 0)
            download_file(urlfor(e["file"]), dest, e["size"], e["sha256"],
                          lambda n, t, i: report("download", f"מוריד את הוקטורים: {fmt_bytes(n)} מתוך {fmt_bytes(t)}"
                                                 + (f" (ניסיון {i})" if i > 1 else ""), n / t), cancel)
        report("unpack", "מפרק את הקובץ (כמה דקות)...", 0)
        decompress_zst(parts, tmp, seg["sha256"], seg["size"],
                       lambda n, t, i: report("unpack", f"מפרק: {fmt_bytes(n)} מתוך {fmt_bytes(t)}", n / t), cancel)
        h = read_header(tmp)
        if h["id"].hex() != seg["id"] or h["identity_digest"].hex() != live.doc["identity_digest"] or h["version"] != 3:
            raise InstallError("כותרת הוקטורים אינה תואמת לסט של אוצריא. ההתקנה נעצרה ושום דבר לא שונה.")
        report("register", "רושם את הוקטורים באוצריא...", None)
        lock = SetLock(vdir)
        try:
            live2 = LiveSet(vdir)
            if live2.doc["generation"] != live.doc["generation"]:
                raise InstallError("הסט של אוצריא השתנה בזמן ההתקנה. הריצו שוב.")
            os.replace(tmp, final)
            placed = True
            package = next((p for p in live2.doc["identity"]["model"].get("query_packages", [])
                            if p.get("quantization") == "fp32"), None)
            w = {"id": seg["id"], "slots": h["slots"], "version": live2.doc["library_version"],
                 "sha256": seg["sha256"], "size": seg["size"]}
            publish_generation(live2, w, package, "prebuilt: " + str((man.get("builtBy") or {}).get("runId")))
            placed = False   # נרשם בסט: אסור למחוק
        finally:
            lock.release()
    except BaseException:
        tmp.unlink(missing_ok=True)
        if placed:
            final.unlink(missing_ok=True)   # לא נרשם בסט (CURRENT לא השתנה), אז אין למי הקובץ
        raise
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return "done"


def urlfor_release(man):
    n = man["db"]["version"]
    return lambda f: ASSET_URL.format(n=n, file=urllib.parse.quote(f))
