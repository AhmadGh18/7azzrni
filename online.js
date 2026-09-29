// ============================================================
// Online multiplayer — PeerJS, host-authoritative
// ============================================================
//
// Roles:
//   HOST: creates the room, its peer id IS the room code.
//         Runs the game (picks word, assigns roles, runs timer, tallies votes).
//         Host is also a regular player.
//   GUEST: connects to host's peer id.
//
// Message protocol (JSON over PeerJS DataConnection):
//   { t: "join",     name }                          guest -> host
//   { t: "roster",   players: [{id, name, isHost}] } host -> all
//   { t: "start",    catId, impostorCount, difficulty, timerSecs }  host -> all (informational)
//   { t: "role",     isImpostor, word?, hint? }      host -> each guest privately
//   { t: "chat",     fromId, name, text }            anyone -> host -> all
//   { t: "phase",    phase: "chat"|"vote"|"result",
//                    timerLeft? }                    host -> all
//   { t: "vote",     votedId }                       guest -> host
//   { t: "votes",    tally: {id: count},
//                    votedCount, totalCount }        host -> all
//   { t: "result",   impostorIds, word, winner, votedOutId } host -> all
//   { t: "kick",     reason }                        host -> guest
// ============================================================

const net = {
  role: null,           // "host" | "guest"
  peer: null,           // PeerJS Peer instance
  hostConn: null,       // guest side: connection to host
  guestConns: {},       // host side: {peerId: DataConnection}
  myId: null,
  myName: "",
  maxPlayers: 5,

  // Shared state
  roomCode: null,
  players: [],          // [{id, name, isHost}]
  category: "random",
  impostorCount: 1,
  difficulty: "medium",
  timerSecs: 120,

  // Round state (host authoritative)
  roundCategory: null,  // resolved category object
  roundWord: null,      // {word, hint}
  impostorIds: [],
  myRole: null,         // {isImpostor, word?, hint?}
  votes: {},            // {voterId: votedId}
  phase: "lobby",       // lobby | reveal | chat | vote | result
  timerInterval: null,
  timerLeft: 0,

  // UI state
  lobbyCategoryId: "random"
};

// ============================================================
// PERSISTENCE (localStorage) — survive reloads
// ============================================================
const STORAGE_KEY = "impostor-online";

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      name: net.myName || "",
      role: net.role,
      roomCode: net.phase === "lobby" ? net.roomCode : null
    }));
  } catch (e) {}
}
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function clearRoomState() {
  const s = loadState() || {};
  s.roomCode = null;
  s.role = null;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch (e) {}
}

// ============================================================
// UTILITIES
// ============================================================
function genRoomCode() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I/O to avoid confusion
  let code = "";
  for (let i = 0; i < 4; i++) code += letters[Math.floor(Math.random() * letters.length)];
  return code;
}

function peerIdFor(code) { return "impostor-" + code.toUpperCase(); }
function codeFromPeerId(pid) { return (pid || "").replace(/^impostor-/, ""); }

function send(conn, msg) {
  try { conn.send(msg); } catch (e) { console.warn("send failed", e); }
}
function broadcast(msg) {
  Object.values(net.guestConns).forEach(c => { if (c && c.open) send(c, msg); });
}
function sendToHost(msg) {
  if (net.hostConn && net.hostConn.open) send(net.hostConn, msg);
}

function showErr(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text || "";
}

// ============================================================
// STEPPER (max players + impostor count)
// ============================================================
document.getElementById("max-minus").addEventListener("click", () => {
  if (net.maxPlayers > 3) { net.maxPlayers--; updateMaxUI(); }
});
document.getElementById("max-plus").addEventListener("click", () => {
  if (net.maxPlayers < 10) { net.maxPlayers++; updateMaxUI(); }
});
function updateMaxUI() {
  document.getElementById("max-value").textContent = net.maxPlayers;
  document.getElementById("max-minus").disabled = net.maxPlayers <= 3;
  document.getElementById("max-plus").disabled = net.maxPlayers >= 10;
  updateCreateImpUI();
}
updateMaxUI();

document.getElementById("create-imp-minus").addEventListener("click", () => {
  if (net.impostorCount > 1) { net.impostorCount--; updateCreateImpUI(); }
});
document.getElementById("create-imp-plus").addEventListener("click", () => {
  const maxImp = Math.max(1, net.maxPlayers - 2);
  if (net.impostorCount < maxImp) { net.impostorCount++; updateCreateImpUI(); }
});
function updateCreateImpUI() {
  const maxImp = Math.max(1, net.maxPlayers - 2);
  if (net.impostorCount > maxImp) net.impostorCount = maxImp;
  document.getElementById("create-imp-value").textContent = net.impostorCount;
  document.getElementById("create-imp-minus").disabled = net.impostorCount <= 1;
  document.getElementById("create-imp-plus").disabled = net.impostorCount >= maxImp;
}

