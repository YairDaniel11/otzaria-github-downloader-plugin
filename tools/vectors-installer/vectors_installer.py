# -*- coding: utf-8 -*-
"""התקנת וקטורי חיפוש-לפי-משמעות של "מאגר ספרים לא רשמי" באוצריא. חלון אחד, כפתור אחד.

הרצה רגילה: לחיצה כפולה על הקובץ (ה-exe). בלי פרמטרים.
למפתחים: --cli (בלי חלון), --check (בדיקות בלבד, בלי הורדה והתקנה), --vectors-dir <תיקייה>.
"""
import argparse
import queue
import sys
import threading
import traceback

import vectors_core as core

TITLE = "התקנת וקטורי חיפוש לפי משמעות"
INTRO = ("הכלי מוסיף לאוצריא את הוקטורים של ספרי \"מאגר ספרים לא רשמי\", כדי שיופיעו בחיפוש לפי משמעות.\n\n"
         "לפני שמתחילים:\n"
         "1. סגרו את אוצריא לגמרי.\n"
         "2. ודאו שהמסד של מאגר הספרים מותקן באוצריא, בגרסה האחרונה.\n"
         "3. ודאו שיש בדיסק כ-3 GB פנויים.\n\n"
         "ההורדה גדולה (כ-1.1 GB) וההתקנה לוקחת כמה דקות. אפשר להשאיר את החלון פתוח ולהמשיך בעבודה.")
CREDIT = "הוקטורים נוצרו לפי המודל של פרויקט אוצריא (otzaria.org)."


def prepare(vectors_dir=None):
    """בדיקות ללא הורדה: מאתרת, מאמתת חתימה ובודקת התאמה. מחזירה (vdir, man, have_db) או זורקת InstallError."""
    loc = core.locate()
    vdir = vectors_dir or loc["vectors"]
    if not vdir:
        raise core.InstallError("לא נמצאה תיקיית הוקטורים של אוצריא.")
    man = core.fetch_manifest()
    return vdir, man, core.installed_db_version(loc["attached"], man["db"]["slug"]), core.installed_db_lines(loc["attached"], man["db"]["slug"])


def run_cli(args):
    def report(stage, text, frac):
        print(f"\r{text}" + (f" {frac:.0%}" if frac is not None else "") + " " * 10, end="", flush=True)
    try:
        vdir, man, have, lines = prepare(args.vectors_dir)
        if args.check:
            live = core.LiveSet(vdir)
            r = core.check_preconditions(man, live, have, core.shutil.disk_usage(vdir).free, vdir, lines)
            print("כבר מותקן." if r == "installed" else "אפשר להתקין.")
            return 0
        r = core.run(vdir, man, have, report, urlfor=core.urlfor_release(man), have_lines=lines)
        print("\n" + ("הוקטורים כבר מותקנים." if r == "installed" else "ההתקנה הסתיימה. הפעילו את אוצריא."))
        return 0
    except core.InstallError as e:
        print("\nשגיאה:", e)
        return 2


