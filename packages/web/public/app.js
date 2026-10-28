import { renderBoard, renderMarkdown } from "/markdown.js";

const ACCENTS = {
  sky: "var(--blue)", blue: "var(--blue)", green: "var(--green)", amber: "var(--orange)", orange: "var(--orange)",
  red: "var(--red)", coral: "var(--red)", purple: "#8a5cd0", violet: "#8a5cd0", teal: "#1f8f91", pink: "#c2467a",
  gray: "var(--gray)", grey: "var(--gray)",
};
const STATE_WORDS = { thinking: "thinking", working: "working" };

const $ = (id) => document.getElementById(id);
const els = {
  portraits: $("portraits"), roomBtn: $("room-btn"), roomUnread: $("room-unread"), demo: $("demo-flag"), conn: $("conn"),
  note: $("channel-note"), messages: $("messages"), form: $("composer"), input: $("input"), send: $("send"),
  hint: $("composer-hint"), banner: $("banner"), bannerText: $("banner-text"), bannerHint: $("banner-hint"),
  bannerClose: $("banner-close"), boardSelect: $("board-select"), board: $("board"), marker: $("marker"),
  ink: $("ink"), tray: $("tray-text"),
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
const fmtNum = (n) => n.toLocaleString("en-US");

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
          { type: "button", class: "chip", onclick: () => pickSuggestion(s.agentId) },
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
    const row = el("div", { class: "typing", role: "status" }, el("span", { class: "dot" }), el("span", { text: `${a.name} is ${a.state === "working" ? "using a tool" : "thinking"}…` }));
    row.style.setProperty("--accent", accentOf(a));
    nodes.push(row);
  }

  area.replaceChildren(...nodes);
  if (stick || nearBottom) area.scrollTop = area.scrollHeight;
}

function pickSuggestion(agentId) {
  if (state.channel.startsWith("dm:")) {
    openChannel(`dm:${agentId}`);
  } else {
    const a = state.byId.get(agentId);
    els.input.value = `@${agentId} ${els.input.value}`.replace(/\s+$/, " ");
    els.input.focus();
    els.input.setSelectionRange(els.input.value.length, els.input.value.length);
    autosize();
    els.hint.textContent = `Your message will go straight to ${a.name}. Clear the @ to let the Floor manager route it.`;
  }
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
    return;
  }
  try {
    const { text } = await api(`/api/board?name=${encodeURIComponent(state.focus)}`);
    els.board.innerHTML = renderBoard(text);
  } catch (err) {
    els.board.innerHTML = "";
    els.board.append(el("p", { class: "wb-empty", text: err.message }));
  }
}

function renderBoardSelect(boards) {
  els.boardSelect.replaceChildren(...boards.map((b) => el("option", { value: b, text: b.replace(/\.md$/, ""), selected: b === state.focus })));
  els.boardSelect.disabled = boards.length === 0;
}
els.boardSelect.addEventListener("change", () => {
  state.focus = els.boardSelect.value;
  loadBoard();
});

/* ---------- Token meter ---------- */
function renderBudget(b) {
  state.budget = b;
  const left = Math.max(0, 1 - b.fraction);
  els.ink.style.width = `${(left * 100).toFixed(1)}%`;
  els.marker.dataset.state = b.state;
  els.marker.setAttribute("aria-valuemax", String(b.limit));
  els.marker.setAttribute("aria-valuenow", String(b.totalTokens));
  const cost = b.estimatedCostUsd !== undefined ? ` (about $${b.estimatedCostUsd.toFixed(2)})` : "";
  const tail = b.state === "stopped" ? " Limit reached for today." : b.state === "warn" ? " Running low." : "";
  els.tray.textContent = `${fmtNum(b.totalTokens)} of ${fmtNum(b.limit)} tokens used today${cost}.${tail}`;
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
    if (a) a.state = ev.state;
    renderRoster();
    renderMessages(false);
  } else if (ev.type === "tool") {
    // agent_state already says "working"; nothing extra to show.
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
  es.addEventListener("busy", async (e) => {
    const { busy } = JSON.parse(e.data);
    setBusy(busy);
    if (!busy) {
      for (const a of state.agents) a.state = "idle";
      renderRoster();
      renderMessages(false);
      loadBoard();
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
