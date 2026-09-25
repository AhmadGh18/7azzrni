// ============================================================
// Who's the Impostor? — Game Logic
// ============================================================

const state = {
  categoryId: null,
  playerCount: 4,
  impostorCount: 1,
  difficulty: "medium",          // "medium" | "hard"
  players: [],                   // [{name}]
  wordEntry: null,               // { word, hint }
  impostorIndices: [],           // indices of impostors
  currentPassIndex: 0,
  timerSeconds: 90,
  timerRemaining: 90,
  timerRunning: false,
  timerInterval: null,
  votedIndex: null
};

// ============================================================
// SCREEN NAVIGATION
// ============================================================
function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  const el = document.getElementById("screen-" + id);
  if (el) el.classList.add("active");
  window.scrollTo(0, 0);
}

document.addEventListener("click", (e) => {
  const target = e.target.closest("[data-go]");
  if (target) {
    const dest = target.getAttribute("data-go");
    if (dest === "home" && state.timerInterval) {
      clearInterval(state.timerInterval);
      state.timerInterval = null;
    }
    showScreen(dest);
  }
});

// ============================================================
// SETUP SCREEN
// ============================================================
function renderCategoryGrid() {
  const grid = document.getElementById("category-grid");
  grid.innerHTML = "";
  CATEGORIES.forEach((c, i) => {
    const btn = document.createElement("button");
    btn.className = "cat-card" + (state.categoryId === c.id ? " selected" : "");
    btn.innerHTML = `<span class="cat-emoji">${c.emoji}</span><span class="cat-name">${c.name}</span>`;
    btn.addEventListener("click", () => {
      state.categoryId = c.id;
      renderCategoryGrid();
    });
    grid.appendChild(btn);
  });
  // Auto-select first category if none
  if (!state.categoryId && CATEGORIES.length) {
    state.categoryId = CATEGORIES[0].id;
    renderCategoryGrid();
  }
}

function updateStepper() {
  document.getElementById("players-value").textContent = state.playerCount;
  document.getElementById("impostors-value").textContent = state.impostorCount;

  document.getElementById("players-minus").disabled = state.playerCount <= 3;
  document.getElementById("players-plus").disabled = state.playerCount >= 15;
  document.getElementById("impostors-minus").disabled = state.impostorCount <= 1;
  // Impostors can't be more than players - 2 (need at least 2 innocents)
  const maxImp = Math.max(1, state.playerCount - 2);
  document.getElementById("impostors-plus").disabled = state.impostorCount >= maxImp;

  if (state.impostorCount > maxImp) {
    state.impostorCount = maxImp;
    document.getElementById("impostors-value").textContent = state.impostorCount;
  }
}

document.getElementById("players-minus").addEventListener("click", () => {
  if (state.playerCount > 3) { state.playerCount--; updateStepper(); }
});
document.getElementById("players-plus").addEventListener("click", () => {
  if (state.playerCount < 15) { state.playerCount++; updateStepper(); }
});
document.getElementById("impostors-minus").addEventListener("click", () => {
  if (state.impostorCount > 1) { state.impostorCount--; updateStepper(); }
});
document.getElementById("impostors-plus").addEventListener("click", () => {
  const maxImp = Math.max(1, state.playerCount - 2);
  if (state.impostorCount < maxImp) { state.impostorCount++; updateStepper(); }
});

document.querySelectorAll("#difficulty-seg .seg-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#difficulty-seg .seg-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    state.difficulty = btn.getAttribute("data-diff");
  });
});

document.getElementById("to-names").addEventListener("click", () => {
  renderNames();
  showScreen("names");
});

// ============================================================
// NAMES SCREEN
// ============================================================
function renderNames() {
  // Preserve any existing names when player count changes
  const existing = state.players.map(p => p.name);
  state.players = [];
  for (let i = 0; i < state.playerCount; i++) {
    state.players.push({ name: existing[i] || "" });
  }

  const list = document.getElementById("names-list");
  list.innerHTML = "";
  for (let i = 0; i < state.playerCount; i++) {
    const row = document.createElement("div");
    row.className = "name-row";
    row.innerHTML = `
      <div class="name-num">${i + 1}</div>
      <input type="text" class="name-input" placeholder="Player ${i + 1}" value="${state.players[i].name}" maxlength="20" />
    `;
    const input = row.querySelector("input");
    input.addEventListener("input", (e) => {
      state.players[i].name = e.target.value.trim();
    });
    list.appendChild(row);
  }
}

