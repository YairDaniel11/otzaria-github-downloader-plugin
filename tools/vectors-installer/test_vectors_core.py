# -*- coding: utf-8 -*-
"""בדיקות ל-vectors_core על סט סינתטי (קבצים קטנים בפורמט האמיתי של הכותרת). הרצה: python -m unittest -v
בתיקייה הזו. אין רשת ואין אוצריא."""
import base64
import hashlib
import json
import shutil
import struct
import tempfile
import unittest
import zlib
from pathlib import Path

import zstandard
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

import vectors_core as core

IDENT = "ab" * 32
PARAMS = "cd" * 32
BASE_ID = "11" * 16
NEW_ID = "22" * 16


def header(seg_id, ident=IDENT, slots=100, names=None, version=3):
    h = bytearray(4096)
    h[:8] = core.MAGIC
    nsec = 1 if names is not None else 0
    struct.pack_into("<IIIHHII", h, 8, version, 4096, 0, 256, 0, 1 << 20, nsec)
    h[32:48] = bytes.fromhex(seg_id)
    h[48:80] = bytes.fromhex(ident)
    h[80:112] = bytes.fromhex(PARAMS)
    struct.pack_into("<4Q", h, 112, slots, 0, 0, 0)
    if names is not None:
        struct.pack_into("<HHIQQQI", h, 224, core.BOOK_NAMES, 0, 1, 4096, len(names), 1, 0)
    struct.pack_into("<I", h, 4088, zlib.crc32(bytes(h[:4088])) & 0xFFFFFFFF)
    return bytes(h) + (names or b"")


def make_set(vdir, extra_segments=(), identity=IDENT):
    """סט עם דור 1: מקטע בסיס אחד (+ מקטעים נוספים כ-(id, header_bytes, backend))."""
    vdir = Path(vdir)
    (vdir / "segments").mkdir(parents=True)
    gdir = vdir / "gen-000001"
    gdir.mkdir()
    segs = []
    for sid, hb, backend in [(BASE_ID, header(BASE_ID, identity, 50), None)] + list(extra_segments):
        (vdir / "segments" / f"{sid}.oxv").write_bytes(hb)
        (gdir / f"{sid}.del").write_bytes(b"DEL" + sid.encode())
        (gdir / f"{sid}.links").write_bytes(b"LNK" + sid.encode())
        s = {"id": sid, "file": f"segments/{sid}.oxv", "kind": "base", "slots": 50, "size": len(hb),
             "sha256": hashlib.sha256(hb).hexdigest(),
             "del": {"file": f"{sid}.del", "crc32": 0, "count": 0},
             "links": {"file": f"{sid}.links", "crc32": 0, "count": 0}}
        if backend:
            s["provenance"] = {"worker": {"backend": backend}}
        segs.append(s)
    doc = {"generation": 1, "library_version": 38, "identity_digest": identity, "codec_params_sha256": PARAMS,
           "identity": {"model": {"query_packages": [{"quantization": "fp32", "id": "q"}]}},
           "segments": segs, "stats": {}, "created_at": "x"}
    raw = json.dumps(doc).encode()
    (gdir / "set.json").write_bytes(raw)
    ptr = {"generation": 1, "set": "gen-000001/set.json", "set_sha256": hashlib.sha256(raw).hexdigest()}
    (vdir / "CURRENT").write_text(json.dumps(ptr))
    return vdir


def make_package(tmp, seg_bytes=None, db_version=7):
    """קובץ zst + מניפסט תואם. מחזירה (manifest dict, files_dir)."""
    seg_bytes = seg_bytes or header(NEW_ID, slots=1000) + b"\0" * 5000
    files = Path(tmp) / "files"
    files.mkdir()
    z = zstandard.ZstdCompressor().compress(seg_bytes)
    name = "personal-vectors-abc.oxv.zst"
    (files / name).write_bytes(z)
    man = {"kind": "supplement", "compression": "zstd", "identityDigest": IDENT, "codecParamsSha256": PARAMS,
           "segment": {"id": NEW_ID, "sha256": hashlib.sha256(seg_bytes).hexdigest(), "size": len(seg_bytes),
                       "slots": 1000, "books": 3},
           "files": [{"file": name, "size": len(z), "sha256": hashlib.sha256(z).hexdigest()}],
           "db": {"version": db_version, "slug": core.SLUG}, "builtBy": {"runId": "1"}}
    return man, files


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="vi-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.vdir = self.tmp / "vectors"

    def install(self, man, files, have=7, **kw):
        return core.run(self.vdir, man, have, lambda *a: None, files_dir=files, check_running=False, **kw)

    def current(self):
        return (self.vdir / "CURRENT").read_bytes()


