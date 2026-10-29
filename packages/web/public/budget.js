// How the token meter reads. Pure (no DOM), so it can be tested.
//
// With a daily limit the pen's ink drains as the day's tokens are used (orange at 80%, red at 100%).
// With no limit (a free local model, say) there is nothing to drain: the pen stays full and neutral and the
// text just says how many tokens were used today.

const fmtNum = (n) => n.toLocaleString("en-US");

export function describeBudget(b) {
  const cost = b.estimatedCostUsd !== undefined ? ` (about $${b.estimatedCostUsd.toFixed(2)})` : "";
  if (b.limit === null || b.limit === undefined) {
    return {
      state: "unlimited",
      inkPercent: 100,
      max: null,
      text: `${fmtNum(b.totalTokens)} tokens used today, no limit${cost}.`,
    };
  }
  const left = Math.max(0, 1 - b.fraction);
  const tail = b.state === "stopped" ? " Limit reached for today." : b.state === "warn" ? " Running low." : "";
  return {
    state: b.state,
    inkPercent: Number((left * 100).toFixed(1)),
    max: b.limit,
    text: `${fmtNum(b.totalTokens)} of ${fmtNum(b.limit)} tokens used today${cost}.${tail}`,
  };
}
