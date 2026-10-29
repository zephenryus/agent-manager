import { describeBudget } from "/budget.js";
import { draftForChip } from "/chips.js";
import { renderBoard, renderMarkdown } from "/markdown.js";

const ACCENTS = {
  sky: "var(--blue)", blue: "var(--blue)", green: "var(--green)", amber: "var(--orange)", orange: "var(--orange)",
  red: "var(--red)", coral: "var(--red)", purple: "#8a5cd0", violet: "#8a5cd0", teal: "#1f8f91", pink: "#c2467a",
  gray: "var(--gray)", grey: "var(--gray)",
};
const STATE_WORDS = { thinking: "thinking", working: "working" };
// Plain-language wording for tool calls: [when we know what it is working on, when we do not].
const TOOL_VERBS = {
  files_list: ["looking in", "looking at the file list"],
  files_read: ["reading", "reading a file"],
  files_write: ["saving", "saving a file"],
  board_list: ["checking", "checking a board"],
  board_add: ["adding to", "adding to a board"],
  board_edit: ["editing", "editing a board"],
  board_set_status: ["updating", "updating a status"],
  notes_head: ["checking its notes", "checking its notes"],
  notes_tail: ["checking its notes", "checking its notes"],
  notes_append: ["writing to its notes", "writing to its notes"],
  notes_pin: ["updating its pinned notes", "updating its pinned notes"],
  suggest_next: ["suggesting a next step", "suggesting a next step"],
};
const toolLabel = (t) => {
  const [withWhat, bare] = TOOL_VERBS[t.name] ?? [`using ${t.name}`, `using ${t.name}`];
  return t.summary ? `${withWhat} ${t.summary}` : bare;
};
// The exact tool and what it worked on, for checking. A summary is only a path or item name, never contents.
const traceLine = (t) => `${t.ok ? "✓" : "✗"} ${t.name}${t.summary ? ` · ${t.summary}` : ""}${t.ok ? "" : t.error ? ` — ${t.error}` : " (failed)"}`;

const $ = (id) => document.getElementById(id);
const els = {
  portraits: $("portraits"), roomBtn: $("room-btn"), roomUnread: $("room-unread"), demo: $("demo-flag"), conn: $("conn"),
  note: $("channel-note"), messages: $("messages"), form: $("composer"), input: $("input"), send: $("send"),
  hint: $("composer-hint"), banner: $("banner"), bannerText: $("banner-text"), bannerHint: $("banner-hint"),
  bannerClose: $("banner-close"), boardSelect: $("board-select"), board: $("board"), marker: $("marker"),
  ink: $("ink"), tray: $("tray-text"), wall: $("whiteboard"), issues: $("issues"), inbox: $("inbox"),
  inboxBadge: $("inbox-badge"), inboxTab: $("inbox-tab"), briefs: $("briefs"),
};

const state = {
  me: "You",
  agents: [],
  byId: new Map(),
  channel: "room",
  entries: [],
  routingFor: new Map(), // user entry id -> "Sent to X: why"
  lastUserEntryId: null,
  unread: new Map(), // channel -> count
  busy: false,
  focus: null,
  budget: null,
  pending: false,
  boardInfo: [],
  itemBoards: new Map(), // item id -> board name
  wallView: "board",
  approvals: [], // every request, oldest first
  flash: null, // item id to scroll to after the next board load
  openTrace: new Set(), // entry ids whose "Used N tools" block the user opened
};

const el = (tag, props = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v; // only ever fed from markdown.js, which escapes first
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, "");
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const kid of kids) if (kid) node.append(kid);
  return node;
};

const accentOf = (agent) => (agent && ACCENTS[agent.accent]) || "var(--gray)";
const nameOf = (id) => (id === "user" ? state.me : state.byId.get(id)?.name ?? id);
const initials = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || res.statusText);
    err.hint = body.hint;
    err.kind = body.kind;
    err.status = res.status;
    throw err;
  }
  return body;
}

