// server.js – Quiz "100 Leute gefragt" – Team-Style (Neustart v1.0)
// Features:
// - 5 Kategorien × 5 Felder (10–50 Punkte), pro Feld 5 Antworten mit Prozenten (Top→Bottom)
// - Teams: Rot (A) & Blau (B), je 2 Spieler (beliebig viele unterstützt)
// - Team-Chat (privat pro Team), Admin sieht beide Chats live
// - Spiel-Flow: aktives Team wählt Feld → rät per Texteingabe
//   · pro Team max 3 Falschantworten; nach 2 Falschen bekommt Gegenteam Hinweis zu beraten
//   · nach 3 Falschen Turnover (Gegenteam am Zug)
//   · findet Gegenteam die restlichen korrekten Antworten → Volle Punktzahl an Gegenteam
//   · scheitert Gegenteam ebenfalls (3× falsch) → Punkte an das Team, das die TOP-Antwort (höchste %) gefunden hat
// - Admin kann alle Antworten/Prozente sehen, Antworten manuell aufdecken, Feld schließen, Punkte vergeben
// - Sounds: correct/wrong Broadcast-Events

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
      // Top → Bottom
      it.answers.sort((x,y)=> (y.percent - x.percent));
      it.points   = Number(it.points)||10;
      it.q        = it.q || '';
      it.revealed = false;
      it.answered = false;
      it.meta = {
        originalTeam: null, // Team, das Feld gewählt hat
        turnTeam: null,     // Team, das aktuell rät
        wrongA: 0,
        wrongB: 0
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
  activePlayer: null,     // optional (nicht zwingend genutzt)
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
        // Antworten nur sichtbar, wenn revealed
        answers: it.answers.map(a=>({
          text:     a.revealed ? a.text    : '',
          percent:  a.revealed ? a.percent : 0,
          revealed: a.revealed
        }))
      }))
    }))
  };
}

function adminBoard(){ return state.board; } // Admin sieht alles

function playersList(){
  return Object.values(state.players).map(p=>({
    id: p.id, name: p.name, team: p.team, score: p.score
  }));
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

function fieldWinnerOnDoubleFail(item){
  // Beide Teams 3x falsch → Punkte an Team, das die TOP-Antwort gefunden hat
  const top = item.answers[0];
  return top.byTeam || item.meta.originalTeam; // Fallback
}

function awardTeamPoints(team, points){
  const members = Object.values(state.players).filter(p=>p.team===team);
  if (members.length===0) return;
  const per = Math.floor(points / members.length) || points; // falls 1 Spieler: volle Punkte
  members.forEach(m=>{
    m.score += per;
    io.emit('score:update', { playerId:m.id, score:m.score, delta:per });
  });
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
// Socket.IO
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

    io.emit('tile:revealed', { catIndex,itemIndex, question:item.q, points:item.points, turnTeam:item.meta.turnTeam });
    emitState();
  });

  // Antwort eines Teams
  socket.on('player:guess', ({ catIndex, itemIndex, guess }) => {
    const p = state.players[socket.id]; if (!p) return;
    const cat = state.board.categories[catIndex]; if (!cat) return;
    const item = cat.items[itemIndex]; if (!item || !item.revealed || item.answered) return;

    if (p.team !== item.meta.turnTeam) return; // nur Team am Zug

    const idx = matchAnswer(item, guess);
    if (idx >= 0){
      // korrekt
      item.answers[idx].revealed = true;
      item.answers[idx].byTeam   = p.team;
      io.emit('sfx:correct');
      io.emit('answer:revealed', { catIndex,itemIndex, index:idx, text:item.answers[idx].text, percent:item.answers[idx].percent, byTeam:p.team });

      if (allFound(item)){
        // letzte richtige Antwort → volles Feld an dieses Team
        awardTeamPoints(p.team, item.points);
        closeField(catIndex,itemIndex,p.team,'all-found');
      } else {
        emitState();
      }
      return;
    }

    // falsch
    io.emit('sfx:wrong');
    if (item.meta.turnTeam === 'A') item.meta.wrongA++; else item.meta.wrongB++;

    const wrongs = item.meta.turnTeam === 'A' ? item.meta.wrongA : item.meta.wrongB;
    io.emit('guess:wrong', { catIndex,itemIndex, team:item.meta.turnTeam, wrongs });

    if (wrongs === 2){
      // Hinweis an Gegenseite: beraten
      const next = otherTeam(item.meta.turnTeam);
      io.to('team-'+next).emit('team:prepare', { catIndex,itemIndex, note:'Ihr dürft euch jetzt im Team-Chat beraten – ihr seid vermutlich gleich am Zug.' });
    }
    if (wrongs >= 3){
      // Turnover
      const next = otherTeam(item.meta.turnTeam);
      item.meta.turnTeam = next;
      io.emit('turn:changed', { catIndex,itemIndex, turnTeam: next });
    }
  });

  // Admin: Antwort manuell aufdecken
  socket.on('admin:revealAnswer', ({ catIndex,itemIndex, index }) => {
    const item = state.board.categories[catIndex]?.items[itemIndex]; if (!item) return;
    const a = item.answers[index]; if (!a || a.revealed) return;
    a.revealed = true; a.byTeam = null; // manuell
    io.emit('answer:revealed', { catIndex,itemIndex, index, text:a.text, percent:a.percent, byTeam:null });
    if (allFound(item)){
      // alles sichtbar → Default: Punkte an Originalteam
      awardTeamPoints(item.meta.originalTeam || 'A', item.points);
      closeField(catIndex,itemIndex,(item.meta.originalTeam||'A'),'admin-full-reveal');
    } else {
      emitState();
    }
  });

  // Admin: Feld schließen (Zeit abgelaufen etc.)
  socket.on('admin:forceClose', ({ catIndex,itemIndex }) => {
    const item = state.board.categories[catIndex]?.items[itemIndex]; if (!item) return;
    if (item.answered) return;

    // Gewinnerlogik bei Abbruch:
    // - beide Teams 3x falsch → Team mit TOP-Antwort
    // - wenn Gegenteam gerade am Zug (Steal) und scheitert → Originalteam
    const aDone = (item.meta.wrongA >= 3);
    const bDone = (item.meta.wrongB >= 3);

    let winner = null;
    if (aDone && bDone){
      winner = fieldWinnerOnDoubleFail(item);
    } else if (item.meta.turnTeam !== item.meta.originalTeam){
      winner = item.meta.originalTeam; // Steal misslungen
    } else {
      winner = item.meta.originalTeam; // Fallback
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

// ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Quiz-Server läuft auf Port', PORT));
