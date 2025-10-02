// server.js – Quiz "100 Leute gefragt" – Team-Style (Neustart v1.3)
// NEUES PUNKTESYSTEM (Abstauber-Regel):
// - Team am Zug muss das Feld KOMPLETT lösen → volle Punktzahl.
// - Nach 3 falschen Antworten dieses Teams beginnt die Abstauber-Runde:
//     · Das andere Team hat GENAU EINE CHANCE.
//     · Bei richtiger Antwort (egal wie viele Antworten noch offen sind): volle Punktzahl an Abstauber-Team.
//     · Bei falscher Antwort: volle Punktzahl an das ursprüngliche Team (das vorher dran war).
// - Admin deckt Antworten manuell auf; Tipp-Eingaben sind optional möglich.
// - Zusätze: Startteam auslosen, Nächste Runde (Startteam wechseln), Fallback-Sounds, Team-Chats, etc.

import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.json());

// ─────────────────────────────────────────────────────────────
// SFX-Fallback (vermeidet 416-Logs bei leeren/fehlenden MP3s)
// ─────────────────────────────────────────────────────────────
const SILENCE_WAV_BASE64 =
  "UklGRl4RAABXQVZFZm10IBAAAAABAAEAIlYAAESsAAACABAAZGF0YToRAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

function sendSfxOrSilent(name, res) {
  const p = path.join(__dirname, "public", "sfx", name);
  try {
    const st = fs.statSync(p);
    if (st.isFile() && st.size > 0) {
      return res.sendFile(p);
    }
  } catch (_) { /* ignore */ }
  res.set("Content-Type", "audio/wav");
  res.set("Cache-Control", "public, max-age=86400");
  return res.end(Buffer.from(SILENCE_WAV_BASE64, "base64"));
}

// Vor static:
app.get("/sfx/correct.mp3", (_req, res) => sendSfxOrSilent("correct.mp3", res));
app.get("/sfx/wrong.mp3",   (_req, res) => sendSfxOrSilent("wrong.mp3", res));

app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req,res)=>res.status(200).type('text').send('OK'));

// ─────────────────────────────────────────────────────────────
// Daten laden / normalisieren
// ─────────────────────────────────────────────────────────────
const DATA_PATH = path.join(__dirname, 'public', 'fragen.json');

function loadData(){
  const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  raw.categories.forEach(cat=>{
    cat.items.forEach(it=>{
      it.answers = (it.answers||[]).slice(0,5).map(a=>{
        const obj = typeof a === 'string' ? { text:a, percent:0 } : a;
        return {
          text: obj.text || '',
          percent: Number(obj.percent)||0,
          alts: Array.isArray(obj.alts) ? obj.alts : [],
          revealed: false,
          byTeam: null // 'A'|'B'
        };
      });
      it.answers.sort((x,y)=> (y.percent - x.percent)); // Top → Bottom
      it.points   = Number(it.points)||10;
      it.q        = it.q || '';
      it.revealed = false;
      it.answered = false;
      it.meta = {
        originalTeam: null, // Team, das Feld gewählt hat (und komplett lösen muss)
        turnTeam: null,     // Team, das aktuell rät
        wrongA: 0,
        wrongB: 0,
        stealActive: false, // Abstauberphase aktiv?
        stealTeam: null,    // Team, das die 1 Chance hat
        stealUsed: false    // Sicherheit: wurde die 1 Chance bereits verbraucht?
      };
    });
  });
  return raw;
}

let db = loadData();

// ─────────────────────────────────────────────────────────────
// Globaler State
// ─────────────────────────────────────────────────────────────
const state = {
  players: {},            // socketId -> { id,name,team:'A'|'B', score }
  board: db,              // Daten aus fragen.json
  activePlayer: null,     // optional
  turnTeam: null          // globaler Start-Turn, pro Feld in item.meta.turnTeam
};

