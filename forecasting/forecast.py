"""
=========================================================================
Leave Atlas — Forecasting Pipeline
=========================================================================
Pulls historical leave applications from the Google Sheets backend
(via the Apps Script web app), produces predictions for:

  1.  30-day absenteeism (per-day expected count)
  2.  Monthly seasonal index (which months are spikiest)
  3.  Festival pressure (Eid, Pohela Boishakh, Durga Puja, Victory Day)
  4.  Department-level production risk (peak gap in next 30 days)

Outputs:
  - data/forecast.json     — consumed by the dashboard for the Forecast tab
                             when the dashboard is set to remote mode
  - data/forecast.csv      — flat per-day forecast
  - data/department_risk.csv

Usage:
    python forecast.py --api-url https://script.google.com/macros/s/.../exec
or with env:
    export LEAVE_ATLAS_API=https://...
    python forecast.py

This script intentionally uses pure-Python + pandas + numpy so it runs
on any GitHub Action runner without GPU / heavy ML dependencies. The
algorithms used are robust statistical baselines, not deep learning;
they are well-suited to leave data which is dominated by calendar
seasonality rather than long-tail features.
=========================================================================
"""

from __future__ import annotations
import argparse
import json
import os
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import requests


# ---------------------------------------------------------------------
# 1. Calendar / holiday config (mirrors the dashboard)
# ---------------------------------------------------------------------
HOLIDAYS_BD = [
    ("2026-02-21", "International Mother Language Day"),
    ("2026-03-17", "Birthday of Sheikh Mujib"),
    ("2026-03-19", "Shab-e-Qadr"),
    ("2026-03-20", "Eid-ul-Fitr"),
    ("2026-03-21", "Eid-ul-Fitr"),
    ("2026-03-22", "Eid-ul-Fitr"),
    ("2026-03-26", "Independence Day"),
    ("2026-04-14", "Pohela Boishakh"),
    ("2026-05-01", "May Day"),
    ("2026-05-25", "Buddha Purnima"),
    ("2026-05-27", "Eid-ul-Adha"),
    ("2026-05-28", "Eid-ul-Adha"),
    ("2026-05-29", "Eid-ul-Adha"),
    ("2026-08-15", "National Mourning Day"),
    ("2026-10-20", "Durga Puja"),
    ("2026-12-16", "Victory Day"),
    ("2026-12-25", "Christmas Day"),
]
HOLIDAY_DATES = {h[0] for h in HOLIDAYS_BD}
WEEK_OFF = 4  # Friday in Python's weekday() (0=Mon)

FESTIVAL_KEYS = {
    "Eid-ul-Fitr":      "Eid-ul-Fitr",
    "Eid-ul-Adha":      "Eid-ul-Adha",
    "Pohela Boishakh":  "Pohela Boishakh",
    "Durga Puja":       "Durga Puja",
    "Victory Day":      "Victory Day",
}


# ---------------------------------------------------------------------
# 2. Data fetch
# ---------------------------------------------------------------------
def fetch_applications(api_url: str) -> pd.DataFrame:
    r = requests.post(api_url, data=json.dumps({"action": "listApps"}),
                      headers={"Content-Type": "text/plain;charset=utf-8"},
                      timeout=30)
    r.raise_for_status()
    rows = r.json().get("data", [])
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    for c in ("start", "end", "appliedAt", "decidedAt", "counseledAt"):
        if c in df.columns:
            df[c] = pd.to_datetime(df[c], errors="coerce")
    for c in ("days", "paid", "unpaid", "holidays"):
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors="coerce").fillna(0).astype(int)
    return df


def fetch_employees(api_url: str) -> pd.DataFrame:
    r = requests.post(api_url, data=json.dumps({"action": "listEmployees"}),
                      headers={"Content-Type": "text/plain;charset=utf-8"},
                      timeout=30)
    r.raise_for_status()
    rows = r.json().get("data", [])
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------
# 3. Forecast models
# ---------------------------------------------------------------------
def absenteeism_30d(apps: pd.DataFrame) -> pd.DataFrame:
    """
    For each of the next 30 days produce:
      pipeline  = currently approved or pending leaves overlapping that day
      baseline  = historical weekday average + festival surge bump
    """
    today = pd.Timestamp(date.today())
    horizon = [today + pd.Timedelta(days=i) for i in range(30)]
    out = []

    # historical weekday baseline from approved leaves in past 180 days
    if not apps.empty:
        hist = apps[(apps["status"] == "Approved") &
                    (apps["start"] >= today - pd.Timedelta(days=180))].copy()
        # expand each leave into its constituent dates
        date_rows = []
        for _, r in hist.iterrows():
            cur = r["start"]
            while cur <= r["end"]:
                date_rows.append(cur.date())
                cur += pd.Timedelta(days=1)
        if date_rows:
            s = pd.Series(date_rows).value_counts()
            df_d = pd.DataFrame({"d": pd.to_datetime(s.index), "n": s.values})
            df_d["wd"] = df_d["d"].dt.weekday
            wd_base = df_d.groupby("wd")["n"].mean().reindex(range(7)).fillna(3.0)
        else:
            wd_base = pd.Series([3.0] * 7, index=range(7))
    else:
        wd_base = pd.Series([3.0] * 7, index=range(7))

    pipeline_apps = apps[apps["status"].isin(["Approved", "Pending"])] if not apps.empty else apps

    for d in horizon:
        ds = d.strftime("%Y-%m-%d")
        # pipeline overlap
        if not apps.empty:
            mask = (pipeline_apps["start"] <= d) & (pipeline_apps["end"] >= d)
            pipeline = int(mask.sum())
        else:
            pipeline = 0
        # baseline
        wd = d.weekday()
        base = float(wd_base.get(wd, 3.0))
        # festival surge: ±2 days around any holiday → +50%
        for off in range(-2, 3):
            if (d + pd.Timedelta(days=off)).strftime("%Y-%m-%d") in HOLIDAY_DATES:
                base *= 1.5
                break
        out.append({"date": ds, "weekday": d.day_name(),
                    "pipeline": pipeline, "baseline": round(base, 1)})
    return pd.DataFrame(out)


