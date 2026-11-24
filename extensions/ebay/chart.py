"""Draws eBay sold prices over time, by condition: python3 chart.py <out.png>, the points as JSON on stdin.
Run by ebay.py's draw_chart with the venv run.sh makes, which has matplotlib."""

import datetime
import json
import statistics
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.dates as mdates  # noqa: E402
import matplotlib.pyplot as plt  # noqa: E402

COLORS = {"new": "#1a7f37", "open_box": "#0969da", "used": "#8250df", "refurbished": "#bf8700", "parts": "#cf222e"}

data = json.load(sys.stdin)
fig, ax = plt.subplots(figsize=(9, 4.6), dpi=150)
for bucket, color in COLORS.items():
    pts = [p for p in data["points"] if p["b"] == bucket]
    if not pts:
        continue
    median = statistics.median(p["p"] for p in pts)
    label = f"{data['labels'][bucket]}: {len(pts)} sold, median ${median:,.0f}"
    for offer in (False, True):
        group = [p for p in pts if p["o"] == offer]
        if group:
            ax.scatter([datetime.date.fromisoformat(p["d"]) for p in group], [p["p"] for p in group], s=36, color=color,
                       alpha=0.85, marker="v" if offer else "o", label=None if offer else label, edgecolors="white", linewidths=0.6)
    if not any(not p["o"] for p in pts):
        ax.scatter([], [], color=color, label=label)
    ax.axhline(median, color=color, alpha=0.35, linewidth=1.2, linestyle="--")
ax.set_title(data["title"], loc="left", fontsize=12, fontweight="bold")
ax.yaxis.set_major_formatter(matplotlib.ticker.FuncFormatter(lambda v, _: f"${v:,.0f}"))
ax.xaxis.set_major_formatter(mdates.DateFormatter("%b %-d"))
ax.grid(True, alpha=0.25)
ax.spines[["top", "right"]].set_visible(False)
ax.set_ylim(bottom=0)
if any(p["o"] for p in data["points"]):
    ax.scatter([], [], color="#666", marker="v", label="accepted offer (sold for less than shown)")
ax.legend(frameon=False, fontsize=8.5, loc="upper left", bbox_to_anchor=(1.0, 1.0))
fig.tight_layout()
fig.savefig(sys.argv[1])