class Happy(Base):
    def test_install_creates_generation(self):
        make_set(self.vdir)
        man, files = make_package(self.tmp)
        old = self.current()
        self.assertEqual(self.install(man, files), "done")
        ptr = json.loads(self.current())
        self.assertEqual(ptr["generation"], 2)
        self.assertEqual((self.vdir / "PREVIOUS").read_bytes(), old)
        raw = (self.vdir / ptr["set"]).read_bytes()
        self.assertEqual(hashlib.sha256(raw).hexdigest(), ptr["set_sha256"])
        doc = json.loads(raw)
        self.assertEqual([s["id"] for s in doc["segments"]], [BASE_ID, NEW_ID])
        new = doc["segments"][-1]
        self.assertTrue(new["provenance"]["worker"]["backend"].startswith("otzaria-personal-vectors"))
        self.assertEqual((new["from"], new["to"]), (38, 38))
        self.assertEqual(doc["stats"]["slots"], 50 + 1000)
        g = self.vdir / "gen-000002"
        self.assertTrue((g / f"{BASE_ID}.del").exists() and (g / f"{NEW_ID}.del").exists())
        self.assertTrue((self.vdir / "segments" / f"{NEW_ID}.oxv").exists())
        self.assertFalse((self.vdir / "personal-vectors-download").exists())
        self.assertFalse((self.vdir / "segments" / "personal-vectors.oxv.tmp").exists())
        # הסט החדש נקרא תקין, והתקנה חוזרת מזהה "כבר מותקן"
        self.assertEqual(self.install(man, files), "installed")
        self.assertEqual(json.loads(self.current())["generation"], 2)

    def test_generation_number_skips_leftover_dirs(self):
        make_set(self.vdir)
        (self.vdir / "gen-000005").mkdir()
        man, files = make_package(self.tmp)
        self.install(man, files)
        self.assertEqual(json.loads(self.current())["generation"], 6)


class Refusals(Base):
    def refuse(self, man, files, have=7, contains=""):
        old = self.current()
        with self.assertRaises(core.InstallError) as cm:
            self.install(man, files, have=have)
        self.assertIn(contains, str(cm.exception))
        self.assertEqual(self.current(), old)
        self.assertFalse((self.vdir / "gen-000002").exists())
        self.assertFalse((self.vdir / "segments" / f"{NEW_ID}.oxv").exists())

    def test_db_version_mismatch(self):
        make_set(self.vdir)
        man, files = make_package(self.tmp, db_version=8)
        self.refuse(man, files, have=7, contains="גרסה 8")

    def test_db_missing(self):
        make_set(self.vdir)
        man, files = make_package(self.tmp)
        self.refuse(man, files, have=None, contains="לא מותקן")

    def test_model_mismatch(self):
        make_set(self.vdir, identity="ee" * 32)
        man, files = make_package(self.tmp)
        self.refuse(man, files, contains="מודל")

    def test_repo_books_already_in_compacted_segment(self):
        names = b"xx db:otzarya-unofficial-books:123 yy"
        make_set(self.vdir, [("33" * 16, header("33" * 16, names=names), None)])
        man, files = make_package(self.tmp)
        self.refuse(man, files, contains="כבר מכילה")

    def test_other_books_do_not_block(self):
        make_set(self.vdir, [("33" * 16, header("33" * 16, names=b"db:someone-else:1"), None)])
        man, files = make_package(self.tmp)
        self.assertEqual(self.install(man, files), "done")

    def test_previous_ours_segment_refused(self):
        make_set(self.vdir, [("33" * 16, header("33" * 16), "otzaria-personal-vectors 1.0")])
        man, files = make_package(self.tmp)
        self.refuse(man, files, contains="עדכון")

    def test_low_disk(self):
        make_set(self.vdir)
        man, files = make_package(self.tmp)
        old = self.current()
        with self.assertRaises(core.InstallError) as cm:
            self.install(man, files, free_bytes=1000)
        self.assertIn("מקום פנוי", str(cm.exception))
        self.assertEqual(self.current(), old)

    def test_otzaria_running_blocks(self):
        make_set(self.vdir)
        man, files = make_package(self.tmp)
        orig = core.otzaria_running
        core.otzaria_running = lambda: True
        self.addCleanup(setattr, core, "otzaria_running", orig)
        with self.assertRaises(core.InstallError):
            core.run(self.vdir, man, 7, lambda *a: None, files_dir=files)

    def test_corrupt_current_refused(self):
        make_set(self.vdir)
        (self.vdir / "gen-000001" / "set.json").write_bytes(b"{}")
        man, files = make_package(self.tmp)
        with self.assertRaises(core.InstallError):
            self.install(man, files)