def monthly_seasonality(apps: pd.DataFrame) -> pd.DataFrame:
    if apps.empty:
        return pd.DataFrame({"month": range(1, 13), "days": [0]*12, "index": [1.0]*12})
    a = apps[apps["status"] == "Approved"].copy()
    a["m"] = a["start"].dt.month
    by_m = a.groupby("m")["days"].sum().reindex(range(1, 13)).fillna(0)
    avg = by_m.mean() or 1.0
    return pd.DataFrame({
        "month": range(1, 13),
        "days":  by_m.values.astype(int),
        "index": np.round(by_m.values / avg, 2)
    })


def festival_pressure(apps: pd.DataFrame, employees: pd.DataFrame, year: int) -> list[dict]:
    out = []
    workforce = max(1, len(employees))
    for name, key in FESTIVAL_KEYS.items():
        dates = [h[0] for h in HOLIDAYS_BD if key in h[1] and h[0].startswith(str(year))]
        if not dates:
            continue
        first = pd.Timestamp(dates[0])
        last  = pd.Timestamp(dates[-1])
        win_a = first - pd.Timedelta(days=5)
        win_b = last  + pd.Timedelta(days=5)
        if apps.empty:
            involved = 0
        else:
            m = (apps["status"] != "Declined") & (apps["start"] <= win_b) & (apps["end"] >= win_a)
            involved = int(m.sum())
        out.append({
            "festival":  name,
            "first":     dates[0],
            "last":      dates[-1],
            "involved":  involved,
            "pct":       round(involved / workforce * 100, 1)
        })
    return out


def department_risk(apps: pd.DataFrame, employees: pd.DataFrame) -> pd.DataFrame:
    if employees.empty:
        return pd.DataFrame(columns=["department", "headcount", "peak_on_leave", "peak_pct"])
    today = pd.Timestamp(date.today())
    out = []
    if not apps.empty:
        pipeline = apps[apps["status"].isin(["Approved", "Pending"])].copy()
    else:
        pipeline = pd.DataFrame()

    for dep, grp in employees.groupby("department"):
        head = len(grp)
        peak = 0
        if not pipeline.empty:
            ids = set(grp["id"])
            sub = pipeline[pipeline["empId"].isin(ids)]
            for i in range(30):
                d = today + pd.Timedelta(days=i)
                on = int(((sub["start"] <= d) & (sub["end"] >= d)).sum())
                if on > peak:
                    peak = on
        out.append({
            "department":   dep,
            "headcount":    head,
            "peak_on_leave": peak,
            "peak_pct":     round(peak / head * 100, 1) if head else 0
        })
    return pd.DataFrame(out).sort_values("peak_pct", ascending=False)


# ---------------------------------------------------------------------
# 4. Main
# ---------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api-url", default=os.environ.get("LEAVE_ATLAS_API", ""))
    ap.add_argument("--out-dir", default="data")
    args = ap.parse_args()

    if not args.api_url:
        print("ERROR: provide --api-url or set LEAVE_ATLAS_API", file=sys.stderr)
        sys.exit(2)

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    print("→ Fetching applications…")
    apps = fetch_applications(args.api_url)
    print(f"  loaded {len(apps)} applications")

    print("→ Fetching employees…")
    emps = fetch_employees(args.api_url)
    print(f"  loaded {len(emps)} employees")

    print("→ Computing 30-day absenteeism forecast…")
    absent_df = absenteeism_30d(apps)

    print("→ Computing monthly seasonality index…")
    season_df = monthly_seasonality(apps)

    print("→ Computing festival pressure…")
    fest = festival_pressure(apps, emps, date.today().year)

    print("→ Computing department risk…")
    risk_df = department_risk(apps, emps)

    # write outputs
    bundle = {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "absenteeism_30d": absent_df.to_dict(orient="records"),
        "monthly_seasonality": season_df.to_dict(orient="records"),
        "festival_pressure": fest,
        "department_risk": risk_df.to_dict(orient="records"),
    }
    (out_dir / "forecast.json").write_text(json.dumps(bundle, indent=2))
    absent_df.to_csv(out_dir / "forecast.csv", index=False)
    risk_df.to_csv(out_dir / "department_risk.csv", index=False)
    print(f"✓ Wrote {out_dir}/forecast.json (+ csv siblings)")


if __name__ == "__main__":
    main()
