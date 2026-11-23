const http = require("http");
const express = require("express");
const path = require("path");
const { WebSocketServer } = require("ws");
const { Server, Room } = require("colyseus");
const { WebSocketTransport } = require("@colyseus/ws-transport");

class GameEngine {
  constructor(broadcastFn, sendToFn) {
    this.broadcast = broadcastFn;
    this.sendTo = sendToFn;
    this.players = {};
    this.phase = "LOBBY";
    this.turnPlayerId = "";
    this.logs = [];
    this.pendingAction = "";
    this.actorId = "";
    this.targetId = "";
    this.claimedRole = "";
    this.blockerId = "";
    this.blockedRole = "";
    this.loserPlayerId = "";
    this.loserReason = "";
    this.winnerName = "";
    this.deck = [];
    this.passedPlayers = new Set();
    this.exchangePool = [];
  }

  addLog(msg) {
    this.logs.push(msg);
    if (this.logs.length > 25) this.logs.shift();
  }

  addPlayer(id, name) {
    if (this.phase !== "LOBBY") return false;
    this.players[id] = {
      id,
      name: (name || "Igrač").substring(0, 15),
      coins: 2,
      alive: true,
      cards: []
    };
    this.addLog(`${this.players[id].name} se pridružio sobi.`);
    this.broadcastState();
    return true;
  }

  removePlayer(id) {
    const p = this.players[id];
    if (!p) return;
    this.addLog(`${p.name} je napustio igru.`);
    if (this.phase === "LOBBY") {
      delete this.players[id];
    } else {
      p.alive = false;
      p.cards.forEach(c => (c.revealed = true));
      this.checkWinCondition();
    }
    this.broadcastState();
  }

  initDeck() {
    const roles = ["Duke", "Assassin", "Captain", "Ambassador", "Contessa"];
    this.deck = [];
    for (const r of roles) {
      this.deck.push(r, r, r);
    }
    this.shuffleDeck();
  }

  shuffleDeck() {
    for (let i = this.deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
    }
  }

  startGame() {
    const ids = Object.keys(this.players);
    if (ids.length < 2) {
      this.addLog("Potrebna su bar 2 igrača za početak!");
      this.broadcastState();
      return;
    }
    this.initDeck();
    ids.forEach(id => {
      const p = this.players[id];
      p.coins = 2;
      p.alive = true;
      p.cards = [
        { role: this.deck.pop(), revealed: false },
        { role: this.deck.pop(), revealed: false }
      ];
    });
    this.turnPlayerId = ids[Math.floor(Math.random() * ids.length)];
    this.phase = "ACTION";
    this.winnerName = "";
    this.addLog("Igra je počela! Srećno blefiranje.");
    this.broadcastState();
  }

  handleMessage(clientId, msg) {
    if (msg.type === "start_game" && this.phase === "LOBBY") {
      this.startGame();
      return;
    }
    if (msg.type === "start_game" && this.phase === "GAME_OVER") {
      this.startGame();
      return;
    }

    if (msg.type === "action") {
      if (this.phase !== "ACTION" || clientId !== this.turnPlayerId) return;
      this.handleAction(clientId, msg.type === "action" ? msg.targetId : null, msg);
    } else if (msg.type === "pass") {
      if (this.phase !== "RESPONSE") return;
      const p = this.players[clientId];
      if (!p || !p.alive) return;
      this.passedPlayers.add(clientId);
      this.checkAllPassed();
    } else if (msg.type === "challenge") {
      if (this.phase !== "RESPONSE") return;
      const c = this.players[clientId];
      if (!c || !c.alive) return;
      this.handleChallenge(clientId);
    } else if (msg.type === "block") {
      if (this.phase !== "RESPONSE" || this.blockerId !== "") return;
      const b = this.players[clientId];
      if (!b || !b.alive || clientId === this.actorId) return;
      this.handleBlock(clientId, msg.role);
    } else if (msg.type === "lose_card") {
      if (this.phase !== "LOSE_INFLUENCE" || clientId !== this.loserPlayerId) return;
      this.handleLoseCard(clientId, msg.cardIndex);
    } else if (msg.type === "exchange_select") {
      if (this.phase !== "EXCHANGE" || clientId !== this.actorId) return;
      this.handleExchangeSelect(clientId, msg.keepIndices);
    }
  }

