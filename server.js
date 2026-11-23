const http = require("http");
const express = require("express");
const path = require("path");
const { Server, Room } = require("colyseus");
const { Schema, MapSchema, ArraySchema, defineTypes } = require("@colyseus/schema");

// --- DEFINICIJA STANJA (STATE) ---
class Card extends Schema {
  constructor(role, revealed = false) {
    super();
    this.role = role;
    this.revealed = revealed;
  }
}
defineTypes(Card, {
  role: "string",
  revealed: "boolean"
});

class Player extends Schema {
  constructor(id, name) {
    super();
    this.id = id;
    this.name = name;
    this.coins = 2;
    this.alive = true;
    this.cards = new ArraySchema();
  }
}
defineTypes(Player, {
  id: "string",
  name: "string",
  coins: "number",
  alive: "boolean",
  cards: [Card]
});

class CoupState extends Schema {
  constructor() {
    super();
    this.players = new MapSchema();
    this.phase = "LOBBY"; // LOBBY, ACTION, RESPONSE, LOSE_INFLUENCE, EXCHANGE, GAME_OVER
    this.turnPlayerId = "";
    this.logs = new ArraySchema();
    
    // Trenutna akcija na stolu
    this.pendingAction = "";
    this.actorId = "";
    this.targetId = "";
    this.claimedRole = "";
    this.blockerId = "";
    this.blockedRole = "";
    this.loserPlayerId = "";
    this.loserReason = "";
    this.winnerName = "";
  }
}
defineTypes(CoupState, {
  players: { map: Player },
  phase: "string",
  turnPlayerId: "string",
  logs: ["string"],
  pendingAction: "string",
  actorId: "string",
  targetId: "string",
  claimedRole: "string",
  blockerId: "string",
  blockedRole: "string",
  loserPlayerId: "string",
  loserReason: "string",
  winnerName: "string"
});

// --- SOBA ZA IGRU ---
class CoupRoom extends Room {
  onCreate() {
    this.setState(new CoupState());
    this.deck = [];
    this.passedPlayers = new Set();
    this.exchangePool = [];

    this.onMessage("start_game", (client) => {
      if (this.state.phase !== "LOBBY") return;
      if (this.state.players.size < 2) {
        this.addLog("Potrebna su bar 2 igrača za početak!");
        return;
      }
      this.startGame();
    });

    this.onMessage("action", (client, data) => {
      if (this.state.phase !== "ACTION" || client.sessionId !== this.state.turnPlayerId) return;
      this.handleAction(client.sessionId, data.type, data.targetId);
    });

    this.onMessage("pass", (client) => {
      if (this.state.phase !== "RESPONSE") return;
      const p = this.state.players.get(client.sessionId);
      if (!p || !p.alive) return;

      this.passedPlayers.add(client.sessionId);
      this.checkAllPassed();
    });

    this.onMessage("challenge", (client) => {
      if (this.state.phase !== "RESPONSE") return;
      const challenger = this.state.players.get(client.sessionId);
      if (!challenger || !challenger.alive) return;
      this.handleChallenge(client.sessionId);
    });

    this.onMessage("block", (client, data) => {
      if (this.state.phase !== "RESPONSE" || this.state.blockerId !== "") return;
      const blocker = this.state.players.get(client.sessionId);
      if (!blocker || !blocker.alive || client.sessionId === this.state.actorId) return;
      this.handleBlock(client.sessionId, data.role);
    });

    this.onMessage("lose_card", (client, data) => {
      if (this.state.phase !== "LOSE_INFLUENCE" || client.sessionId !== this.state.loserPlayerId) return;
      this.handleLoseCard(client.sessionId, data.cardIndex);
    });

    this.onMessage("exchange_select", (client, data) => {
      if (this.state.phase !== "EXCHANGE" || client.sessionId !== this.state.actorId) return;
      this.handleExchangeSelect(client.sessionId, data.keepIndices);
    });
  }

  onJoin(client, options) {
    if (this.state.phase !== "LOBBY") {
      throw new Error("Igra je već u toku!");
    }
    const name = (options.name || "Igrač").substring(0, 15);
    const player = new Player(client.sessionId, name);
    this.state.players.set(client.sessionId, player);
    this.addLog(`${name} se pridružio sobi.`);
  }

  onLeave(client) {
    const p = this.state.players.get(client.sessionId);
    if (p) {
      this.addLog(`${p.name} je napustio igru.`);
      if (this.state.phase === "LOBBY") {
        this.state.players.delete(client.sessionId);
      } else {
        p.alive = false;
        p.cards.forEach(c => c.revealed = true);
        this.checkWinCondition();
      }
    }
  }