document.getElementById("start-game").addEventListener("click", () => {
  // Fill in any empty names
  state.players.forEach((p, i) => {
    if (!p.name) p.name = `Player ${i + 1}`;
  });
  startRound();
  showScreen("pass");
});

// ============================================================
// GAME LOGIC
// ============================================================
function pickCategory() {
  return CATEGORIES.find(c => c.id === state.categoryId) || CATEGORIES[0];
}

function pickWord(category) {
  const w = category.words[Math.floor(Math.random() * category.words.length)];
  if (typeof w === "string") {
    const hints = category.genericHints || ["A hint"];
    return { word: w, hint: hints[Math.floor(Math.random() * hints.length)] };
  }
  return w;
}

function pickImpostors(playerCount, impostorCount) {
  const indices = [...Array(playerCount).keys()];
  // Fisher-Yates shuffle
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices.slice(0, impostorCount).sort((a, b) => a - b);
}

function startRound() {
  const cat = pickCategory();
  state.wordEntry = pickWord(cat);
  state.impostorIndices = pickImpostors(state.playerCount, state.impostorCount);
  state.currentPassIndex = 0;
  state.votedIndex = null;
  renderPass();
}

function renderPass() {
  const p = state.players[state.currentPassIndex];
  document.getElementById("pass-name").textContent = p.name;
  document.getElementById("pass-counter").textContent =
    `Player ${state.currentPassIndex + 1} of ${state.playerCount}`;
}

document.getElementById("reveal-btn").addEventListener("click", () => {
  renderReveal();
  showScreen("reveal");
});

function renderReveal() {
  const idx = state.currentPassIndex;
  const isImpostor = state.impostorIndices.includes(idx);
  const card = document.getElementById("reveal-card");
  const roleEl = document.getElementById("reveal-role");
  const wordEl = document.getElementById("reveal-word");
  const hintEl = document.getElementById("reveal-hint");

  card.classList.toggle("impostor", isImpostor);

  if (isImpostor) {
    roleEl.textContent = "You are the";
    wordEl.textContent = "IMPOSTOR 🤫";
    if (state.difficulty === "medium") {
      hintEl.textContent = `Hint: ${state.wordEntry.hint}`;
    } else {
      hintEl.textContent = "";
    }
  } else {
    roleEl.textContent = "Your word is";
    wordEl.textContent = state.wordEntry.word;
    hintEl.textContent = "";
  }
}

document.getElementById("reveal-next").addEventListener("click", () => {
  state.currentPassIndex++;
  if (state.currentPassIndex >= state.playerCount) {
    // Everyone has seen — go to discussion
    startTimer();
    showScreen("discuss");
  } else {
    renderPass();
    showScreen("pass");
  }
});

// ============================================================
// TIMER (Discussion)
// ============================================================
function startTimer() {
  state.timerRemaining = state.timerSeconds;
  state.timerRunning = true;
  updateTimerUI();
  if (state.timerInterval) clearInterval(state.timerInterval);
  state.timerInterval = setInterval(tickTimer, 1000);
  document.getElementById("timer-toggle").textContent = "Pause";
}

function tickTimer() {
  if (!state.timerRunning) return;
  state.timerRemaining--;
  if (state.timerRemaining <= 0) {
    state.timerRemaining = 0;
    state.timerRunning = false;
    clearInterval(state.timerInterval);
    state.timerInterval = null;
    document.getElementById("timer-toggle").textContent = "Start";
  }
  updateTimerUI();
}

function updateTimerUI() {
  const m = Math.floor(state.timerRemaining / 60).toString().padStart(2, "0");
  const s = (state.timerRemaining % 60).toString().padStart(2, "0");
  document.getElementById("timer-text").textContent = `${m}:${s}`;

  const circumference = 2 * Math.PI * 52; // ~326.7
  const pct = state.timerRemaining / state.timerSeconds;
  const offset = circumference * (1 - pct);
  const fill = document.getElementById("timer-fill");
  fill.style.strokeDashoffset = offset;
  fill.classList.toggle("warn", pct <= 0.3 && pct > 0.1);
  fill.classList.toggle("danger", pct <= 0.1);
}