/* ---------- Banner ---------- */
function showBanner(message, hint = "") {
  els.bannerText.textContent = message;
  els.bannerHint.textContent = hint;
  els.banner.hidden = false;
}
els.bannerClose.addEventListener("click", () => (els.banner.hidden = true));

/* ---------- Roster ---------- */
function renderRoster() {
  els.portraits.replaceChildren(
    ...state.agents
      .filter((a) => a.status === "active")
      .map((a) => {
        const dm = `dm:${a.id}`;
        const word = STATE_WORDS[a.state] ?? "";
        const unread = state.unread.get(dm) ?? 0;
        const btn = el(
          "button",
          {
            type: "button", class: "portrait", "data-id": a.id, "data-state": a.state,
            "aria-pressed": String(state.channel === dm),
            "aria-label": `${a.name}, ${a.role}${word ? `, ${word}` : ""}. Open a private chat.`,
            title: `${a.name}: ${a.role}`,
            onclick: () => openChannel(dm),
          },
          el("span", { class: "face", text: initials(a.name), "aria-hidden": "true" }),
          el("span", { class: "p-name", text: a.name }),
          el("span", { class: "p-state", text: word }),
          unread ? el("span", { class: "unread", text: String(unread) }) : null,
        );
        btn.style.setProperty("--accent", accentOf(a));
        return el("li", {}, btn);
      }),
  );
  els.roomBtn.setAttribute("aria-pressed", String(state.channel === "room"));
  const roomUnread = state.unread.get("room") ?? 0;
  els.roomUnread.hidden = roomUnread === 0;
  els.roomUnread.textContent = String(roomUnread);
}

/* ---------- Messages ---------- */
const channelAgent = () => (state.channel.startsWith("dm:") ? state.byId.get(state.channel.slice(3)) : null);

function renderMessages(stick = true) {
  const area = els.messages;
  const nearBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 80;
  const nodes = [];

  if (state.entries.length === 0) {
    const a = channelAgent();
    nodes.push(
      el("p", {
        class: "empty",
        text: a
          ? `This is a private chat with ${a.name}. Say what you need.`
          : "Nobody has spoken yet. Ask a question and the Floor manager will pick who answers.",
      }),
    );
  }

  const lastIdx = state.entries.length - 1;
  state.entries.forEach((entry, i) => {
    const agent = state.byId.get(entry.from);
    const kind = entry.from === "user" ? "user" : entry.from === "system" ? "system" : "agent";
    const msg = el(
      "article",
      { class: `msg ${kind}`, "data-id": entry.id },
      el("div", { class: "msg-head" }, el("span", { class: "who", text: nameOf(entry.from) }), el("span", { class: "when", text: fmtTime(entry.ts) })),
      el("div", { class: "body", html: kind === "user" ? renderMarkdown(entry.text) : renderMarkdown(entry.text) }),
    );
    if (agent) msg.style.setProperty("--accent", accentOf(agent));
    if (entry.tools?.length || entry.stopped) msg.append(activityTrace(entry));
    nodes.push(msg);

    const route = state.routingFor.get(entry.id);
    if (route) nodes.push(el("p", { class: "route", text: route }));

    if (i === lastIdx && entry.suggestions?.length && !state.busy) {
      const chips = el("div", { class: "chips", role: "group", "aria-label": "Suggested next steps" });
      for (const s of entry.suggestions) {
        const target = state.byId.get(s.agentId);
        if (!target || target.status !== "active") continue;
        const chip = el(
          "button",
          {
            type: "button",
            class: "chip",
            title: s.message ? `Drafts this message for you to send:\n${s.message}` : undefined,
            onclick: () => pickSuggestion(s),
          },
          el("b", { text: `Ask ${target.name}` }),
          s.reason ? el("span", { text: `: ${s.reason}` }) : null,
        );
        chip.style.setProperty("--accent", accentOf(target));
        chips.append(chip);
      }
      if (chips.children.length) msg.append(chips);
    }
  });

  const working = state.agents.filter((a) => a.state !== "idle" && (state.channel === "room" || state.channel === `dm:${a.id}`));
  for (const a of working) {
    const act = a.activity;
    const label = act?.current
      ? `${a.name} is ${toolLabel(act.current)}…`
      : a.state === "working"
        ? `${a.name} is using a tool…`
        : act?.done.length
          ? `${a.name} is thinking about what it found…`
          : `${a.name} is thinking…`;
    const wrap = el("div", { class: "working", role: "status" }, el("div", { class: "typing" }, el("span", { class: "dot" }), el("span", { text: label })));
    if (act?.done.length) {
      const shown = act.done.slice(-5);
      const steps = el("ul", { class: "steps", "aria-label": "Finished steps" });
      if (act.done.length > shown.length) steps.append(el("li", { text: `… ${act.done.length - shown.length} earlier` }));
      for (const t of shown) steps.append(el("li", { class: t.ok ? "" : "bad", text: traceLine(t) }));
      wrap.append(steps);
    }
    wrap.style.setProperty("--accent", accentOf(a));
    nodes.push(wrap);
  }

  area.replaceChildren(...nodes);
  if (stick || nearBottom) area.scrollTop = area.scrollHeight;
}