document.getElementById("lobby-imp-minus").addEventListener("click", () => {
  if (net.impostorCount > 1) { net.impostorCount--; updateLobbyImpUI(); pushLobbyStateFromHost(); }
});
document.getElementById("lobby-imp-plus").addEventListener("click", () => {
  const maxImp = Math.max(1, net.players.length - 2);
  if (net.impostorCount < maxImp) { net.impostorCount++; updateLobbyImpUI(); pushLobbyStateFromHost(); }
});
function updateLobbyImpUI() {
  document.getElementById("lobby-imp-value").textContent = net.impostorCount;
  const maxImp = Math.max(1, net.players.length - 2);
  document.getElementById("lobby-imp-minus").disabled = net.impostorCount <= 1;
  document.getElementById("lobby-imp-plus").disabled = net.impostorCount >= maxImp;
  if (net.impostorCount > maxImp) { net.impostorCount = maxImp; document.getElementById("lobby-imp-value").textContent = net.impostorCount; }
}

document.querySelectorAll("#lobby-diff-seg .seg-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#lobby-diff-seg .seg-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    net.difficulty = btn.getAttribute("data-diff");
  });
});

function pushLobbyStateFromHost() { /* future: sync settings; not required for MVP */ }

// ============================================================
// CATEGORY GRID IN LOBBY (host chooses)
// ============================================================
function renderLobbyCategoryGrid() {
  const grid = document.getElementById("lobby-category-grid");
  grid.innerHTML = "";
  const randomBtn = document.createElement("button");
  randomBtn.className = "cat-card cat-random" + (net.lobbyCategoryId === "random" ? " selected" : "");
  randomBtn.innerHTML = `<span class="cat-emoji">🎲</span><span class="cat-name">Random</span>`;
  randomBtn.addEventListener("click", () => { net.lobbyCategoryId = "random"; renderLobbyCategoryGrid(); });
  grid.appendChild(randomBtn);
  CATEGORIES.forEach(c => {
    const btn = document.createElement("button");
    btn.className = "cat-card" + (net.lobbyCategoryId === c.id ? " selected" : "");
    btn.innerHTML = `<span class="cat-emoji">${c.emoji}</span><span class="cat-name">${c.name}</span>`;
    btn.addEventListener("click", () => { net.lobbyCategoryId = c.id; renderLobbyCategoryGrid(); });
    grid.appendChild(btn);
  });
}

// ============================================================
// CREATE ROOM (HOST)
// ============================================================
document.getElementById("create-room-btn").addEventListener("click", () => {
  const name = document.getElementById("host-name").value.trim() || "Host";
  net.myName = name;
  net.role = "host";
  attemptCreatePeer();
});

function attemptCreatePeer(retry = 0, reuseCode = null) {
  const code = reuseCode || genRoomCode();
  const pid = peerIdFor(code);
  const oldPeer = net.peer;
  if (oldPeer) { try { oldPeer.destroy(); } catch (e) {} }
  // If reusing a code just after destroying, give the signaling server a moment
  // to release the old ID before re-registering (avoids spurious unavailable-id).
  const delay = (reuseCode && oldPeer) ? 800 : 0;
  setTimeout(() => actuallyCreatePeer(code, pid, retry, reuseCode), delay);
}