  addLog(msg) {
    this.state.logs.push(msg);
    if (this.state.logs.length > 25) this.state.logs.shift();
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
    this.initDeck();
    const ids = Array.from(this.state.players.keys());
    ids.forEach(id => {
      const p = this.state.players.get(id);
      p.coins = 2;
      p.alive = true;
      p.cards.clear();
      p.cards.push(new Card(this.deck.pop(), false));
      p.cards.push(new Card(this.deck.pop(), false));
    });

    this.state.turnPlayerId = ids[Math.floor(Math.random() * ids.length)];
    this.state.phase = "ACTION";
    this.addLog("Igra je počela! Srećno blefiranje.");
  }

  handleAction(actorId, type, targetId) {
    const actor = this.state.players.get(actorId);
    const target = targetId ? this.state.players.get(targetId) : null;

    if (actor.coins >= 10 && type !== "COUP") {
      this.addLog(`${actor.name} ima 10+ novčića i MORA da izvede Coup!`);
      return;
    }

    this.resetPending();
    this.state.actorId = actorId;
    this.state.targetId = targetId || "";
    this.state.pendingAction = type;

    if (type === "INCOME") {
      actor.coins += 1;
      this.addLog(`${actor.name} uzima Income (+1 novčić).`);
      this.nextTurn();
    } else if (type === "FOREIGN_AID") {
      this.addLog(`${actor.name} traži Foreign Aid (+2 novčića). Neko blokira (Duke)?`);
      this.enterResponsePhase();
    } else if (type === "COUP") {
      if (actor.coins < 7 || !target || !target.alive) return;
      actor.coins -= 7;
      this.addLog(`${actor.name} izvodi COUP na ${target.name}!`);
      this.triggerLoseInfluence(targetId, "NEXT_TURN");
    } else if (type === "TAX") {
      this.state.claimedRole = "Duke";
      this.addLog(`${actor.name} tvrdi da je Duke i uzima Tax (+3 novčića).`);
      this.enterResponsePhase();
    } else if (type === "ASSASSINATE") {
      if (actor.coins < 3 || !target || !target.alive) return;
      actor.coins -= 3;
      this.state.claimedRole = "Assassin";
      this.addLog(`${actor.name} tvrdi da je Assassin i napada ${target.name}!`);
      this.enterResponsePhase();
    } else if (type === "STEAL") {
      if (!target || !target.alive) return;
      this.state.claimedRole = "Captain";
      this.addLog(`${actor.name} tvrdi da je Captain i krade od ${target.name}.`);
      this.enterResponsePhase();
    } else if (type === "EXCHANGE") {
      this.state.claimedRole = "Ambassador";
      this.addLog(`${actor.name} tvrdi da je Ambassador i menja karte.`);
      this.enterResponsePhase();
    }
  }

  enterResponsePhase() {
    this.state.phase = "RESPONSE";
    this.passedPlayers.clear();
    const activeClaimant = this.state.blockerId || this.state.actorId;
    this.passedPlayers.add(activeClaimant);
  }

  checkAllPassed() {
    let aliveCount = 0;
    this.state.players.forEach((p, id) => {
      if (p.alive) aliveCount++;
    });

    if (this.passedPlayers.size >= aliveCount) {
      if (this.state.blockerId) {
        this.addLog("Blokada je uspela! Akcija je poništena.");
        this.nextTurn();
      } else {
        this.resolveAction();
      }
    }
  }

  handleBlock(blockerId, role) {
    const blocker = this.state.players.get(blockerId);
    const action = this.state.pendingAction;

    if (action === "FOREIGN_AID" && role === "Duke") {
      this.state.blockerId = blockerId;
      this.state.blockedRole = "Duke";
      this.addLog(`${blocker.name} blokira Foreign Aid kao Duke!`);
      this.enterResponsePhase();
    } else if (action === "ASSASSINATE" && blockerId === this.state.targetId && role === "Contessa") {
      this.state.blockerId = blockerId;
      this.state.blockedRole = "Contessa";
      this.addLog(`${blocker.name} blokira Assassinate kao Contessa!`);
      this.enterResponsePhase();
    } else if (action === "STEAL" && blockerId === this.state.targetId && (role === "Captain" || role === "Ambassador")) {
      this.state.blockerId = blockerId;
      this.state.blockedRole = role;
      this.addLog(`${blocker.name} blokira krađu kao ${role}!`);
      this.enterResponsePhase();
    }
  }