/** Under a reply: which tools the agent really called. No tools used means no block at all. */
function activityTrace(entry) {
  const tools = entry.tools ?? [];
  const failed = tools.filter((t) => !t.ok).length;
  const parts = [];
  if (tools.length) parts.push(`Used ${tools.length} ${tools.length === 1 ? "tool" : "tools"}`);
  if (failed) parts.push(`${failed} failed`);
  if (entry.stopped) parts.push(tools.length ? "stopped at the step limit" : "Stopped at the step limit");
  const box = el("details", { class: "trace" }, el("summary", { class: failed || entry.stopped ? "bad" : "", text: parts.join(" · ") }));
  if (tools.length) {
    const list = el("ul", { class: "steps" });
    for (const t of tools) list.append(el("li", { class: t.ok ? "" : "bad", text: traceLine(t) }));
    box.append(list);
  }
  box.open = state.openTrace.has(entry.id);
  box.addEventListener("toggle", () => (box.open ? state.openTrace.add(entry.id) : state.openTrace.delete(entry.id)));
  return box;
}

/** A chip click only fills the message box (and opens their chat from a private chat). It never sends. */
async function pickSuggestion(chip) {
  const target = state.byId.get(chip.agentId);
  const inDm = state.channel.startsWith("dm:");
  const { text, drafted } = draftForChip(chip, { inDm, current: els.input.value });
  if (inDm) await openChannel(`dm:${chip.agentId}`);
  els.input.value = text;
  autosize();
  els.input.focus();
  els.input.setSelectionRange(text.length, text.length);
  const name = target?.name ?? chip.agentId;
  els.hint.textContent = drafted
    ? inDm
      ? `Drafted for ${name}. Edit it if you like, then press Enter to send.`
      : `Drafted for ${name}. Edit it if you like, then press Enter. It goes straight to ${name}.`
    : inDm
      ? defaultHint()
      : `Your message will go straight to ${name}. Clear the @ to let the Floor manager route it.`;
}

/* ---------- Channels ---------- */
async function openChannel(channel) {
  state.channel = channel;
  els.hint.textContent = defaultHint();
  state.unread.delete(channel);
  const a = channelAgent();
  els.input.placeholder = a ? `Message ${a.name} (private)` : "Message the room";
  els.note.textContent = a ? `Private chat with ${a.name}, ${a.role}. Only they see this.` : "";
  renderRoster();
  state.entries = []; // never show the other channel's messages while this one loads
  renderMessages(true);
  try {
    const { entries } = await api(`/api/transcript?channel=${encodeURIComponent(channel)}&limit=200`);
    if (state.channel !== channel) return; // switched again while loading
    state.entries = entries;
  } catch (err) {
    state.entries = [];
    showBanner(err.message);
  }
  renderMessages(true);
  els.input.focus({ preventScroll: true });
}
els.roomBtn.addEventListener("click", () => openChannel("room"));