function actuallyCreatePeer(code, pid, retry, reuseCode) {
  net.peer = new Peer(pid, { debug: 1 });

  net.peer.on("open", (id) => {
    net.myId = id;
    net.roomCode = code;
    // Only reset players if this is a fresh room, not a reconnection
    if (!reuseCode) {
      net.players = [{ id, name: net.myName, isHost: true }];
    } else {
      // Update our own player id (it might have changed) and clear stale guests
      net.players = [{ id, name: net.myName, isHost: true }];
      updateLobbyStatus("Reconnected — waiting for players…");
    }
    saveState();
    goLobby();
  });

  net.peer.on("connection", (conn) => {
    setupHostConnection(conn);
  });

  net.peer.on("error", (err) => {
    console.warn("peer error", err);
    if (err.type === "unavailable-id") {
      if (reuseCode && retry < 6) {
        // Server still holds the old ID from before backgrounding — wait and retry
        updateLobbyStatus("Reconnecting… (" + (retry + 1) + "/6)");
        setTimeout(() => attemptCreatePeer(retry + 1, reuseCode), 2000);
      } else if (!reuseCode && retry < 5) {
        attemptCreatePeer(retry + 1);
      } else if (reuseCode) {
        // Give up on old code, tell user
        alert("Your room expired. Create a new one.");
        clearRoomState();
        showScreen("home");
      } else {
        alert("Couldn't create room. Try again.");
      }
    } else if (err.type === "network" || err.type === "server-error" || err.type === "socket-error") {
      try { net.peer.reconnect(); } catch (e) {}
    } else if (err.type === "disconnected") {
      // Peer was torn down — recreate
      if (net.roomCode) attemptCreatePeer(0, net.roomCode);
    } else {
      console.warn("Non-fatal peer error:", err.type);
    }
  });

  net.peer.on("disconnected", () => {
    // Signaling connection lost (mobile backgrounded the tab, WiFi flicker, etc.)
    // The peer ID is still reserved on the server for a short window — reconnect uses it.
    console.log("Peer disconnected. Reconnecting…");
    try { net.peer.reconnect(); } catch (e) {}
    updateLobbyStatus("Reconnecting…");
  });
}

function updateLobbyStatus(text) {
  const el = document.getElementById("lobby-status");
  if (el && net.role) el.textContent = text;
}

function setupHostConnection(conn) {
  conn.on("open", () => {
    // wait for join message with name before adding player
  });
  conn.on("data", (msg) => handleHostMessage(conn, msg));
  conn.on("close", () => {
    if (conn._joinedPlayerId) {
      net.players = net.players.filter(p => p.id !== conn._joinedPlayerId);
      delete net.guestConns[conn._joinedPlayerId];
      broadcastRoster();
      renderLobbyPlayers();
      addSystemMessage(conn._joinedName + " left");
    }
  });
}

function handleHostMessage(conn, msg) {
  if (!msg || !msg.t) return;
  switch (msg.t) {
    case "join": {
      // Enforce max players
      if (net.players.length >= net.maxPlayers) {
        send(conn, { t: "kick", reason: "Room is full" });
        setTimeout(() => { try { conn.close(); } catch (e) {} }, 200);
        return;
      }
      if (net.phase !== "lobby") {
        send(conn, { t: "kick", reason: "Game already started" });
        setTimeout(() => { try { conn.close(); } catch (e) {} }, 200);
        return;
      }
      const id = conn.peer;
      const name = (msg.name || "Player").slice(0, 20);
      conn._joinedPlayerId = id;
      conn._joinedName = name;
      net.guestConns[id] = conn;
      net.players.push({ id, name, isHost: false });
      broadcastRoster();
      renderLobbyPlayers();
      addSystemMessage(name + " joined");
      break;
    }
    case "chat": {
      const p = net.players.find(x => x.id === msg.fromId);
      if (!p) return;
      const chatMsg = { t: "chat", fromId: p.id, name: p.name, text: msg.text.slice(0, 200) };
      broadcast(chatMsg);
      addChatMessage(chatMsg);
      break;
    }
    case "vote": {
      net.votes[conn._joinedPlayerId] = msg.votedId;
      broadcastVotes();
      maybeFinishVote();
      break;
    }
  }
}

function broadcastRoster() {
  const roster = { t: "roster", players: net.players, max: net.maxPlayers };
  broadcast(roster);
}

// ============================================================
// JOIN ROOM (GUEST)
// ============================================================
document.getElementById("join-room-btn").addEventListener("click", () => {
  const name = document.getElementById("guest-name").value.trim() || "Player";
  const codeRaw = document.getElementById("guest-code").value.trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(codeRaw)) {
    showErr("join-error", "Enter a 4-letter code (A–Z)");
    return;
  }
  showErr("join-error", "Connecting…");
  net.myName = name;
  net.role = "guest";
  net.roomCode = codeRaw;

  if (net.peer) { try { net.peer.destroy(); } catch (e) {} }
  net.peer = new Peer({ debug: 1 });

  net.peer.on("open", (id) => {
    net.myId = id;
    const conn = net.peer.connect(peerIdFor(codeRaw), { reliable: true });
    net.hostConn = conn;
    let opened = false;

    conn.on("open", () => {
      opened = true;
      send(conn, { t: "join", name });
      showErr("join-error", "");
      saveState();
      goLobby();
    });
    conn.on("data", (msg) => handleGuestMessage(msg));
    conn.on("close", () => {
      if (!opened) {
        showErr("join-error", "Room not found");
      } else {
        alert("Disconnected from host.");
        leaveRoom();
      }
    });
    conn.on("error", (err) => {
      console.warn("conn err", err);
      showErr("join-error", "Couldn't connect");
    });

    setTimeout(() => {
      if (!opened) {
        showErr("join-error", "Room not found");
        try { conn.close(); } catch (e) {}
      }
    }, 8000);
  });

  net.peer.on("error", (err) => {
    console.warn("peer err", err);
    if (err.type === "peer-unavailable") showErr("join-error", "Room not found");
    else if (err.type === "network" || err.type === "socket-error") {
      try { net.peer.reconnect(); } catch (e) {}
    } else showErr("join-error", "Connection error");
  });

  net.peer.on("disconnected", () => {
    console.log("Guest peer disconnected. Reconnecting…");
    try { net.peer.reconnect(); } catch (e) {}
    updateLobbyStatus("Reconnecting…");
  });
});