  handleAction(actorId, _unused, msg) {
    const type = msg.type === "action" ? (msg.actionType || msg.payload?.type || msg.type) : msg.type;
    const actionType = msg.type === "action" ? (arguments[2]?.type || msg.type) : type;
    const targetId = arguments[2]?.targetId || msg.targetId;
    const actor = this.players[actorId];
    const target = targetId ? this.players[targetId] : null;

    if (actor.coins >= 10 && actionType !== "COUP") {
      this.addLog(`${actor.name} ima 10+ novčića i MORA da izvede Coup!`);
      this.broadcastState();
      return;
    }

    this.resetPending();
    this.actorId = actorId;
    this.targetId = targetId || "";
    this.pendingAction = actionType;

    if (actionType === "INCOME") {
      actor.coins += 1;
      this.addLog(`${actor.name} uzima Income (+1 novčić).`);
      this.nextTurn();
    } else if (actionType === "FOREIGN_AID") {
      this.addLog(`${actor.name} traži Foreign Aid (+2 novčića). Neko blokira (Duke)?`);
      this.enterResponsePhase();
    } else if (actionType === "COUP") {
      if (actor.coins < 7 || !target || !target.alive) return;
      actor.coins -= 7;
      this.addLog(`${actor.name} izvodi COUP na ${target.name}!`);
      this.triggerLoseInfluence(targetId, "NEXT_TURN");
    } else if (actionType === "TAX") {
      this.claimedRole = "Duke";
      this.addLog(`${actor.name} tvrdi da je Duke i uzima Tax (+3 novčića).`);
      this.enterResponsePhase();
    } else if (actionType === "ASSASSINATE") {
      if (actor.coins < 3 || !target || !target.alive) return;
      actor.coins -= 3;
      this.claimedRole = "Assassin";
      this.addLog(`${actor.name} tvrdi da je Assassin i napada ${target.name}!`);
      this.enterResponsePhase();
    } else if (actionType === "STEAL") {
      if (!target || !target.alive) return;
      this.claimedRole = "Captain";
      this.addLog(`${actor.name} tvrdi da je Captain i krade od ${target.name}.`);
      this.enterResponsePhase();
    } else if (actionType === "EXCHANGE") {
      this.claimedRole = "Ambassador";
      this.addLog(`${actor.name} tvrdi da je Ambassador i menja karte.`);
      this.enterResponsePhase();
    }
    this.broadcastState();
  }

  enterResponsePhase() {
    this.phase = "RESPONSE";
    this.passedPlayers.clear();
    const activeClaimant = this.blockerId || this.actorId;
    this.passedPlayers.add(activeClaimant);
  }

  checkAllPassed() {
    const aliveCount = Object.values(this.players).filter(p => p.alive).length;
    if (this.passedPlayers.size >= aliveCount) {
      if (this.blockerId) {
        this.addLog("Blokada je uspela! Akcija je poništena.");
        this.nextTurn();
      } else {
        this.resolveAction();
      }
    }
    this.broadcastState();
  }

  handleBlock(blockerId, role) {
    const blocker = this.players[blockerId];
    const action = this.pendingAction;
    if (action === "FOREIGN_AID" && role === "Duke") {
      this.blockerId = blockerId;
      this.blockedRole = "Duke";
      this.addLog(`${blocker.name} blokira Foreign Aid kao Duke!`);
      this.enterResponsePhase();
    } else if (action === "ASSASSINATE" && blockerId === this.targetId && role === "Contessa") {
      this.blockerId = blockerId;
      this.blockedRole = "Contessa";
      this.addLog(`${blocker.name} blokira Assassinate kao Contessa!`);
      this.enterResponsePhase();
    } else if (action === "STEAL" && blockerId === this.targetId && (role === "Captain" || role === "Ambassador")) {
      this.blockerId = blockerId;
      this.blockedRole = role;
      this.addLog(`${blocker.name} blokira krađu kao ${role}!`);
      this.enterResponsePhase();
    }
    this.broadcastState();
  }