document.getElementById("timer-toggle").addEventListener("click", () => {
  if (state.timerRemaining <= 0) {
    startTimer();
    return;
  }
  state.timerRunning = !state.timerRunning;
  document.getElementById("timer-toggle").textContent = state.timerRunning ? "Pause" : "Start";
  if (state.timerRunning && !state.timerInterval) {
    state.timerInterval = setInterval(tickTimer, 1000);
  }
});

document.getElementById("timer-reset").addEventListener("click", () => {
  startTimer();
});

document.getElementById("back-to-home").addEventListener("click", () => {
  if (state.timerInterval) { clearInterval(state.timerInterval); state.timerInterval = null; }
  showScreen("home");
});

// ============================================================
// VOTE SCREEN
// ============================================================
document.getElementById("to-vote").addEventListener("click", () => {
  if (state.timerInterval) { clearInterval(state.timerInterval); state.timerInterval = null; }
  renderVote();
  showScreen("vote");
});

function renderVote() {
  const grid = document.getElementById("vote-grid");
  grid.innerHTML = "";
  state.players.forEach((p, i) => {
    const btn = document.createElement("button");
    btn.className = "vote-card" + (state.votedIndex === i ? " selected" : "");
    btn.innerHTML = `<span class="vote-emoji">${emojiForIndex(i)}</span>${p.name}`;
    btn.addEventListener("click", () => {
      state.votedIndex = i;
      showResult();
    });
    grid.appendChild(btn);
  });
}

const emojiPool = ["😀","😎","🤠","🥸","🤓","😺","🐵","🐨","🦊","🐼","🦁","🐯","🦄","🐸","🐷","🐔"];
function emojiForIndex(i) { return emojiPool[i % emojiPool.length]; }

document.getElementById("skip-vote").addEventListener("click", () => {
  state.votedIndex = null;
  showResult();
});

// ============================================================
// RESULT SCREEN
// ============================================================
function showResult() {
  const impostorNames = state.impostorIndices.map(i => state.players[i].name);
  const isCorrectGuess = state.votedIndex !== null && state.impostorIndices.includes(state.votedIndex);

  const emoji = document.getElementById("result-emoji");
  const title = document.getElementById("result-title");
  const sub = document.getElementById("result-sub");

  if (state.votedIndex === null) {
    emoji.textContent = "🎭";
    title.textContent = "Reveal!";
    sub.textContent = "Here's who was who.";
  } else if (isCorrectGuess) {
    emoji.textContent = "🎉";
    title.textContent = "Caught!";
    sub.textContent = `You caught ${state.players[state.votedIndex].name}! Nice work.`;
    launchConfetti();
  } else {
    emoji.textContent = "🤫";
    title.textContent = "The Impostor Wins!";
    const votedName = state.players[state.votedIndex].name;
    sub.textContent = `${votedName} was innocent. The real impostor got away!`;
  }

  document.getElementById("result-word").textContent = state.wordEntry.word;

  const list = document.getElementById("result-list");
  list.innerHTML = "";
  state.players.forEach((p, i) => {
    const isImp = state.impostorIndices.includes(i);
    const row = document.createElement("div");
    row.className = "result-row" + (isImp ? " impostor" : "");
    row.innerHTML = `
      <span>${emojiForIndex(i)}</span>
      <span>${p.name}</span>
      <span class="result-badge ${isImp ? "badge-impostor" : "badge-innocent"}">${isImp ? "Impostor" : "Innocent"}</span>
    `;
    list.appendChild(row);
  });

  showScreen("result");
}

function launchConfetti() {
  const container = document.getElementById("confetti");
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

// ============================================================
// PLAY AGAIN
// ============================================================
document.getElementById("play-again").addEventListener("click", () => {
  startRound();
  showScreen("pass");
});

// ============================================================
// INIT
// ============================================================
function init() {
  renderCategoryGrid();
  updateStepper();
}
init();