// When the user comes back from the app switcher / another tab, force a reconnect
// if PeerJS quietly lost its signaling connection while backgrounded.
// When the tab is refocused after backgrounding (esp. on mobile), the PeerJS
// connection to the signaling server is usually dead. Two failure modes:
//   1. peer.disconnected (soft) — just call reconnect()
//   2. peer.destroyed  (hard)   — must fully recreate the peer with same code
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (!net.peer || !net.roomCode) return;

  const p = net.peer;
  if (p.destroyed) {
    // Full recreate needed
    updateLobbyStatus("Reconnecting…");
    if (net.role === "host") {
      attemptCreatePeer(0, net.roomCode);
    } else {
      rejoinAsGuest(net.roomCode, net.myName);
    }
  } else if (p.disconnected) {
    updateLobbyStatus("Reconnecting…");
    try { p.reconnect(); } catch (e) {
      // Reconnect failed — hard recreate
      if (net.role === "host") attemptCreatePeer(0, net.roomCode);
      else rejoinAsGuest(net.roomCode, net.myName);
    }
    setTimeout(() => {
      if (net.peer && !net.peer.disconnected && net.phase === "lobby") {
        updateLobbyStatus(net.role === "host" ? "Waiting for players…" : "Connected");
      }
    }, 2500);
  }
});

// Guest reconnect helper — same code, same name
function rejoinAsGuest(code, name) {
  if (net.peer) { try { net.peer.destroy(); } catch (e) {} }
  net.peer = new Peer({ debug: 1 });
  net.peer.on("open", (id) => {
    net.myId = id;
    const conn = net.peer.connect(peerIdFor(code), { reliable: true });
    net.hostConn = conn;
    conn.on("open", () => {
      send(conn, { t: "join", name });
      updateLobbyStatus("Reconnected");
    });
    conn.on("data", (msg) => handleGuestMessage(msg));
    conn.on("close", () => { updateLobbyStatus("Host disconnected"); });
  });
  net.peer.on("disconnected", () => {
    try { net.peer.reconnect(); } catch (e) {}
  });
}

function handleGuestMessage(msg) {
  if (!msg || !msg.t) return;
  switch (msg.t) {
    case "roster":
      net.players = msg.players;
      net.maxPlayers = msg.max;
      renderLobbyPlayers();
      break;
    case "start":
      // informational — hide lobby ui, wait for role
      break;
    case "role":
      net.myRole = { isImpostor: msg.isImpostor, word: msg.word, hint: msg.hint };
      resetRoundLocalState();
      showOnlineReveal();
      break;
    case "chat-started":
      handleChatStarted(msg);
      break;
    case "phase":
      handlePhaseChange(msg);
      break;
    case "chat":
      if (msg.fromId !== net.myId) addChatMessage(msg);
      break;
    case "votes":
      updateVoteTally(msg);
      break;
    case "result":
      showOnlineResult(msg);
      break;
    case "kick":
      alert(msg.reason || "Removed from room");
      leaveRoom();
      break;
  }
}

// ============================================================
// LOBBY UI
// ============================================================
function goLobby() {
  showScreen("lobby");
  net.phase = "lobby";
  document.getElementById("lobby-code").textContent = net.roomCode;
  document.getElementById("lobby-max").textContent = net.maxPlayers;
  const isHost = net.role === "host";
  document.getElementById("host-controls").style.display = isHost ? "" : "none";
  document.getElementById("guest-waiting").style.display = isHost ? "none" : "";
  if (isHost) {
    renderLobbyCategoryGrid();
    updateLobbyImpUI();
  }
  renderLobbyPlayers();
}

