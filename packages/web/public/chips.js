// What clicking an "Ask <agent>" chip puts in the message box. Pure (no DOM), so it can be tested.
//
// - In the room the draft starts with @agent so it goes straight to them, skipping the router.
// - In a private chat with that agent the draft is just the message (the app opens their chat first).
// - Whatever is already typed is kept: the draft goes on a new line after it, never over it.
// - A chip with no message (a model that skipped it) falls back to the old behavior: in the room, put
//   @agent in front of what is typed; in a private chat, just open it.
// Nothing here sends anything. The user reads the draft and presses Enter.

export function draftForChip(chip, { inDm, current }) {
  const message = typeof chip.message === "string" ? chip.message.trim() : "";
  const typed = current.replace(/\s+$/, "");

  if (message === "") {
    if (inDm) return { text: current, drafted: false };
    return { text: `${`@${chip.agentId} ${typed}`.trimEnd()} `, drafted: false };
  }

  const draft = inDm ? message : `@${chip.agentId} ${message}`;
  return { text: typed === "" ? draft : `${typed}\n${draft}`, drafted: true };
}