// ─────────────────────────────────────────────────────────────
// Helper
// ─────────────────────────────────────────────────────────────
function publicBoard(){
  return {
    categories: state.board.categories.map(c=>({
      name: c.name,
      items: c.items.map(it=>({
        points:   it.points,
        revealed: it.revealed,
        answered: it.answered,
        answers: it.answers.map(a=>({
          text:     a.revealed ? a.text    : '',
          percent:  a.revealed ? a.percent : 0,
          revealed: a.revealed
        }))
      }))
    }))
  };
}
function adminBoard(){ return state.board; }
function playersList(){
  return Object.values(state.players).map(p=>({ id:p.id, name:p.name, team:p.team, score:p.score }));
}
function emitState(){
  io.emit('state:update', { board: publicBoard(), players: playersList(), activePlayer: state.activePlayer });
  io.to('admins').emit('state:admin', { board: adminBoard(), players: playersList(), activePlayer: state.activePlayer });
}
function otherTeam(t){ return t==='A' ? 'B' : 'A'; }
function sanitize(s){ return String(s||'').trim().toLowerCase(); }
function allFound(item){ return item.answers.every(a=>a.revealed); }

function matchAnswer(item, guess){
  const g = sanitize(guess);
  for (let i=0;i<item.answers.length;i++){
    const a = item.answers[i];
    if (a.revealed) continue;
    const pool = [a.text, ...(a.alts||[])].map(sanitize);
    if (pool.includes(g)) return i; // Index
  }
  return -1;
}

function awardTeamPoints(team, points){
  const members = Object.values(state.players).filter(p=>p.team===team);
  if (members.length===0) return;
  const per = Math.floor(points / members.length) || points; // bei 1 Spieler: volle Punkte
  members.forEach(m=>{
    m.score += per;
    io.emit('score:update', { playerId:m.id, score:m.score, delta:per });
  });
}

function startStealPhase(item){
  item.meta.stealActive = true;
  item.meta.stealTeam   = otherTeam(item.meta.turnTeam);
  item.meta.stealUsed   = false;
  item.meta.turnTeam    = item.meta.stealTeam; // Anzeige: Abstauber-Team ist am Zug
  io.emit('turn:changed', { turnTeam: item.meta.turnTeam });
}

function endStealWithResult(catIndex,itemIndex,item, wasCorrect){
  // Genau EINE Chance: Feld wird sofort beendet
  item.meta.stealUsed = true;
  const winner = wasCorrect ? (item.meta.stealTeam || otherTeam(item.meta.originalTeam))
                            : (item.meta.originalTeam || otherTeam(item.meta.turnTeam||'A'));
  awardTeamPoints(winner, item.points);
  // alle Antworten sichtbar machen für die Anzeige
  item.answers.forEach(a => a.revealed = true);
  item.answered = true;
  item.revealed = true;
  io.emit('tile:closed', { catIndex,itemIndex,winnerTeam:winner,reason: wasCorrect?'steal-correct':'steal-wrong' });
  emitState();
}

function closeField(catIndex,itemIndex,winnerTeam,reason){
  const item = state.board.categories[catIndex].items[itemIndex];
  item.answered = true;
  item.revealed = true;
  item.answers.forEach(a=> a.revealed = true); // alle Antworten sichtbar
  io.emit('tile:closed', { catIndex,itemIndex,winnerTeam,reason });
  emitState();
}