function renderLobbyPlayers() {
  const list = document.getElementById("lobby-players");
  list.innerHTML = "";
  net.players.forEach((p, i) => {
    const row = document.createElement("div");
    row.className = "lobby-player";
    const emoji = emojiForIndex(i);
    row.innerHTML = `
      <span class="lp-emoji">${emoji}</span>
      <span class="lp-name">${escapeHtml(p.name)}${p.id === net.myId ? " (you)" : ""}</span>
      ${p.isHost ? '<span class="lp-badge">Host</span>' : ''}
    `;
    list.appendChild(row);
  });
  document.getElementById("lobby-count").textContent = net.players.length;
  document.getElementById("lobby-max").textContent = net.maxPlayers;
  if (net.role === "host") updateLobbyImpUI();
}

// Just copy the code to clipboard — no share dialog
document.getElementById("share-code-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  if (!net.roomCode) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(net.roomCode).catch(() => {});
  } else {
    // Fallback for older browsers
    const ta = document.createElement("textarea");
    ta.value = net.roomCode;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (err) {}
    document.body.removeChild(ta);
  }
  flashStatus("Copied!");
});

function flashStatus(text) {
  const hint = document.getElementById("lobby-status");
  const prev = hint.textContent;
  hint.textContent = text;
  setTimeout(() => { hint.textContent = prev; }, 1400);
}

// Leave lobby
document.getElementById("lobby-leave").addEventListener("click", () => {
  if (confirm("Leave the room?")) leaveRoom();
});

function leaveRoom() {
  if (net.timerInterval) { clearInterval(net.timerInterval); net.timerInterval = null; }
  try { if (net.peer) net.peer.destroy(); } catch (e) {}
  net.peer = null;
  net.hostConn = null;
  net.guestConns = {};
  net.players = [];
  net.roomCode = null;
  net.myRole = null;
  net.votes = {};
  net.phase = "lobby";
  clearRoomState();
  showScreen("home");
}

// ============================================================
// HOST START GAME
// ============================================================
document.getElementById("host-start-btn").addEventListener("click", () => {
  if (net.role !== "host") return;
  if (net.players.length < 3) {
    alert("Need at least 3 players to start.");
    return;
  }
  hostStartGame();
});

function hostStartGame() {
  net.phase = "reveal";
  net.votes = {};
  resetRoundLocalState();

  // Pick category
  const catId = net.lobbyCategoryId;
  const cat = catId === "random"
    ? CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)]
    : (CATEGORIES.find(c => c.id === catId) || CATEGORIES[0]);
  net.roundCategory = cat;

  // Pick word
  const w = cat.words[Math.floor(Math.random() * cat.words.length)];
  net.roundWord = typeof w === "string"
    ? { word: w, hint: (cat.genericHints || ["Hint"])[0] }
    : w;

  // Cap impostor count
  const maxImp = Math.max(1, net.players.length - 2);
  if (net.impostorCount > maxImp) net.impostorCount = maxImp;

  // Pick impostors from all players (including host)
  const indices = [...Array(net.players.length).keys()];
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  net.impostorIds = indices.slice(0, net.impostorCount).map(i => net.players[i].id);

  // Send everyone their role privately
  net.players.forEach(p => {
    const isImp = net.impostorIds.includes(p.id);
    const role = { t: "role", isImpostor: isImp };
    if (!isImp) role.word = net.roundWord.word;
    else if (net.difficulty === "medium") role.hint = net.roundWord.hint;

    if (p.id === net.myId) {
      net.myRole = { isImpostor: role.isImpostor, word: role.word, hint: role.hint };
      showOnlineReveal();
    } else {
      const conn = net.guestConns[p.id];
      if (conn) send(conn, role);
    }
  });

  broadcast({ t: "start", catId: cat.id, impostorCount: net.impostorCount, difficulty: net.difficulty, timerSecs: net.timerSecs });
}

// Clear chat + timer state at the start of each round.
function resetRoundLocalState() {
  if (net.timerInterval) { clearInterval(net.timerInterval); net.timerInterval = null; }
  net.chatPhaseRunning = false;
  net.timerLeft = net.timerSecs;
  const box = document.getElementById("chat-messages");
  if (box) box.innerHTML = "";
  hideDecisionBar();
  updateChatTimer();
}

// ============================================================
// ONLINE REVEAL
// ============================================================
function showOnlineReveal() {
  net.phase = "reveal";
  showScreen("online-reveal");
  const card = document.getElementById("online-reveal-card");
  const role = document.getElementById("online-reveal-role");
  const word = document.getElementById("online-reveal-word");
  const hint = document.getElementById("online-reveal-hint");
  card.classList.toggle("impostor", !!net.myRole.isImpostor);
  if (net.myRole.isImpostor) {
    role.textContent = "You are the";
    word.textContent = "IMPOSTOR 🤫";
    hint.textContent = net.myRole.hint ? `Hint: ${net.myRole.hint}` : "";
  } else {
    role.textContent = "Your word is";
    word.textContent = net.myRole.word || "—";
    hint.textContent = "";
  }
}

