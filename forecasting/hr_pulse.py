"""
Leave Atlas — HR Pulse Automation
=================================

Reads the employee roster + leave applications from the Google Apps Script
endpoint (or a local JSON dump) and produces a daily HR briefing:

  1. Pending-docs report      → who joined ≥ N days ago but still has gaps
  2. Joiner / leaver pulse    → rolling 30-day & 90-day churn by department
  3. Allocation audit         → employees with custom allocations that drift
                                materially from policy defaults
  4. Termination spike alerts → any department where terminations in the last
                                30 days exceed the trailing 90-day baseline by 2σ
  5. Doc-completeness scoring → roster-wide weighted score (0–100)
  6. Pro-ration suggestions   → mid-year joiners whose customAllocation is null
                                (so the dashboard is currently using auto pro-rate)
                                — useful to ratify with management

Outputs:
  data/hr_pulse.json
  data/hr_pulse_pending_docs.csv
  data/hr_pulse_terminations.csv
  data/hr_pulse_executive_summary.md

The Markdown summary is human-readable and intended for daily Slack/email digest.

Usage:
  python hr_pulse.py --api-url https://script.google.com/macros/s/AKfy.../exec
  python hr_pulse.py --local path/to/dump.json
  python hr_pulse.py            # uses LEAVE_ATLAS_API env var

This script is intentionally dependency-light: requests, pandas, numpy.
"""

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, date
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import requests


# =========================================================
# Config / policy
# =========================================================

POLICY = {
    "Casual":    {"cap": 10,  "paid": True},
    "Sick":      {"cap": 14,  "paid": True},
    "Annual":    {"cap": 20,  "paid": True},
    "Maternity": {"cap": 120, "paid": True},
    "Others":    {"cap": 999, "paid": False},
}

REQUIRED_DOCS = [
    ("nid",           "NID / Birth Cert"),
    ("photo",         "Passport-size photos"),
    ("joiningLetter", "Joining letter"),
    ("contract",      "Appointment / Contract"),
    ("bankAccount",   "Bank account details"),
    ("medical",       "Medical fitness certificate"),
    ("education",     "Educational certificates"),
    ("release",       "Previous employer release"),
    ("serviceBook",   "Service book entry"),
    ("emergency",     "Emergency contact form"),
]

# Critical docs — missing these flags the row as RED even if other docs cover it
CRITICAL_DOCS = {"nid", "contract", "joiningLetter"}

DOC_GRACE_DAYS = 30  # any active employee joined > 30 days ago is expected to be document-complete


# =========================================================
# Data acquisition
# =========================================================

def fetch_remote(api_url: str) -> tuple[pd.DataFrame, pd.DataFrame]:
    def call(action: str) -> list[dict]:
        r = requests.post(api_url, json={"action": action}, timeout=30)
        r.raise_for_status()
        data = r.json()
        if not data.get("ok"):
            raise RuntimeError(f"Apps Script error for {action}: {data.get('error')}")
        return data.get("data", [])

    emp_rows = call("listEmployees")
    app_rows = call("listApps")
    return pd.DataFrame(emp_rows), pd.DataFrame(app_rows)


def load_local(path: str) -> tuple[pd.DataFrame, pd.DataFrame]:
    with open(path, "r", encoding="utf-8") as f:
        blob = json.load(f)
    return pd.DataFrame(blob.get("employees", [])), pd.DataFrame(blob.get("applications", []))


# =========================================================
# Cleaning / normalisation
# =========================================================

def to_dict(val: Any) -> dict:
    """Apps Script may JSON-encode dict cells; restore them."""
    if isinstance(val, dict):
        return val
    if isinstance(val, str) and val.startswith("{"):
        try:
            return json.loads(val)
        except json.JSONDecodeError:
            return {}
    return {}