class Failures(Base):
    def assert_untouched(self, old):
        self.assertEqual(self.current(), old)
        self.assertFalse((self.vdir / "gen-000002").exists())
        self.assertFalse((self.vdir / "segments" / f"{NEW_ID}.oxv").exists())
        self.assertFalse((self.vdir / "segments" / "personal-vectors.oxv.tmp").exists())
        self.assertFalse((self.vdir / "personal-vectors-download").exists())

    def test_wrong_segment_hash(self):
        make_set(self.vdir)
        man, files = make_package(self.tmp)
        man["segment"]["sha256"] = "0" * 64
        old = self.current()
        with self.assertRaises(core.InstallError):
            self.install(man, files)
        self.assert_untouched(old)

    def test_header_id_mismatch(self):
        make_set(self.vdir)
        man, files = make_package(self.tmp, seg_bytes=header("44" * 16, slots=10) + b"\0" * 100)
        old = self.current()
        with self.assertRaises(core.InstallError):
            self.install(man, files)
        self.assert_untouched(old)

    def test_crash_while_writing_current(self):
        make_set(self.vdir)
        man, files = make_package(self.tmp)
        old = self.current()
        orig = core.write_durable

        def boom(path, data):
            if Path(path).name == "CURRENT":
                raise OSError("disk full")
            return orig(path, data)
        core.write_durable = boom
        self.addCleanup(setattr, core, "write_durable", orig)
        with self.assertRaises(OSError):
            self.install(man, files)
        self.assert_untouched(old)

    def test_cancel(self):
        make_set(self.vdir)
        man, files = make_package(self.tmp)
        old = self.current()
        with self.assertRaises(core.Cancelled):
            self.install(man, files, cancel=lambda: True)
        self.assert_untouched(old)

    def test_download_retries_then_fails_cleanly(self):
        make_set(self.vdir)
        man, _ = make_package(self.tmp)
        old = self.current()
        orig_sleep = core.time.sleep
        core.time.sleep = lambda s: None
        self.addCleanup(setattr, core.time, "sleep", orig_sleep)
        with self.assertRaises(core.InstallError):
            core.run(self.vdir, man, 7, lambda *a: None, check_running=False,
                     urlfor=lambda f: "http://127.0.0.1:9/nope")
        self.assert_untouched(old)


class Signature(unittest.TestCase):
    def setUp(self):
        self.key = Ed25519PrivateKey.generate()
        self.pub = base64.b64encode(self.key.public_key().public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode()

    def test_valid_and_tampered(self):
        msg = b'{"a":1}'
        sig = base64.b64encode(self.key.sign(msg)) + b"\n"
        self.assertTrue(core.verify_signature(msg, sig, self.pub))
        self.assertFalse(core.verify_signature(msg + b" ", sig, self.pub))
        self.assertFalse(core.verify_signature(msg, b"garbage", self.pub))
        self.assertFalse(core.verify_signature(msg, b"", self.pub))
        other = Ed25519PrivateKey.generate()
        self.assertFalse(core.verify_signature(msg, base64.b64encode(other.sign(msg)), self.pub))

    def test_pinned_key_is_valid_ed25519(self):
        self.assertEqual(len(base64.b64decode(core.PUBLIC_KEY_B64)), 32)
        self.assertFalse(core.verify_signature(b"x", base64.b64encode(b"\0" * 64)))

    def test_fetch_manifest_rejects_bad_signature(self):
        man, _ = make_package(tempfile.mkdtemp())
        raw = json.dumps(man).encode()
        with self.assertRaises(core.InstallError) as cm:
            core.fetch_manifest(get=lambda url: raw if url.endswith(".json") else b"AAAA")
        self.assertIn("חתימה", str(cm.exception))

    def test_parse_manifest_rejects_unsafe_file_name(self):
        man, _ = make_package(tempfile.mkdtemp())
        man["files"][0]["file"] = "../evil.zst"
        with self.assertRaises(core.InstallError):
            core.parse_manifest(json.dumps(man).encode())
        man["files"][0]["file"] = "ok.zst"
        man["kind"] = "base"
        with self.assertRaises(core.InstallError):
            core.parse_manifest(json.dumps(man).encode())


class Gui(unittest.TestCase):
    def test_window_builds(self):
        """בונה את החלון באמת (בלי mainloop) כדי לתפוס שגיאות בבניית הממשק."""
        import tkinter as tk
        import vectors_installer
        try:
            probe = tk.Tk()
            probe.destroy()
        except tk.TclError:
            self.skipTest("אין תצוגה")
        orig = tk.Tk.mainloop
        tk.Tk.mainloop = lambda self, n=0: self.destroy()
        self.addCleanup(setattr, tk.Tk, "mainloop", orig)
        vectors_installer.run_gui()


if __name__ == "__main__":
    unittest.main()