  handleChallenge(challengerId) {
    const challenger = this.players[challengerId];
    const isBlockerChallenged = this.blockerId !== "";
    const accusedId = isBlockerChallenged ? this.blockerId : this.actorId;
    const requiredRole = isBlockerChallenged ? this.blockedRole : this.claimedRole;
    const accused = this.players[accusedId];

    this.addLog(`${challenger.name} izaziva ${accused.name} ("Lažeš da imaš ${requiredRole}!")`);
    const cardIndex = accused.cards.findIndex(c => !c.revealed && c.role === requiredRole);

    if (cardIndex !== -1) {
      this.addLog(`${accused.name} pokazuje ${requiredRole}! Izazov nije uspeo.`);
      this.deck.push(accused.cards[cardIndex].role);
      this.shuffleDeck();
      accused.cards[cardIndex].role = this.deck.pop();
      const nextStep = isBlockerChallenged ? "NEXT_TURN" : "RESOLVE_ACTION";
      this.triggerLoseInfluence(challengerId, nextStep);
    } else {
      this.addLog(`${accused.name} NEMA ${requiredRole}! Uhvaćen u laži!`);
      const nextStep = isBlockerChallenged ? "RESOLVE_ACTION" : "NEXT_TURN";
      this.triggerLoseInfluence(accusedId, nextStep);
    }
    this.broadcastState();
  }

  resolveAction() {
    const actor = this.players[this.actorId];
    const target = this.targetId ? this.players[this.targetId] : null;
    const action = this.pendingAction;

    if (!actor || !actor.alive) {
      this.nextTurn();
      return;
    }

    if (action === "FOREIGN_AID") {
      actor.coins += 2;
      this.addLog(`${actor.name} dobija +2 novčića (Foreign Aid).`);
      this.nextTurn();
    } else if (action === "TAX") {
      actor.coins += 3;
      this.addLog(`${actor.name} dobija +3 novčića (Tax).`);
      this.nextTurn();
    } else if (action === "STEAL") {
      if (target && target.alive) {
        const stolen = Math.min(2, target.coins);
        target.coins -= stolen;
        actor.coins += stolen;
        this.addLog(`${actor.name} krade ${stolen} novčića od ${target.name}.`);
      }
      this.nextTurn();
    } else if (action === "ASSASSINATE") {
      if (target && target.alive) {
        this.addLog(`${target.name} gubi uticaj zbog atentata!`);
        this.triggerLoseInfluence(target.id, "NEXT_TURN");
      } else {
        this.nextTurn();
      }
    } else if (action === "EXCHANGE") {
      this.exchangePool = [];
      actor.cards.forEach(c => {
        if (!c.revealed) this.exchangePool.push(c.role);
      });
      this.exchangePool.push(this.deck.pop(), this.deck.pop());
      this.phase = "EXCHANGE";
      this.sendTo(actor.id, { type: "exchange_options", cards: this.exchangePool });
    }
  }

  handleExchangeSelect(playerId, keepIndices) {
    const player = this.players[playerId];
    const unrevealedCards = player.cards.filter(c => !c.revealed);
    if (!Array.isArray(keepIndices) || keepIndices.length !== unrevealedCards.length) return;

    const keptRoles = keepIndices.map(idx => this.exchangePool[idx]);
    this.exchangePool.forEach((role, idx) => {
      if (!keepIndices.includes(idx)) this.deck.push(role);
    });
    this.shuffleDeck();

    let k = 0;
    player.cards.forEach(c => {
      if (!c.revealed) c.role = keptRoles[k++];
    });

    this.addLog(`${player.name} je završio zamenu karata.`);
    this.nextTurn();
    this.broadcastState();
  }

  triggerLoseInfluence(playerId, afterStep) {
    const p = this.players[playerId];
    const unrevealed = p.cards.filter(c => !c.revealed);
    if (unrevealed.length <= 1) {
      p.cards.forEach(c => (c.revealed = true));
      p.alive = false;
      this.addLog(`${p.name} je eliminisan iz igre!`);
      if (!this.checkWinCondition()) {
        if (afterStep === "RESOLVE_ACTION") this.resolveAction();
        else this.nextTurn();
      }
    } else {
      this.loserPlayerId = playerId;
      this.loserReason = afterStep;
      this.phase = "LOSE_INFLUENCE";
    }
  }