document.getElementById("online-reveal-continue").addEventListener("click", () => {
  if (net.role === "host") {
    // Host starts the timer for everyone (background), moves themselves to chat.
    if (!net.chatPhaseRunning) {
      broadcast({ t: "chat-started", timerLeft: net.timerSecs });
      startChatTimer(net.timerSecs);
    }
    enterChatScreen();
  } else {
    // Guest: only moves themselves into chat. Timer already running (if host clicked first).
    enterChatScreen();
  }
});

// ============================================================
// CHAT PHASE
// ============================================================
function handlePhaseChange(msg) {
  if (msg.phase === "chat") {
    startChatTimer(msg.timerLeft || net.timerSecs, !!msg.extension);
  } else if (msg.phase === "vote") {
    // Vote is the one event that always yanks everyone forward, so nobody gets left behind
    openVoteScreen();
  }
}

// Called on guests when host clicks "Got it" (starts the shared timer without switching screen).
function handleChatStarted(msg) {
  startChatTimer(msg.timerLeft || net.timerSecs, false);
}

// Runs the discussion timer in the background. Does NOT switch screens.
function startChatTimer(seconds, isExtension) {
  net.phase = "chat";
  net.chatPhaseRunning = true;
  net.timerLeft = seconds;
  if (isExtension) {
    addSystemMessage(`⏱️ Host extended the discussion by ${seconds}s`);
  } else {
    addSystemMessage("Discussion started. Ask questions to find the impostor!");
  }
  hideDecisionBar();
  updateChatTimer();
  if (net.timerInterval) clearInterval(net.timerInterval);
  net.timerInterval = setInterval(() => {
    net.timerLeft--;
    updateChatTimer();
    if (net.timerLeft <= 0) {
      clearInterval(net.timerInterval);
      net.timerInterval = null;
      // Only surface the decision UI if the player is currently on the chat screen
      if (document.getElementById("screen-online-chat").classList.contains("active")) {
        showDecisionBar();
      }
    }
  }, 1000);
}

// Move this player into the chat screen. Timer is separate.
function enterChatScreen() {
  showScreen("online-chat");
  // If timer already expired while player was still on reveal, show the decision bar
  if (net.chatPhaseRunning && net.timerLeft <= 0) {
    showDecisionBar();
  } else {
    hideDecisionBar();
  }
  const box = document.getElementById("chat-messages");
  box.scrollTop = box.scrollHeight;
}

function showDecisionBar() {
  document.getElementById("chat-input-row").style.display = "none";
  document.getElementById("chat-decision-bar").style.display = "";
  document.getElementById("chat-decision-host").style.display = net.role === "host" ? "" : "none";
  document.getElementById("chat-decision-guest").style.display = net.role === "host" ? "none" : "";
  addSystemMessage(net.role === "host"
    ? "Time's up. Continue the discussion or move to voting?"
    : "Time's up. Waiting for the host to continue or vote…");
}

function hideDecisionBar() {
  document.getElementById("chat-input-row").style.display = "";
  document.getElementById("chat-decision-bar").style.display = "none";
}

document.getElementById("chat-continue-btn").addEventListener("click", () => {
  if (net.role !== "host") return;
  const extra = 30;
  broadcast({ t: "phase", phase: "chat", timerLeft: extra, extension: true });
  startChatPhase(extra, true);
});

document.getElementById("chat-vote-btn").addEventListener("click", () => {
  if (net.role !== "host") return;
  broadcast({ t: "phase", phase: "vote" });
  openVoteScreen();
});

function updateChatTimer() {
  const m = Math.floor(net.timerLeft / 60);
  const s = (net.timerLeft % 60).toString().padStart(2, "0");
  const el = document.getElementById("chat-timer");
  el.textContent = `${m}:${s}`;
  el.classList.toggle("warn", net.timerLeft <= 30 && net.timerLeft > 10);
  el.classList.toggle("danger", net.timerLeft <= 10);
}

document.getElementById("chat-send").addEventListener("click", sendChatFromInput);
document.getElementById("chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChatFromInput();
});