// ─────────────────────────────────────────────────────────────
io.on('connection', socket => {
  // Rollen
  socket.on('role:admin', () => {
    socket.join('admins');
    socket.emit('state:admin', { board: adminBoard(), players: playersList(), activePlayer: state.activePlayer });
  });
  socket.on('role:player', () => { /* noop */ });

  // Spieler beitreten
  socket.on('player:join', ({ name, team }) => {
    const clean = String(name||'').trim().slice(0,24) || 'Spieler';
    const t = (team === 'B') ? 'B' : 'A';
    state.players[socket.id] = { id:socket.id, name:clean, team:t, score:0 };
    socket.join('team-'+t);
    socket.emit('welcome', { id:socket.id, name:clean, team:t });
    socket.emit('board:init', publicBoard());
    emitState();
  });

  // Team-Chat (privat; Admin sieht beide)
  socket.on('chat:team', ({ msg }) => {
    const p = state.players[socket.id]; if (!p) return;
    const payload = { from:{ id:p.id, name:p.name, team:p.team }, msg:String(msg||'').slice(0,400), ts:Date.now() };
    io.to('team-'+p.team).emit('chat:team', payload);
    io.to('admins').emit('chat:spy', payload);
  });

  // Startteam auslosen (Admin)
  socket.on('admin:drawStartTeam', () => {
    const start = Math.random() < 0.5 ? 'A' : 'B';
    state.turnTeam = start;
    io.emit('turn:global', { team:start });
  });

  // Nächste Runde (Admin) – wechselt Startteam und broadcastet neuen globalen Zug
  socket.on('admin:nextRound', () => {
    const curr = state.turnTeam || 'A';
    const next = curr === 'A' ? 'B' : 'A';
    state.turnTeam = next;
    io.emit('turn:global', { team: next });
  });

  // Feld wählen (nur Team am Zug)
  socket.on('player:pickTile', ({ catIndex, itemIndex }) => {
    const p = state.players[socket.id]; if (!p) return;
    const cat = state.board.categories[catIndex]; if (!cat) return;
    const item = cat.items[itemIndex]; if (!item || item.revealed || item.answered) return;

    const teamAtTurn = state.turnTeam || p.team; // falls noch nicht ausgelost
    if (p.team !== teamAtTurn) return;

    item.revealed = true;
    item.meta.originalTeam = p.team;
    item.meta.turnTeam     = p.team;
    item.meta.wrongA = 0; item.meta.wrongB = 0;
    item.meta.stealActive = false;
    item.meta.stealTeam   = null;
    item.meta.stealUsed   = false;

    io.emit('tile:revealed', { catIndex,itemIndex, question:item.q, points:item.points, turnTeam:item.meta.turnTeam });
    emitState();
  });

  // Optionales Tippen (für beide Phasen). Standard: Admin deckt manuell auf.
  socket.on('player:guess', ({ catIndex, itemIndex, guess }) => {
    const p = state.players[socket.id]; if (!p) return;
    const cat = state.board.categories[catIndex]; if (!cat) return;
    const item = cat.items[itemIndex]; if (!item || !item.revealed || item.answered) return;

    // Steal-Phase: genau 1 Versuch
    if (item.meta.stealActive){
      if (p.team !== item.meta.stealTeam) return; // nur Abstauber-Team
      const idx = matchAnswer(item, guess);
      if (idx >= 0){
        // richtig → Punkte an Steal-Team, sofort zu
        item.answers[idx].revealed = true;
        item.answers[idx].byTeam   = p.team;
        io.emit('sfx:correct');
        io.emit('answer:revealed', { catIndex,itemIndex, index:idx, text:item.answers[idx].text, percent:item.answers[idx].percent, byTeam:p.team });
        endStealWithResult(catIndex,itemIndex,item,true);
        return;
      } else {
        // falsch → Punkte an Originalteam, zu
        io.emit('sfx:wrong');
        endStealWithResult(catIndex,itemIndex,item,false);
        return;
      }
    }

    // Normale Phase (Team muss ALLE finden)
    if (p.team !== item.meta.turnTeam) return; // nur Team am Zug

    const idx = matchAnswer(item, guess);
    if (idx >= 0){
      item.answers[idx].revealed = true;
      item.answers[idx].byTeam   = p.team;
      io.emit('sfx:correct');
      io.emit('answer:revealed', { catIndex,itemIndex, index:idx, text:item.answers[idx].text, percent:item.answers[idx].percent, byTeam:p.team });

      if (allFound(item)){
        awardTeamPoints(item.meta.originalTeam || p.team, item.points); // nur wenn komplett
        closeField(catIndex,itemIndex,(item.meta.originalTeam||p.team),'all-found');
      } else {
        emitState();
      }
      return;
    }

    // falsch in der normalen Phase
    io.emit('sfx:wrong');
    if (item.meta.turnTeam === 'A') item.meta.wrongA++; else item.meta.wrongB++;
    const wrongs = (item.meta.turnTeam === 'A') ? item.meta.wrongA : item.meta.wrongB;

    io.emit('guess:wrong', { catIndex,itemIndex, team:item.meta.turnTeam, wrongs });

    if (wrongs === 2){
      const next = otherTeam(item.meta.turnTeam);
      io.to('team-'+next).emit('team:prepare', { catIndex,itemIndex, note:'Ihr dürft euch jetzt im Team-Chat beraten – Abstauber-Chance ist nah.' });
    }
    if (wrongs >= 3){
      // Abstauber-Phase starten (1 Chance)
      startStealPhase(item);
    }

    emitState();
  });

  // Admin: Antwort manuell aufdecken
  socket.on('admin:revealAnswer', ({ catIndex,itemIndex, index }) => {
    const item = state.board.categories[catIndex]?.items[itemIndex]; if (!item) return;
    const a = item.answers[index]; if (!a || a.revealed) return;

    // In beiden Phasen: "byTeam" dem aktuell bewerteten Team zuordnen (für Historie)
    const currentTeam = item.meta.stealActive
      ? (item.meta.stealTeam || otherTeam(item.meta.originalTeam||'A'))
      : (item.meta.turnTeam   || state.turnTeam || item.meta.originalTeam);

    a.revealed = true;
    a.byTeam   = currentTeam || null;
    io.emit('answer:revealed', { catIndex,itemIndex, index, text:a.text, percent:a.percent, byTeam:a.byTeam });

    if (item.meta.stealActive){
      // Abstauber-Regel: 1 richtige Antwort reicht → sofort Punkte an Steal-Team
      endStealWithResult(catIndex,itemIndex,item,true);
      return;
    } else {
      // Normale Phase: erst bei ALLEN Antworten Punkte an Originalteam
      if (allFound(item)){
        const winner = item.meta.originalTeam || currentTeam || 'A';
        awardTeamPoints(winner, item.points);
        closeField(catIndex,itemIndex,winner,'admin-full-reveal');
        return;
      }
      emitState();
    }
  });

  // Admin – als falsch werten
  socket.on('admin:markWrong', ({ catIndex, itemIndex }) => {
    const cat  = state.board.categories[catIndex]; if (!cat) return;
    const item = cat.items[itemIndex];              if (!item || !item.revealed || item.answered) return;

    // In Steal-Phase: falsche Antwort ⇒ Punkte an Originalteam, sofort zu
    if (item.meta.stealActive){
      io.emit('sfx:wrong');
      endStealWithResult(catIndex,itemIndex,item,false);
      return;
    }

    // Normale Phase: Fehlversuche zählen
    const team = item.meta.turnTeam || state.turnTeam || item.meta.originalTeam || 'A';
    io.emit('sfx:wrong');

    if (team === 'A') item.meta.wrongA++; else item.meta.wrongB++;
    const wrongs = (team === 'A') ? item.meta.wrongA : item.meta.wrongB;
    io.emit('guess:wrong', { catIndex, itemIndex, team, wrongs });

    if (wrongs === 2){
      const next = otherTeam(team);
      io.to('team-'+next).emit('team:prepare', { catIndex, itemIndex, note:'Ihr dürft euch beraten – Abstauber-Chance ist nah.' });
    }
    if (wrongs >= 3){
      // Abstauber-Phase starten
      startStealPhase(item);
    }

    emitState();
  });

  // Admin: Feld schließen (Zeit abgelaufen etc.)
  socket.on('admin:forceClose', ({ catIndex,itemIndex }) => {
    const item = state.board.categories[catIndex]?.items[itemIndex]; if (!item) return;
    if (item.answered) return;

    // Neues Regelwerk: Wenn Steal aktiv und keine Antwort gegeben wurde → Default an Originalteam.
    let winner = item.meta.originalTeam || 'A';
    if (item.meta.stealActive && item.meta.stealUsed === true){
      // sollte nie passieren, da endStealWithResult das Feld schließt
    }

    awardTeamPoints(winner, item.points);
    closeField(catIndex,itemIndex,winner,'force-close');
  });

  // Admin: Punkte direkt an Spieler
  socket.on('admin:awardPoints', ({ playerId, points }) => {
    const p = state.players[playerId]; if (!p) return;
    const val = Number(points)||0;
    p.score += val;
    io.emit('score:update', { playerId:p.id, score:p.score, delta:val });
    emitState();
  });

  // Disconnect
  socket.on('disconnect', () => {
    delete state.players[socket.id];
    if (state.activePlayer === socket.id) state.activePlayer = null;
    emitState();
  });
});

// Optional: 416 sauber schlucken (falls doch irgendwo auftritt)
app.use((err, req, res, next) => {
  if (err && (err.status === 416 || err.statusCode === 416)) {
    return res.status(204).end();
  }
  return next(err);
});

// ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Quiz-Server läuft auf Port', PORT));