def run_gui():
    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk

    root = tk.Tk()
    root.title(TITLE)
    root.geometry("560x480")
    font = ("Segoe UI", 11)
    q = queue.Queue()
    state = {"cancel": False, "busy": False}

    def label(text, **kw):
        kw.setdefault("font", font)
        return tk.Label(root, text=text, justify="right", anchor="e", wraplength=520, **kw)

    label(TITLE, font=("Segoe UI", 15, "bold")).pack(fill="x", padx=20, pady=(16, 6))
    label(INTRO).pack(fill="x", padx=20)
    status = tk.StringVar(value="")
    stat_lbl = tk.Label(root, textvariable=status, font=font, justify="right", anchor="e", wraplength=520, fg="#1a5fb4")
    stat_lbl.pack(fill="x", padx=20, pady=(14, 4))
    bar = ttk.Progressbar(root, length=520, mode="determinate", maximum=1000)
    bar.pack(padx=20, pady=4)
    btn = tk.Button(root, text="התקן את הוקטורים", font=("Segoe UI", 13, "bold"), bg="#2e7d32", fg="white", padx=20, pady=8)
    btn.pack(pady=(12, 4))
    cancel_btn = tk.Button(root, text="ביטול", font=font, state="disabled")
    cancel_btn.pack()
    label(CREDIT, fg="#555").pack(fill="x", padx=20, pady=(10, 0))

    def worker(vdir):
        try:
            q.put(("status", "בודק התאמה ומוריד את פרטי הוקטורים מגיטאב...", None))
            loc = core.locate()
            man = core.fetch_manifest()
            have = core.installed_db_version(loc["attached"], man["db"]["slug"])
            lines = core.installed_db_lines(loc["attached"], man["db"]["slug"])
            r = core.run(vdir, man, have, lambda s, t, f: q.put(("status", t, f)),
                         cancel=lambda: state["cancel"], urlfor=core.urlfor_release(man), have_lines=lines)
            q.put(("done", r, None))
        except core.Cancelled:
            q.put(("error", "ההתקנה בוטלה. שום דבר באוצריא לא שונה.", None))
        except core.InstallError as e:
            q.put(("error", str(e), None))
        except Exception as e:   # תקלה לא צפויה: הסבר פשוט, והפרטים לדיווח
            q.put(("error", "אירעה תקלה לא צפויה. שום דבר באוצריא לא שונה כל עוד ההתקנה לא הסתיימה.\n\n"
                            + "".join(traceback.format_exception_only(type(e), e)).strip(), None))

    def poll():
        try:
            while True:
                kind, text, frac = q.get_nowait()
                if kind == "status":
                    status.set(text)
                    stat_lbl.config(fg="#1a5fb4")
                    if frac is not None:
                        bar["value"] = frac * 1000
                elif kind == "done":
                    finish()
                    if text == "installed":
                        status.set("הוקטורים כבר מותקנים. אין צורך לעשות דבר.")
                        messagebox.showinfo(TITLE, "הוקטורים כבר מותקנים באוצריא.")
                    else:
                        bar["value"] = 1000
                        status.set("ההתקנה הסתיימה בהצלחה.")
                        messagebox.showinfo(TITLE, "ההתקנה הסתיימה בהצלחה.\n\nהפעילו את אוצריא. היא תשתמש בוקטורים "
                                                   "בהפעלה הזו, ובחיפוש לפי משמעות יופיעו גם ספרי המאגר.\n\n" + CREDIT)
                elif kind == "error":
                    finish()
                    status.set(text)
                    stat_lbl.config(fg="#b00020")
        except queue.Empty:
            pass
        root.after(200, poll)

    def finish():
        state["busy"] = False
        btn.config(state="normal", text="נסה שוב")
        cancel_btn.config(state="disabled")

    def start():
        if state["busy"]:
            return
        loc = core.locate()
        vdir = loc["vectors"]
        if not vdir:
            messagebox.showinfo(TITLE, "לא מצאתי את תיקיית הוקטורים של אוצריא בעצמי.\n"
                                       "בחרו את התיקייה בשם vectors (לרוב ב-C:\\ProgramData\\otzaria).")
            chosen = filedialog.askdirectory(title="בחרו את תיקיית vectors של אוצריא")
            if not chosen:
                return
            vdir = chosen
        if core.otzaria_running():
            status.set("אוצריא פתוחה. סגרו אותה לגמרי ולחצו שוב.")
            stat_lbl.config(fg="#b00020")
            return
        state.update(cancel=False, busy=True)
        btn.config(state="disabled")
        cancel_btn.config(state="normal")
        bar["value"] = 0
        threading.Thread(target=worker, args=(vdir,), daemon=True).start()

    def cancel():
        state["cancel"] = True
        status.set("מבטל...")

    btn.config(command=start)
    cancel_btn.config(command=cancel)
    root.after(200, poll)
    root.mainloop()


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--cli", action="store_true")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--vectors-dir")
    a = ap.parse_args()
    if a.cli or a.check:
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
        return run_cli(a)
    run_gui()
    return 0


if __name__ == "__main__":
    sys.exit(main())