function sendChatFromInput() {
  const input = document.getElementById("chat-input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  const msg = { t: "chat", fromId: net.myId, name: net.myName, text: text.slice(0, 200) };
  if (net.role === "host") {
    broadcast(msg);
    addChatMessage(msg);
  } else {
    sendToHost(msg);
    addChatMessage(msg);
  }
}

function addChatMessage(msg) {
  const box = document.getElementById("chat-messages");
  const div = document.createElement("div");
  const mine = msg.fromId === net.myId;
  div.className = "chat-msg " + (mine ? "mine" : "theirs");
  div.innerHTML = `
    ${mine ? "" : `<div class="chat-msg-name">${escapeHtml(msg.name)}</div>`}
    <div>${escapeHtml(msg.text)}</div>
  `;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function addSystemMessage(text) {
  const box = document.getElementById("chat-messages");
  if (!box) return;
  const div = document.createElement("div");
  div.className = "chat-msg system";
  div.textContent = text;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

document.getElementById("chat-leave").addEventListener("click", () => {
  if (confirm("Leave the game?")) leaveRoom();
});

// ============================================================
// VOTE PHASE
// ============================================================
function openVoteScreen() {
  net.phase = "vote";
  showScreen("online-vote");
  const grid = document.getElementById("online-vote-grid");
  grid.innerHTML = "";
  net.players.forEach((p, i) => {
    const btn = document.createElement("button");
    btn.className = "vote-card";
    btn.setAttribute("data-vote-id", p.id);
    btn.innerHTML = `
      <span class="vote-emoji">${emojiForIndex(i)}</span>
      ${escapeHtml(p.name)}${p.id === net.myId ? " (you)" : ""}
      <span class="vote-count" data-count-for="${p.id}">0</span>
    `;
    btn.addEventListener("click", () => castVote(p.id));
    if (p.id === net.myId) btn.disabled = true; // can't vote self
    grid.appendChild(btn);
  });
  updateVoteProgressText();
}

function castVote(votedId) {
  document.querySelectorAll(".vote-card").forEach(el => {
    el.disabled = true;
    el.classList.toggle("voted-by-me", el.getAttribute("data-vote-id") === votedId);
  });
  if (net.role === "host") {
    net.votes[net.myId] = votedId;
    broadcastVotes();
    maybeFinishVote();
  } else {
    sendToHost({ t: "vote", votedId });
  }
}

function broadcastVotes() {
  const tally = {};
  net.players.forEach(p => tally[p.id] = 0);
  Object.values(net.votes).forEach(v => { if (tally[v] !== undefined) tally[v]++; });
  const msg = { t: "votes", tally, votedCount: Object.keys(net.votes).length, totalCount: net.players.length };
  broadcast(msg);
  updateVoteTally(msg);
}

function updateVoteTally(msg) {
  Object.entries(msg.tally).forEach(([id, count]) => {
    const el = document.querySelector(`[data-count-for="${id}"]`);
    if (el) el.textContent = count + " vote" + (count === 1 ? "" : "s");
  });
  const p = document.getElementById("vote-progress");
  if (p) p.textContent = `(${msg.votedCount}/${msg.totalCount} voted)`;
}

function updateVoteProgressText() {
  const total = net.players.length;
  const voted = Object.keys(net.votes).length;
  const p = document.getElementById("vote-progress");
  if (p) p.textContent = `(${voted}/${total} voted)`;
}

function maybeFinishVote() {
  if (net.role !== "host") return;
  if (Object.keys(net.votes).length >= net.players.length) {
    finalizeVote();
  }
}

function finalizeVote() {
  // Tally
  const tally = {};
  net.players.forEach(p => tally[p.id] = 0);
  Object.values(net.votes).forEach(v => { if (tally[v] !== undefined) tally[v]++; });
  let maxCount = -1, topIds = [];
  Object.entries(tally).forEach(([id, c]) => {
    if (c > maxCount) { maxCount = c; topIds = [id]; }
    else if (c === maxCount) topIds.push(id);
  });
  const votedOutId = (maxCount > 0 && topIds.length === 1) ? topIds[0] : null;
  const impostorCaught = votedOutId && net.impostorIds.includes(votedOutId);
  const winner = impostorCaught ? "players" : "impostor";

  const msg = {
    t: "result",
    impostorIds: net.impostorIds,
    word: net.roundWord.word,
    winner,
    votedOutId
  };
  broadcast(msg);
  showOnlineResult(msg);
}

// ============================================================
// RESULT
// ============================================================
function showOnlineResult(msg) {
  net.phase = "result";
  showScreen("online-result");
  const emoji = document.getElementById("online-result-emoji");
  const title = document.getElementById("online-result-title");
  const sub = document.getElementById("online-result-sub");
  const wordEl = document.getElementById("online-result-word");
  const list = document.getElementById("online-result-list");

  const impostorNames = msg.impostorIds
    .map(id => (net.players.find(p => p.id === id) || {}).name)
    .filter(Boolean);
  const votedOutName = msg.votedOutId
    ? (net.players.find(p => p.id === msg.votedOutId) || {}).name
    : null;

  if (msg.winner === "players") {
    emoji.textContent = "🎉";
    title.textContent = "You Win!";
    sub.textContent = `You caught ${impostorNames.join(", ")}!`;
    launchConfettiIn("online-confetti");
  } else {
    emoji.textContent = "🤫";
    title.textContent = "Impostor Wins!";
    if (votedOutName) sub.textContent = `${votedOutName} was innocent. The impostor was ${impostorNames.join(", ")}.`;
    else sub.textContent = `No one was voted out. The impostor was ${impostorNames.join(", ")}.`;
  }
  wordEl.textContent = msg.word;

  list.innerHTML = "";
  net.players.forEach((p, i) => {
    const isImp = msg.impostorIds.includes(p.id);
    const row = document.createElement("div");
    row.className = "result-row" + (isImp ? " impostor" : "");
    row.innerHTML = `
      <span>${emojiForIndex(i)}</span>
      <span>${escapeHtml(p.name)}${p.id === net.myId ? " (you)" : ""}</span>
      <span class="result-badge ${isImp ? "badge-impostor" : "badge-innocent"}">${isImp ? "Impostor" : "Innocent"}</span>
    `;
    list.appendChild(row);
  });

  // Only host sees Play Again
  document.getElementById("online-play-again").style.display = net.role === "host" ? "" : "none";
}

document.getElementById("online-play-again").addEventListener("click", () => {
  if (net.role !== "host") return;
  goLobby();
  broadcast({ t: "roster", players: net.players, max: net.maxPlayers });
});

document.getElementById("online-leave").addEventListener("click", () => {
  leaveRoom();
});

// ============================================================
// HELPERS
// ============================================================
function launchConfettiIn(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = "";
  const colors = ["#7c8cf5","#a5b4fc","#f0b678","#8fd3b3","#8bb6e0","#e0a3d1"];
  for (let i = 0; i < 60; i++) {
    const piece = document.createElement("div");
    piece.className = "confetti-piece";
    piece.style.left = Math.random() * 100 + "%";
    piece.style.background = colors[Math.floor(Math.random() * colors.length)];
    piece.style.animationDelay = (Math.random() * 1.5) + "s";
    piece.style.animationDuration = (2 + Math.random() * 2) + "s";
    piece.style.transform = `rotate(${Math.random() * 360}deg)`;
    container.appendChild(piece);
  }
  setTimeout(() => { container.innerHTML = ""; }, 5000);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[ch]));
}

// Auto-uppercase code input
document.getElementById("guest-code").addEventListener("input", (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
});

// ============================================================
// LOAD SAVED STATE ON PAGE LOAD
// ============================================================
(function restoreOnLoad() {
  const s = loadState();
  if (!s) return;
  // Prefill name inputs so users don't retype after a refresh
  if (s.name) {
    const hostInput = document.getElementById("host-name");
    const guestInput = document.getElementById("guest-name");
    if (hostInput && !hostInput.value) hostInput.value = s.name;
    if (guestInput && !guestInput.value) guestInput.value = s.name;
    net.myName = s.name;
  }
  // Offer to rejoin the last room (only if they were mid-lobby)
  if (s.roomCode && s.role === "guest" && s.name) {
    // Prefill code + name so a single tap rejoins
    const codeInput = document.getElementById("guest-code");
    if (codeInput) codeInput.value = s.roomCode;
    // Auto-navigate to join screen
    setTimeout(() => {
      if (confirm(`Rejoin room ${s.roomCode}?`)) {
        showScreen("online-join");
        document.getElementById("join-room-btn").click();
      }
    }, 200);
  } else if (s.roomCode && s.role === "host" && s.name) {
    // Host rejoin: reopen with the SAME room code (guests' connections were lost
    // but they can rejoin by entering the same code).
    setTimeout(() => {
      if (confirm(`Reopen your room ${s.roomCode}? (Other players will need to rejoin.)`)) {
        net.myName = s.name;
        net.role = "host";
        attemptCreatePeer(0, s.roomCode);
      }
    }, 200);
  }
})();

// Persist name whenever the user types it
["host-name", "guest-name"].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener("input", () => {
    net.myName = el.value.trim();
    saveState();
  });
});