const defaultHint = () =>
  state.channel.startsWith("dm:")
    ? "Enter sends. Shift+Enter adds a line. Private chats go straight to this person."
    : "Enter sends. Shift+Enter adds a line. Type @ and a name to skip the routing step.";

/* ---------- Board ---------- */
async function loadBoard() {
  if (!state.focus) {
    els.board.innerHTML = '<p class="wb-empty">No board yet. Add a markdown file to the boards folder in your vault.</p>';
    renderIssues([]);
    return;
  }
  try {
    const { text, issues } = await api(`/api/board?name=${encodeURIComponent(state.focus)}`);
    els.board.innerHTML = renderBoard(text);
    renderIssues(issues ?? []);
    if (state.flash) {
      const row = els.board.querySelector(`[data-id="${CSS.escape(state.flash)}"]`);
      state.flash = null;
      if (row) {
        row.scrollIntoView({ block: "center" });
        row.classList.add("flash");
      }
    }
  } catch (err) {
    els.board.innerHTML = "";
    els.board.append(el("p", { class: "wb-empty", text: err.message }));
    renderIssues([]);
  }
}

function renderIssues(issues) {
  els.issues.hidden = issues.length === 0;
  if (issues.length === 0) return;
  els.issues.replaceChildren(
    el("p", { text: issues.length === 1 ? "1 thing to check on this board" : `${issues.length} things to check on this board` }),
    el("ul", {}, ...issues.map((i) => el("li", { text: i.message }))),
  );
}

const LEVEL_LABELS = { pi: "PI goals", sprint: "Sprint", task: "Tasks" };

function renderBoardSelect(boards) {
  const info = new Map(state.boardInfo.map((b) => [b.name, b]));
  const option = (name) => {
    const title = info.get(name)?.title ?? name.replace(/\.md$/, "");
    return el("option", { value: name, text: title, selected: name === state.focus });
  };
  const groups = [];
  for (const level of [...Object.keys(LEVEL_LABELS), null]) {
    const names = boards.filter((n) => (info.get(n)?.level ?? null) === level);
    if (names.length > 0) groups.push(el("optgroup", { label: level ? LEVEL_LABELS[level] : "Other" }, ...names.map(option)));
  }
  els.boardSelect.replaceChildren(...groups);
  els.boardSelect.disabled = boards.length === 0;
}
els.boardSelect.addEventListener("change", () => {
  state.focus = els.boardSelect.value;
  loadBoard();
});

/* A parent id on an item jumps to the board that holds it. */
els.board.addEventListener("click", (e) => {
  const btn = e.target instanceof Element ? e.target.closest(".goto") : null;
  if (!btn) return;
  const id = btn.dataset.goto;
  const board = state.itemBoards.get(id);
  if (!board) return;
  state.flash = id;
  state.focus = board;
  els.boardSelect.value = board;
  loadBoard();
});

/* ---------- Whiteboard tabs and approvals inbox ---------- */
function setWall(view) {
  state.wallView = view;
  els.wall.dataset.wall = view;
  els.inbox.hidden = view !== "inbox";
  els.briefs.hidden = view !== "briefs";
  for (const b of document.querySelectorAll("[data-wall]")) {
    if (b.classList.contains("wb-tab")) b.setAttribute("aria-pressed", String(b.dataset.wall === view));
  }
  if (view === "inbox") loadInbox();
  if (view === "briefs") loadBriefs();
}
for (const btn of document.querySelectorAll(".wb-tab")) btn.addEventListener("click", () => setWall(btn.dataset.wall));

/* ---------- Briefs: short summaries the Floor manager saves in workspaces/shared/briefs/ ---------- */
const fmtDay = (iso) => new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" }) + ", " + fmtTime(iso);