  handleLoseCard(playerId, cardIndex) {
    const p = this.players[playerId];
    if (!p || !p.cards[cardIndex] || p.cards[cardIndex].revealed) return;
    p.cards[cardIndex].revealed = true;
    this.addLog(`${p.name} otkriva i gubi kartu: ${p.cards[cardIndex].role}.`);
    if (!p.cards.some(c => !c.revealed)) {
      p.alive = false;
      this.addLog(`${p.name} je eliminisan!`);
    }
    if (!this.checkWinCondition()) {
      if (this.loserReason === "RESOLVE_ACTION") this.resolveAction();
      else this.nextTurn();
    }
    this.broadcastState();
  }

  checkWinCondition() {
    const alivePlayers = Object.values(this.players).filter(p => p.alive);
    if (alivePlayers.length === 1) {
      this.winnerName = alivePlayers[0].name;
      this.phase = "GAME_OVER";
      this.addLog(`🏆 POBEDNIK JE ${this.winnerName}!`);
      return true;
    }
    return false;
  }

  nextTurn() {
    if (this.checkWinCondition()) return;
    this.resetPending();
    const ids = Object.keys(this.players);
    let currentIdx = ids.indexOf(this.turnPlayerId);
    for (let i = 1; i <= ids.length; i++) {
      const nextId = ids[(currentIdx + i) % ids.length];
      if (this.players[nextId].alive) {
        this.turnPlayerId = nextId;
        break;
      }
    }
    this.phase = "ACTION";
  }

  resetPending() {
    this.pendingAction = "";
    this.actorId = "";
    this.targetId = "";
    this.claimedRole = "";
    this.blockerId = "";
    this.blockedRole = "";
    this.loserPlayerId = "";
    this.loserReason = "";
  }

  getSanitizedState(viewerId) {
    const maskedPlayers = {};
    for (const [id, p] of Object.entries(this.players)) {
      maskedPlayers[id] = {
        id: p.id,
        name: p.name,
        coins: p.coins,
        alive: p.alive,
        cards: p.cards.map(c => ({
          revealed: c.revealed,
          role: c.revealed || id === viewerId ? c.role : "Tajna"
        }))
      };
    }
    return {
      players: maskedPlayers,
      phase: this.phase,
      turnPlayerId: this.turnPlayerId,
      logs: this.logs,
      pendingAction: this.pendingAction,
      actorId: this.actorId,
      targetId: this.targetId,
      claimedRole: this.claimedRole,
      blockerId: this.blockerId,
      blockedRole: this.blockedRole,
      loserPlayerId: this.loserPlayerId,
      winnerName: this.winnerName
    };
  }

  broadcastState() {
    this.broadcast();
  }
}

const app = express();
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const sockets = new Map();
let nextClientId = 1;

const engine = new GameEngine(
  () => {
    for (const [id, socket] of sockets.entries()) {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify({ type: "state", state: engine.getSanitizedState(id) }));
      }
    }
  },
  (targetId, payload) => {
    const socket = sockets.get(targetId);
    if (socket && socket.readyState === 1) {
      socket.send(JSON.stringify(payload));
    }
  }
);

server.on("upgrade", (request, socket, head) => {
  if (request.url && request.url.startsWith("/ws")) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      const clientId = "p_" + nextClientId++;
      const urlObj = new URL(request.url, "http://localhost");
      const name = urlObj.searchParams.get("name") || "Igrač";

      sockets.set(clientId, ws);
      ws.send(JSON.stringify({ type: "welcome", id: clientId }));

      if (!engine.addPlayer(clientId, name)) {
        ws.close();
        sockets.delete(clientId);
        return;
      }

      ws.on("message", (raw) => {
        try {
          const data = JSON.parse(raw.toString());
          engine.handleMessage(clientId, data);
        } catch (e) {}
      });

      ws.on("close", () => {
        sockets.delete(clientId);
        engine.removePlayer(clientId);
      });
    });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Coup server radi na portu ${PORT}`);
});