  handleChallenge(challengerId) {
    const challenger = this.state.players.get(challengerId);
    const isBlockerChallenged = this.state.blockerId !== "";
    const accusedId = isBlockerChallenged ? this.state.blockerId : this.state.actorId;
    const requiredRole = isBlockerChallenged ? this.state.blockedRole : this.state.claimedRole;
    const accused = this.state.players.get(accusedId);

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
  }

  resolveAction() {
    const actor = this.state.players.get(this.state.actorId);
    const target = this.state.targetId ? this.state.players.get(this.state.targetId) : null;
    const action = this.state.pendingAction;

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
      this.state.phase = "EXCHANGE";
      this.clients.forEach(c => {
        if (c.sessionId === actor.id) {
          c.send("exchange_options", { cards: this.exchangePool });
        }
      });
    }
  }

  handleExchangeSelect(playerId, keepIndices) {
    const player = this.state.players.get(playerId);
    const unrevealedCards = player.cards.filter(c => !c.revealed);
    if (!Array.isArray(keepIndices) || keepIndices.length !== unrevealedCards.length) return;

    const keptRoles = keepIndices.map(idx => this.exchangePool[idx]);
    this.exchangePool.forEach((role, idx) => {
      if (!keepIndices.includes(idx)) this.deck.push(role);
    });
    this.shuffleDeck();

    let k = 0;
    player.cards.forEach(c => {
      if (!c.revealed) {
        c.role = keptRoles[k++];
      }
    });

    this.addLog(`${player.name} je završio zamenu karata.`);
    this.nextTurn();
  }

  triggerLoseInfluence(playerId, afterStep) {
    const p = this.state.players.get(playerId);
    const unrevealed = p.cards.filter(c => !c.revealed);
    if (unrevealed.length <= 1) {
      p.cards.forEach(c => c.revealed = true);
      p.alive = false;
      this.addLog(`${p.name} je eliminisan iz igre!`);
      if (!this.checkWinCondition()) {
        if (afterStep === "RESOLVE_ACTION") this.resolveAction();
        else this.nextTurn();
      }
    } else {
      this.state.loserPlayerId = playerId;
      this.state.loserReason = afterStep;
      this.state.phase = "LOSE_INFLUENCE";
    }
  }

  handleLoseCard(playerId, cardIndex) {
    const p = this.state.players.get(playerId);
    if (!p || !p.cards[cardIndex] || p.cards[cardIndex].revealed) return;

    p.cards[cardIndex].revealed = true;
    this.addLog(`${p.name} otkriva i gubi kartu: ${p.cards[cardIndex].role}.`);

    const stillAlive = p.cards.some(c => !c.revealed);
    if (!stillAlive) {
      p.alive = false;
      this.addLog(`${p.name} je eliminisan!`);
    }

    if (!this.checkWinCondition()) {
      const nextStep = this.state.loserReason;
      if (nextStep === "RESOLVE_ACTION") this.resolveAction();
      else this.nextTurn();
    }
  }

  checkWinCondition() {
    const alivePlayers = [];
    this.state.players.forEach(p => {
      if (p.alive) alivePlayers.push(p);
    });

    if (alivePlayers.length === 1) {
      this.state.winnerName = alivePlayers[0].name;
      this.state.phase = "GAME_OVER";
      this.addLog(`🏆 POBEDNIK JE ${this.state.winnerName}!`);
      return true;
    }
    return false;
  }

  nextTurn() {
    if (this.checkWinCondition()) return;
    this.resetPending();
    const ids = Array.from(this.state.players.keys());
    let currentIdx = ids.indexOf(this.state.turnPlayerId);

    for (let i = 1; i <= ids.length; i++) {
      const nextId = ids[(currentIdx + i) % ids.length];
      if (this.state.players.get(nextId).alive) {
        this.state.turnPlayerId = nextId;
        break;
      }
    }
    this.state.phase = "ACTION";
  }

  resetPending() {
    this.state.pendingAction = "";
    this.state.actorId = "";
    this.state.targetId = "";
    this.state.claimedRole = "";
    this.state.blockerId = "";
    this.state.blockedRole = "";
    this.state.loserPlayerId = "";
    this.state.loserReason = "";
  }
}

// --- POKRETANJE SERVERA ---
const app = express();
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const gameServer = new Server({ server });

gameServer.define("coup_room", CoupRoom);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Coup server radi na portu ${PORT}`);
});