async function loadBriefs() {
  try {
    const { briefs } = await api("/api/briefs");
    const nodes = [el("h2", { text: "Briefs" })];
    if (briefs.length === 0) {
      nodes.push(el("p", { class: "wb-empty", text: "No briefs yet. Ask the Floor manager for one, like \"brief me on where we are\"." }));
    }
    for (const b of briefs) {
      nodes.push(
        el("button", { type: "button", class: "brief-row", onclick: () => openBrief(b.name) },
          el("span", { class: "brief-title", text: b.title }),
          el("span", { class: "brief-when", text: fmtDay(b.modified) }),
        ),
      );
    }
    els.briefs.replaceChildren(...nodes);
  } catch (err) {
    els.briefs.replaceChildren(el("p", { class: "wb-empty", text: err.message }));
  }
}

async function openBrief(name) {
  try {
    const b = await api(`/api/briefs?name=${encodeURIComponent(name)}`);
    els.briefs.replaceChildren(
      el("button", { type: "button", class: "goto", text: "← All briefs", onclick: loadBriefs }),
      el("p", { class: "brief-when", text: `${b.name}, saved ${fmtDay(b.modified)}` }),
      el("div", { class: "brief-body", html: renderMarkdown(b.text, { headingBase: 2 }) }),
    );
    els.briefs.scrollTop = 0;
  } catch (err) {
    els.briefs.replaceChildren(
      el("button", { type: "button", class: "goto", text: "← All briefs", onclick: loadBriefs }),
      el("p", { class: "wb-empty", text: err.message }),
    );
  }
}

function setPending(n) {
  els.inboxBadge.hidden = n === 0;
  els.inboxBadge.textContent = String(n);
  els.inboxTab.setAttribute("aria-label", n === 0 ? "Inbox, nothing waiting" : `Inbox, ${n} waiting`);
}

async function loadInbox() {
  try {
    const { approvals } = await api("/api/approvals?status=all");
    state.approvals = approvals;
    setPending(approvals.filter((a) => a.status === "pending").length);
    renderInbox();
  } catch (err) {
    els.inbox.replaceChildren(el("p", { class: "wb-empty", text: err.message }));
  }
}

const boardTitle = (name) => state.boardInfo.find((b) => b.name === name)?.title ?? name.replace(/\.md$/, "");

function renderInbox() {
  const pending = state.approvals.filter((a) => a.status === "pending");
  const decided = state.approvals.filter((a) => a.status !== "pending").reverse();
  const nodes = [el("h2", { text: "Waiting for approval" })];
  if (pending.length === 0) nodes.push(el("p", { class: "wb-empty", text: "Nothing is waiting. Requests from your team will show up here." }));
  for (const ap of pending) nodes.push(approvalCard(ap));
  if (decided.length > 0) {
    nodes.push(
      el("details", { class: "decided" },
        el("summary", { text: `Decided (${decided.length})` }),
        el("ul", {}, ...decided.slice(0, 20).map((a) => {
          const last = a.history?.[a.history.length - 1];
          const by = last ? ` by ${nameOf(last.by)}` : "";
          const reason = last?.reason ? `: ${last.reason}` : "";
          return el("li", { text: `${a.id} ${a.status}${by}. ${a.summary}${reason}` });
        })),
      ),
    );
  }
  els.inbox.replaceChildren(...nodes);
}