def parse_date(s: Any) -> date | None:
    if pd.isna(s) or s in (None, ""):
        return None
    if isinstance(s, (datetime, date)):
        return s if isinstance(s, date) else s.date()
    try:
        return datetime.strptime(str(s)[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def normalise_employees(emp: pd.DataFrame) -> pd.DataFrame:
    if emp.empty:
        return emp
    emp = emp.copy()
    emp["docs"] = emp.get("docs", "{}").apply(to_dict)
    emp["customAllocation"] = emp.get("customAllocation", "{}").apply(to_dict)
    emp["status"] = emp.get("status", "Active").fillna("Active")
    emp["doj_d"] = emp.get("doj").apply(parse_date)
    emp["term_d"] = emp.get("terminatedAt").apply(parse_date) if "terminatedAt" in emp else None
    return emp


# =========================================================
# Analyses
# =========================================================

def allocated_cap(emp_row: dict, leave_type: str) -> int:
    """Mirror the dashboard's allocationFor logic."""
    custom = emp_row.get("customAllocation") or {}
    if leave_type in custom and custom[leave_type] not in (None, ""):
        return int(custom[leave_type])
    if leave_type in ("Maternity", "Others"):
        return POLICY[leave_type]["cap"]
    doj = parse_date(emp_row.get("doj"))
    if not doj:
        return POLICY[leave_type]["cap"]
    year = date.today().year
    if doj.year < year:
        return POLICY[leave_type]["cap"]
    if doj.year > year:
        return 0
    months_remaining = 12 - doj.month + 1  # inclusive of join month
    return round(POLICY[leave_type]["cap"] * months_remaining / 12)


def doc_score(docs: dict) -> tuple[int, int, list[str]]:
    have = sum(1 for k, _ in REQUIRED_DOCS if docs.get(k))
    missing_keys = [k for k, _ in REQUIRED_DOCS if not docs.get(k)]
    return have, len(REQUIRED_DOCS), missing_keys


def pending_docs_report(emp: pd.DataFrame) -> pd.DataFrame:
    if emp.empty:
        return pd.DataFrame()
    today = date.today()
    rows = []
    for _, e in emp.iterrows():
        if e.get("status") != "Active":
            continue
        doj = e.get("doj_d")
        days_since_join = (today - doj).days if doj else None
        have, total, missing_keys = doc_score(e["docs"])
        if have >= total:
            continue
        critical_missing = [k for k in missing_keys if k in CRITICAL_DOCS]
        severity = (
            "CRITICAL" if critical_missing and (days_since_join or 0) > DOC_GRACE_DAYS
            else "HIGH"  if (days_since_join or 0) > DOC_GRACE_DAYS
            else "MEDIUM" if (days_since_join or 0) > 7
            else "LOW"
        )
        rows.append({
            "id": e["id"],
            "name": e["name"],
            "department": e.get("department"),
            "designation": e.get("designation"),
            "doj": doj.isoformat() if doj else "",
            "days_since_join": days_since_join,
            "docs_have": have,
            "docs_total": total,
            "missing_critical": ", ".join(critical_missing),
            "missing_all": ", ".join(missing_keys),
            "severity": severity,
        })
    df = pd.DataFrame(rows)
    if not df.empty:
        sev_order = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3}
        df = df.sort_values(by=["severity", "days_since_join"],
                            key=lambda s: s.map(sev_order) if s.name == "severity" else -s)
    return df


def churn_pulse(emp: pd.DataFrame) -> dict:
    if emp.empty:
        return {}
    today = date.today()
    w30 = today - timedelta(days=30)
    w90 = today - timedelta(days=90)
    joined_30 = emp[emp["doj_d"].apply(lambda d: bool(d) and w30 <= d <= today)]
    joined_90 = emp[emp["doj_d"].apply(lambda d: bool(d) and w90 <= d <= today)]
    term_30   = emp[emp["term_d"].apply(lambda d: bool(d) and w30 <= d <= today)] if "term_d" in emp else pd.DataFrame()
    term_90   = emp[emp["term_d"].apply(lambda d: bool(d) and w90 <= d <= today)] if "term_d" in emp else pd.DataFrame()
    headcount = int((emp["status"] == "Active").sum())
    out = {
        "headcount_active": headcount,
        "joined_30d": int(len(joined_30)),
        "joined_90d": int(len(joined_90)),
        "terminated_30d": int(len(term_30)),
        "terminated_90d": int(len(term_90)),
        "net_30d": int(len(joined_30) - len(term_30)),
        "annualised_attrition_pct": round(len(term_90) / max(headcount, 1) * 4 * 100, 1),
    }
    if not term_30.empty:
        out["terminations_by_reason_30d"] = (
            term_30["terminationReason"].fillna("(unspecified)").value_counts().to_dict()
        )
    if not term_30.empty and "department" in term_30:
        out["terminations_by_dept_30d"] = (
            term_30["department"].fillna("(unassigned)").value_counts().to_dict()
        )
    return out


def termination_spike_alerts(emp: pd.DataFrame) -> pd.DataFrame:
    """Departments whose 30-day terminations > μ + 2σ of trailing 90-day baseline (per-department)."""
    if emp.empty or "term_d" not in emp:
        return pd.DataFrame()
    today = date.today()
    last_30 = today - timedelta(days=30)
    last_90 = today - timedelta(days=90)
    term = emp[emp["term_d"].notna()].copy()
    if term.empty:
        return pd.DataFrame()
    term["d"] = term["term_d"]
    # daily counts per dept across the 90-day window
    days = pd.date_range(last_90, today, freq="D").date
    out = []
    for dept, g in term.groupby("department"):
        series = pd.Series(0, index=days, dtype=int)
        counts = g["d"].value_counts()
        for d, n in counts.items():
            if d in series.index:
                series.loc[d] = n
        baseline = series.loc[(series.index >= last_90) & (series.index < last_30)]
        recent = series.loc[(series.index >= last_30)]
        mu, sigma = baseline.mean(), max(baseline.std(), 0.5)
        recent_total = int(recent.sum())
        expected = float(mu * 30)
        if recent_total > expected + 2 * sigma * np.sqrt(30):
            out.append({
                "department": dept,
                "terminations_30d": recent_total,
                "expected_30d": round(expected, 1),
                "z_score": round((recent_total - expected) / (sigma * np.sqrt(30)), 2),
            })
    return pd.DataFrame(out).sort_values("z_score", ascending=False) if out else pd.DataFrame()


def allocation_audit(emp: pd.DataFrame) -> pd.DataFrame:
    """Find employees whose custom allocation differs > 25% from auto pro-rate."""
    if emp.empty:
        return pd.DataFrame()
    rows = []
    for _, e in emp.iterrows():
        if e["status"] != "Active":
            continue
        ca = e.get("customAllocation") or {}
        if not ca:
            continue
        flags = []
        for t in ("Casual", "Sick", "Annual"):
            if t not in ca:
                continue
            auto = allocated_cap({**e.to_dict(), "customAllocation": {}}, t)
            given = int(ca[t])
            if auto > 0 and abs(given - auto) / auto > 0.25:
                flags.append(f"{t}: custom={given} vs auto={auto}")
        if flags:
            rows.append({
                "id": e["id"], "name": e["name"], "department": e.get("department"),
                "doj": e.get("doj"), "drift": "; ".join(flags),
            })
    return pd.DataFrame(rows)


def prorate_suggestions(emp: pd.DataFrame) -> pd.DataFrame:
    """Mid-year joiners using auto pro-rate (no custom) — show what management would be ratifying."""
    if emp.empty:
        return pd.DataFrame()
    rows = []
    year = date.today().year
    for _, e in emp.iterrows():
        if e["status"] != "Active":
            continue
        doj = e.get("doj_d")
        if not doj or doj.year != year:
            continue
        if (e.get("customAllocation") or {}):
            continue
        rows.append({
            "id": e["id"], "name": e["name"], "department": e.get("department"),
            "doj": doj.isoformat(),
            "CL": allocated_cap(e.to_dict(), "Casual"),
            "SL": allocated_cap(e.to_dict(), "Sick"),
            "AL": allocated_cap(e.to_dict(), "Annual"),
        })
    return pd.DataFrame(rows)


# =========================================================
# Executive summary (Markdown)
# =========================================================

def render_summary(pulse: dict, pending: pd.DataFrame, spikes: pd.DataFrame,
                   drift: pd.DataFrame, prorate: pd.DataFrame) -> str:
    today = date.today().isoformat()
    crit = int((pending["severity"] == "CRITICAL").sum()) if not pending.empty else 0
    high = int((pending["severity"] == "HIGH").sum()) if not pending.empty else 0

    lines = []
    lines.append(f"# Leave Atlas — HR Pulse · {today}\n")
    lines.append("## Roster & Churn\n")
    if pulse:
        lines.append(f"- **Active headcount**: {pulse.get('headcount_active', 0)}")
        lines.append(f"- **Joined (30d)**: {pulse.get('joined_30d', 0)}  ·  "
                     f"**Terminated (30d)**: {pulse.get('terminated_30d', 0)}  ·  "
                     f"**Net**: {pulse.get('net_30d', 0):+d}")
        lines.append(f"- **Annualised attrition** (from 90-day window): "
                     f"**{pulse.get('annualised_attrition_pct', 0)}%**")
        if "terminations_by_reason_30d" in pulse:
            reasons = ", ".join(f"{k}: {v}" for k, v in pulse["terminations_by_reason_30d"].items())
            lines.append(f"- Recent separations by reason: {reasons}")
    lines.append("")

    lines.append("## Document Compliance\n")
    if pending.empty:
        lines.append("- Roster is **document-complete**. ✓")
    else:
        lines.append(f"- **{len(pending)} active employees** have document gaps.")
        if crit:
            lines.append(f"  - 🔴 **{crit} CRITICAL** — past grace period, missing critical docs (NID / contract / joining letter)")
        if high:
            lines.append(f"  - 🟠 **{high} HIGH** — past grace period")
        lines.append("- See `hr_pulse_pending_docs.csv` for the full list.")
    lines.append("")

    lines.append("## Termination Spike Alerts\n")
    if spikes.empty:
        lines.append("- No department exceeds its 90-day baseline by ≥ 2σ. ✓")
    else:
        for _, r in spikes.iterrows():
            lines.append(f"- 🚨 **{r['department']}**: {r['terminations_30d']} terminations in 30d "
                         f"(expected {r['expected_30d']}, z = {r['z_score']})")
    lines.append("")

    lines.append("## Allocation Audit\n")
    if drift.empty:
        lines.append("- No custom allocations drift > 25% from policy auto pro-rate. ✓")
    else:
        lines.append(f"- **{len(drift)} employees** have custom allocations diverging materially from policy.")
        for _, r in drift.head(10).iterrows():
            lines.append(f"  - `{r['id']}` {r['name']} ({r['department']}) — {r['drift']}")
        if len(drift) > 10:
            lines.append(f"  - … and {len(drift) - 10} more.")
    lines.append("")

    lines.append("## Pro-Ration Ratification (this year's joiners)\n")
    if prorate.empty:
        lines.append("- No new mid-year joiners awaiting ratification.")
    else:
        lines.append(f"- **{len(prorate)} joiners** currently using auto pro-rate. "
                     "Recommended to ratify with management:")
        for _, r in prorate.head(8).iterrows():
            lines.append(f"  - `{r['id']}` {r['name']} ({r['department']}, DOJ {r['doj']}) "
                         f"→ CL {r['CL']} · SL {r['SL']} · AL {r['AL']}")
        if len(prorate) > 8:
            lines.append(f"  - … and {len(prorate) - 8} more — see `hr_pulse.json`.")
    lines.append("")
    lines.append("---")
    lines.append("_Generated by `hr_pulse.py` · Leave Atlas automation_")
    return "\n".join(lines)


# =========================================================
# CLI
# =========================================================

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api-url", default=os.environ.get("LEAVE_ATLAS_API"),
                    help="Apps Script /exec URL")
    ap.add_argument("--local", help="Path to local JSON dump {employees:[...],applications:[...]}")
    ap.add_argument("--out", default="data", help="Output directory")
    args = ap.parse_args()

    if not args.api_url and not args.local:
        print("ERROR: provide --api-url or --local or set LEAVE_ATLAS_API env var.", file=sys.stderr)
        return 2

    if args.local:
        emp, apps = load_local(args.local)
    else:
        emp, apps = fetch_remote(args.api_url)

    emp = normalise_employees(emp)

    pulse   = churn_pulse(emp)
    pending = pending_docs_report(emp)
    spikes  = termination_spike_alerts(emp)
    drift   = allocation_audit(emp)
    prorate = prorate_suggestions(emp)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    summary_md = render_summary(pulse, pending, spikes, drift, prorate)

    (out / "hr_pulse.json").write_text(json.dumps({
        "generated_at": datetime.now().isoformat() + "Z",
        "pulse": pulse,
        "termination_spikes": spikes.to_dict("records") if not spikes.empty else [],
        "allocation_drift": drift.to_dict("records") if not drift.empty else [],
        "prorate_suggestions": prorate.to_dict("records") if not prorate.empty else [],
        "pending_docs_count": int(len(pending)),
    }, indent=2), encoding="utf-8")

    if not pending.empty:
        pending.to_csv(out / "hr_pulse_pending_docs.csv", index=False)
    if not spikes.empty:
        spikes.to_csv(out / "hr_pulse_terminations.csv", index=False)
    (out / "hr_pulse_executive_summary.md").write_text(summary_md, encoding="utf-8")

    print(summary_md)
    print("\n→ wrote outputs to", out.resolve())
    return 0


if __name__ == "__main__":
    sys.exit(main())