function approvalCard(ap) {
  const chain = ap.approvers.map((who, i) => {
    const name = nameOf(who);
    return i < ap.stage ? `${name} (approved)` : name;
  });
  const reason = el("input", { type: "text", placeholder: "Reason (optional)", "aria-label": `Reason for ${ap.id}`, maxlength: "300" });
  const approve = el("button", { type: "button", class: "approve", title: "Approve and apply the change", text: "Approve" });
  const reject = el("button", { type: "button", text: "Reject" });
  const error = el("p", { class: "ap-error", role: "alert", hidden: true });

  const decide = async (decision) => {
    approve.disabled = reject.disabled = true;
    error.hidden = true;
    try {
      await api(`/api/approvals/${encodeURIComponent(ap.id)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, reason: reason.value }),
      });
      await loadInbox();
      if (decision === "approve") loadBoard();
    } catch (err) {
      approve.disabled = reject.disabled = false;
      error.textContent = err.status === 409 && err.kind === undefined ? "The team is busy. Try again in a moment." : err.message;
      error.hidden = false;
    }
  };
  approve.addEventListener("click", () => decide("approve"));
  reject.addEventListener("click", () => decide("reject"));

  return el("div", { class: "ap", "data-id": ap.id },
    el("p", { class: "ap-summary", text: ap.summary }),
    el("p", { class: "ap-meta", text: `${ap.id}: asked by ${nameOf(ap.actor)} on ${boardTitle(ap.board)}, ${fmtTime(ap.created)}` }),
    ap.why ? el("p", { class: "ap-why", text: `"${ap.why}"` }) : null,
    el("p", { class: "ap-needs", text: `${ap.needed}. Goes through: ${chain.join(", then ")}.` }),
    el("div", { class: "ap-actions" }, reason, approve, reject),
    error,
  );
}

/* ---------- Token meter ---------- */
function renderBudget(b) {
  state.budget = b;
  const view = describeBudget(b);
  els.ink.style.width = `${view.inkPercent}%`;
  els.marker.dataset.state = view.state;
  els.marker.setAttribute("aria-valuenow", String(b.totalTokens));
  // A meter needs a maximum; with no limit there is none, so describe it in words instead.
  if (view.max === null) {
    els.marker.removeAttribute("aria-valuemax");
    els.marker.setAttribute("aria-valuetext", view.text);
  } else {
    els.marker.setAttribute("aria-valuemax", String(view.max));
    els.marker.removeAttribute("aria-valuetext");
  }
  els.tray.textContent = view.text;
}

/* ---------- Busy ---------- */
function setBusy(busy) {
  state.busy = busy;
  els.send.disabled = busy || state.pending;
  els.send.textContent = busy ? "Working…" : "Send";
}

/* ---------- Composer ---------- */
function autosize() {
  els.input.style.height = "auto";
  els.input.style.height = `${Math.min(els.input.scrollHeight + 2, window.innerHeight * 0.4)}px`;
}
els.input.addEventListener("input", autosize);
els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    els.form.requestSubmit();
  }
});

els.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = els.input.value.trim();
  if (!text || state.busy || state.pending) return;
  state.pending = true;
  els.banner.hidden = true;
  els.input.value = "";
  autosize();
  els.hint.textContent = defaultHint();
  setBusy(state.busy);
  try {
    await api("/api/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text,
        ...(state.channel.startsWith("dm:") ? { dm: state.channel.slice(3) } : {}),
        ...(state.focus ? { focus: state.focus } : {}),
      }),
    });
  } catch (err) {
    els.input.value = text; // keep the words so nothing is lost
    autosize();
    const msg =
      err.kind === "auth" ? "Can't reach the model: credentials are missing or expired." :
      err.kind === "budget" ? err.message :
      err.status === 409 ? "The team is still working on the last message. Try again in a moment." :
      err.message;
    showBanner(msg, err.hint ?? (err.kind === "auth" ? "" : ""));
  } finally {
    state.pending = false;
    setBusy(state.busy);
    await refreshState(false);
  }
});

/* ---------- Live events ---------- */
function onRoomEvent(ev) {
  if (ev.type === "agent_state") {
    const a = state.byId.get(ev.agentId);
    if (a) {
      a.state = ev.state;
      if (ev.state === "thinking") a.activity = { current: null, done: [] };
      else if (ev.state === "idle") delete a.activity;
    }
    renderRoster();
    renderMessages(false);
  } else if (ev.type === "tool") {
    const a = state.byId.get(ev.agentId);
    if (a) {
      a.activity ??= { current: null, done: [] };
      if (ev.phase === "start") {
        a.activity.current = { name: ev.name, summary: ev.summary };
      } else {
        a.activity.done.push({ name: ev.name, summary: ev.summary, ok: ev.ok, error: ev.error });
        a.activity.current = null;
      }
      renderMessages(false);
    }
  } else if (ev.type === "routing") {
    const d = ev.decision;
    const who = d.responders.map(nameOf).join(" and ");
    const why = d.source === "mention" ? "you mentioned them" : d.reason.replace(/\.$/, "");
    if (state.lastUserEntryId) state.routingFor.set(state.lastUserEntryId, `Sent to ${who}: ${why}.`);
    if (state.channel === "room") renderMessages(false);
  } else if (ev.type === "entry") {
    if (ev.entry.from === "user" && ev.channel === "room") state.lastUserEntryId = ev.entry.id;
    if (ev.channel === state.channel) {
      if (!state.entries.some((x) => x.id === ev.entry.id)) state.entries.push(ev.entry);
      renderMessages(true);
    } else if (ev.entry.from !== "user") {
      state.unread.set(ev.channel, (state.unread.get(ev.channel) ?? 0) + 1);
      renderRoster();
    }
  }
}

function connect() {
  const es = new EventSource("/api/events");
  es.addEventListener("hello", (e) => {
    els.conn.hidden = true;
    setBusy(JSON.parse(e.data).busy);
  });
  es.addEventListener("room", (e) => onRoomEvent(JSON.parse(e.data)));
  es.addEventListener("budget", (e) => renderBudget(JSON.parse(e.data)));
  es.addEventListener("approvals", (e) => {
    setPending(JSON.parse(e.data).pending);
    if (state.wallView === "inbox") loadInbox();
  });
  es.addEventListener("board", () => {
    loadBoard();
    refreshState(false);
  });
  es.addEventListener("busy", async (e) => {
    const { busy } = JSON.parse(e.data);
    setBusy(busy);
    if (!busy) {
      for (const a of state.agents) a.state = "idle";
      renderRoster();
      renderMessages(false);
      loadBoard();
      if (state.wallView === "briefs" && !els.briefs.querySelector(".brief-body")) loadBriefs();
    }
  });
  let reconnected = false;
  es.addEventListener("open", () => {
    if (reconnected) refreshState(true);
  });
  es.onerror = () => {
    reconnected = true;
    els.conn.hidden = false;
  };
}

/* ---------- Boot ---------- */
async function refreshState(reloadChannel) {
  const s = await api("/api/state");
  state.me = s.userName;
  state.agents = s.agents;
  state.byId = new Map(s.agents.map((a) => [a.id, a]));
  els.demo.hidden = !s.demo;
  state.boardInfo = s.boardInfo ?? [];
  state.itemBoards = new Map(state.boardInfo.flatMap((b) => b.items.map((id) => [id, b.name])));
  setPending(s.approvals ?? 0);
  if (!state.focus || !s.boards.includes(state.focus)) state.focus = s.boards.includes(s.defaultBoard) ? s.defaultBoard : s.boards[0] ?? null;
  renderBoardSelect(s.boards);
  renderBudget(s.budget);
  setBusy(s.busy);
  renderRoster();
  if (reloadChannel) {
    await openChannel(state.channel);
    loadBoard();
  }
}

for (const btn of document.querySelectorAll("[data-view-btn]")) {
  btn.addEventListener("click", () => {
    document.body.dataset.view = btn.dataset.viewBtn;
    for (const b of document.querySelectorAll("[data-view-btn]")) b.setAttribute("aria-pressed", String(b === btn));
  });
}

try {
  await refreshState(true);
  connect();
} catch (err) {
  showBanner("Can't reach the local server.", "Is it still running? Start it again with pnpm start, then reload this page.");
}
