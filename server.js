const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

// ── Constants ──────────────────────────────────────────────
const BOTTLE_COLORS = [
  { id:'red',    name:'Vermelha',   fill:'#E24B4A', neck:'#A32D2D' },
  { id:'blue',   name:'Azul',       fill:'#378ADD', neck:'#185FA5' },
  { id:'green',  name:'Verde',      fill:'#639922', neck:'#3B6D11' },
  { id:'amber',  name:'Âmbar',      fill:'#EF9F27', neck:'#BA7517' },
  { id:'purple', name:'Roxa',       fill:'#7F77DD', neck:'#534AB7' },
  { id:'teal',   name:'Verde-água', fill:'#1D9E75', neck:'#0F6E56' },
];
const MAX_ROUND_TIME = 180;
const ALL_PHASES = ['bottles', 'penalty', 'bomberguys'];
const TEAM_COLORS = ['🔴','🔵','🟢','🟡'];
const TEAM_NAMES_DEFAULT = ['Equipe Vermelha','Equipe Azul','Equipe Verde','Equipe Amarela'];

// Bomberguys map constants
const GRID_W = 13, GRID_H = 11;
const BOMB_FUSE = 3000;  // ms
const BOMB_SPREAD = 3;   // default blast radius

// ── Sessions store ─────────────────────────────────────────
const sessions = {};

function genCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({length:6}, ()=>c[Math.floor(Math.random()*c.length)]).join('');
}

function shuffleArr(arr) {
  const a = [...arr];
  for (let i = a.length-1; i>0; i--) { const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; }
  return a;
}
function countCorrect(g,s){ return g.filter((c,i)=>c.id===s[i].id).length; }

// ── Team factory ───────────────────────────────────────────
function makeTeam(idx) {
  return {
    id:`t${idx}`, label:TEAM_NAMES_DEFAULT[idx], emoji:TEAM_COLORS[idx],
    players:[], customName:null, ready:false,
    // bottles
    phase:'idle', secret:[], guesserOrder:[],
    timeLeft:MAX_ROUND_TIME, timerInterval:null, roundDone:false,
    completionTime:null, lastHint:null,
    // penalty
    penaltyMatchId:null,
    // score
    score:0,
  };
}

// ── Session factory ────────────────────────────────────────
function makeSession(code, hostSocketId) {
  return {
    code, hostSocketId,
    phase: 'lobby',
    teams: [0,1,2,3].map(makeTeam),
    gincana: null,
  };
}

// ── Helpers ────────────────────────────────────────────────
function getSession(code){ return sessions[code?.toUpperCase()]; }
function teamChannel(code,tid){ return `${code}_${tid}`; }
function findPlayerTeam(session,sid){ return session.teams.find(t=>t.players.some(p=>p.socketId===sid)); }

function teamSummary(t){
  return {
    id:t.id, label:t.label, emoji:t.emoji, customName:t.customName,
    displayName:t.customName||t.label,
    playerCount:t.players.length, players:t.players.map(p=>({name:p.name,ready:p.ready})),
    ready:t.ready, score:t.score, phase:t.phase,
  };
}

function lobbyPayload(s){
  const readyTeams=s.teams.filter(t=>t.ready);
  return {
    code:s.code, phase:s.phase, teams:s.teams.map(teamSummary),
    readyCount:readyTeams.length,
    canStart:readyTeams.length===2||readyTeams.length===4,
    readyTeamNames:readyTeams.map(t=>t.customName||t.label),
    phaseOrder: s.gincana?.phaseOrder || null,
    currentPhaseIdx: s.gincana?.currentPhaseIdx ?? null,
  };
}

function broadcastLobby(s){ io.to(s.code).emit('lobby_update', lobbyPayload(s)); }

function emitTeamPhase(s,t){
  io.to(teamChannel(s.code,t.id)).emit('team_phase',{
    phase:t.phase,
    players:t.players.map(p=>({name:p.name,role:p.role,penaltyRole:p.penaltyRole})),
    teamName:t.customName||t.label, score:t.score,
  });
}

// ── Socket ─────────────────────────────────────────────────
io.on('connection', socket => {
  console.log(`[+] ${socket.id}`);

  socket.on('get_lobby', ({code})=>{
    const s=getSession(code); if(!s) return;
    socket.emit('lobby_update', lobbyPayload(s));
  });

  socket.on('create_session', ({playerName})=>{
    let code; do { code=genCode(); } while(sessions[code]);
    const s=makeSession(code, socket.id);
    sessions[code]=s;
    socket.join(code);
    // Emit created event with full lobby payload so host can render teams immediately
    socket.emit('session_created', { code, lobby: lobbyPayload(s) });
    console.log(`Session created: ${code} by ${playerName}`);
  });

  socket.on('join_session', ({code,playerName})=>{
    const s=getSession(code);
    if(!s){ socket.emit('err',{msg:'Sala não encontrada.'}); return; }
    if(s.phase!=='lobby'){ socket.emit('err',{msg:'Gincana já em andamento.'}); return; }
    const total=s.teams.reduce((n,t)=>n+t.players.length,0);
    if(total>=8){ socket.emit('err',{msg:'Sala cheia.'}); return; }
    socket.join(code);
    socket.emit('session_joined',{code, lobby:lobbyPayload(s)});
    broadcastLobby(s);
  });

  socket.on('choose_team', ({code,teamId,playerName})=>{
    const s=getSession(code);
    if(!s||s.phase!=='lobby') return;
    // Remove player from any team they're currently in
    for(const t of s.teams){
      const idx=t.players.findIndex(p=>p.socketId===socket.id);
      if(idx!==-1){
        t.players.splice(idx,1);
        t.ready=false;
        socket.leave(teamChannel(code,t.id));
      }
    }
    const team=s.teams.find(t=>t.id===teamId);
    if(!team){ socket.emit('err',{msg:'Equipe inválida.'}); return; }
    if(team.players.length>=2){ socket.emit('err',{msg:'Esta equipe já está completa (2/2).'}); return; }
    team.players.push({socketId:socket.id,name:playerName,role:null,penaltyRole:null,ready:false});
    socket.join(teamChannel(code,team.id));
    // Tell this socket which team they joined + full lobby state
    socket.emit('team_chosen',{ teamId, lobby: lobbyPayload(s) });
    broadcastLobby(s);
  });

  socket.on('set_team_name', ({code,teamId,name})=>{
    const s=getSession(code); if(!s) return;
    const t=s.teams.find(t=>t.id===teamId); if(!t) return;
    if(!t.players.find(p=>p.socketId===socket.id)) return;
    t.customName=name.trim()||null;
    broadcastLobby(s);
  });

  socket.on('set_ready', ({code,teamId})=>{
    const s=getSession(code); if(!s||s.phase!=='lobby') return;
    const t=s.teams.find(t=>t.id===teamId); if(!t) return;
    const p=t.players.find(p=>p.socketId===socket.id); if(!p) return;
    if(t.players.length<2){ socket.emit('err',{msg:'Aguarde seu parceiro entrar.'}); return; }
    p.ready=!p.ready;
    t.ready=t.players.length===2&&t.players.every(p=>p.ready);
    broadcastLobby(s);
  });

  socket.on('start_gincana', ({code})=>{
    const s=getSession(code); if(!s) return;
    if(socket.id!==s.hostSocketId){ socket.emit('err',{msg:'Apenas o criador pode iniciar.'}); return; }
    const readyTeams=s.teams.filter(t=>t.ready);
    if(readyTeams.length!==2&&readyTeams.length!==4){ socket.emit('err',{msg:'Precisa de 2 ou 4 equipes prontas.'}); return; }
    const phaseOrder=shuffleArr(ALL_PHASES);
    s.phase='game';
    s.gincana={
      teams:readyTeams.map(t=>t.id),
      phaseOrder, currentPhaseIdx:0,
      bottlesResults:{}, penaltyMatches:{}, matchCounter:0,
      bombersMatch:null,
    };
    readyTeams.forEach(t=>{ t.phase='waiting'; t.players.forEach(p=>{p.role=null;p.penaltyRole=null;}); });
    io.to(code).emit('gincana_started',{
      teams:readyTeams.map(t=>({id:t.id,name:t.customName||t.label,emoji:t.emoji})),
      phaseOrder,
    });
    broadcastLobby(s);
    setTimeout(()=>launchCurrentPhase(s), 1000);
  });

  // ── Phase advance ──────────────────────────────────────
  socket.on('next_phase', ({code})=>{
    const s=getSession(code); if(!s) return;
    if(socket.id!==s.hostSocketId) return;
    advancePhase(s);
  });

  // ── Bottles ────────────────────────────────────────────
  socket.on('select_role', ({code,teamId,role})=>{
    const s=getSession(code); if(!s) return;
    const t=s.teams.find(t=>t.id===teamId); if(!t||t.phase!=='roles') return;
    const p=t.players.find(p=>p.socketId===socket.id); if(!p) return;
    if(t.players.find(p=>p.socketId!==socket.id&&p.role===role)){ socket.emit('err',{msg:'Papel já escolhido.'}); return; }
    p.role=role; emitTeamPhase(s,t);
    if(t.players.length===2&&t.players.every(p=>p.role)) startBottlesRound(s,t);
  });

  socket.on('swap_bottles', ({code,teamId,fromIdx,toIdx})=>{
    const s=getSession(code); if(!s) return;
    const t=s.teams.find(t=>t.id===teamId); if(!t||t.roundDone) return;
    const p=t.players.find(p=>p.socketId===socket.id); if(!p||p.role!=='guesser') return;
    [t.guesserOrder[fromIdx],t.guesserOrder[toIdx]]=[t.guesserOrder[toIdx],t.guesserOrder[fromIdx]];
    io.to(teamChannel(code,teamId)).emit('guesser_order_update',{guesserOrder:t.guesserOrder});
  });

  socket.on('send_hint', ({code,teamId,hintValue})=>{
    const s=getSession(code); if(!s) return;
    const t=s.teams.find(t=>t.id===teamId); if(!t||t.roundDone) return;
    const p=t.players.find(p=>p.socketId===socket.id); if(!p||p.role!=='hinter') return;
    t.lastHint=hintValue;
    const guesser=t.players.find(p=>p.role==='guesser');
    if(guesser) io.to(guesser.socketId).emit('hint_received',{hintValue});
    socket.emit('hint_sent',{hintValue});
    if(hintValue===6) endBottlesRound(s,t,true);
  });

  socket.on('check_correct', ({code,teamId})=>{
    const s=getSession(code); if(!s) return;
    const t=s.teams.find(t=>t.id===teamId); if(!t) return;
    socket.emit('correct_count',{count:countCorrect(t.guesserOrder,t.secret),guesserOrder:t.guesserOrder});
  });

  // ── Penalty ────────────────────────────────────────────
  socket.on('select_penalty_role', ({code,teamId,role})=>{
    const s=getSession(code); if(!s) return;
    const t=s.teams.find(t=>t.id===teamId); if(!t) return;
    const p=t.players.find(p=>p.socketId===socket.id); if(!p) return;
    if(t.players.find(p=>p.socketId!==socket.id&&p.penaltyRole===role)){ socket.emit('err',{msg:'Papel já escolhido.'}); return; }
    p.penaltyRole=role;
    io.to(teamChannel(code,teamId)).emit('penalty_roles_update',{players:t.players.map(p=>({name:p.name,penaltyRole:p.penaltyRole}))});
    if(t.players.length===2&&t.players.every(p=>p.penaltyRole)){
      const matchId=t.penaltyMatchId;
      if(matchId){ s.gincana.penaltyMatches[matchId].rolesReady[teamId]=true; checkPenaltyRolesReady(s,matchId); }
    }
  });

  socket.on('penalty_kick', ({code,matchId,zone})=>{
    const s=getSession(code); if(!s) return;
    const m=s.gincana?.penaltyMatches?.[matchId]; if(!m||m.phase!=='kick') return;
    const t=findPlayerTeam(s,socket.id); if(!t) return;
    const p=t.players.find(p=>p.socketId===socket.id); if(!p||p.penaltyRole!=='kicker') return;
    if(m.kickingTeam!==t.id) return;
    m.currentKick=zone; m.kickerTeamId=t.id; m.phase='save';
    broadcastMatchState(s,matchId);
  });

  socket.on('penalty_save', ({code,matchId,zone})=>{
    const s=getSession(code); if(!s) return;
    const m=s.gincana?.penaltyMatches?.[matchId]; if(!m||m.phase!=='save') return;
    const t=findPlayerTeam(s,socket.id); if(!t) return;
    const p=t.players.find(p=>p.socketId===socket.id); if(!p||p.penaltyRole!=='goalkeeper') return;
    const defId=m.teamA===m.kickerTeamId?m.teamB:m.teamA;
    if(t.id!==defId) return;
    resolvePenaltyShot(s,matchId,m.currentKick,zone);
  });

  // ── Bomberguys ─────────────────────────────────────────
  socket.on('bomber_input', ({code,input})=>{
    const s=getSession(code); if(!s||!s.gincana?.bombersMatch) return;
    const bm=s.gincana.bombersMatch;
    if(bm.phase!=='playing') return;
    const pid=Object.keys(bm.players).find(k=>bm.players[k].socketId===socket.id);
    if(!pid) return;
    processBomberInput(s, pid, input);
  });

  socket.on('bomber_place_bomb', ({code})=>{
    const s=getSession(code); if(!s||!s.gincana?.bombersMatch) return;
    const bm=s.gincana.bombersMatch;
    if(bm.phase!=='playing') return;
    const pid=Object.keys(bm.players).find(k=>bm.players[k].socketId===socket.id);
    if(!pid) return;
    placeBomb(s, pid);
  });

  // ── Leave / disconnect ──────────────────────────────────
  socket.on('leave_session', ({code})=>handleLeave(socket,code));
  socket.on('disconnect', ()=>{
    console.log(`[-] ${socket.id}`);
    for(const s of Object.values(sessions)){
      if(findPlayerTeam(s,socket.id)){ handleLeave(socket,s.code); break; }
    }
  });

  function handleLeave(socket,code){
    const s=sessions[code]; if(!s) return;
    for(const t of s.teams){
      const idx=t.players.findIndex(p=>p.socketId===socket.id);
      if(idx!==-1){
        const name=t.players[idx].name; t.players.splice(idx,1); t.ready=false;
        socket.leave(teamChannel(code,t.id));
        if(['roles','bottles','penalty','bomberguys'].includes(t.phase)&&t.players.length<2){
          clearInterval(t.timerInterval); t.phase='idle';
          t.players.forEach(p=>{p.role=null;p.penaltyRole=null;p.ready=false;});
          io.to(teamChannel(code,t.id)).emit('partner_left',{name});
        }
      }
    }
    socket.leave(code);
    broadcastLobby(s);
  }
});

// ══════════════════════════════════════════════════════════
// PHASE MANAGEMENT
// ══════════════════════════════════════════════════════════
function launchCurrentPhase(s){
  const g=s.gincana; if(!g) return;
  const phase=g.phaseOrder[g.currentPhaseIdx];
  if(phase==='bottles') startAllBottles(s);
  else if(phase==='penalty') startPenaltyPhase(s);
  else if(phase==='bomberguys') startBombersPhase(s);
}

function advancePhase(s){
  const g=s.gincana; if(!g) return;
  g.currentPhaseIdx++;
  if(g.currentPhaseIdx>=g.phaseOrder.length){
    broadcastFinalRanking(s);
  } else {
    io.to(s.code).emit('phase_advance',{
      currentPhaseIdx:g.currentPhaseIdx,
      nextPhase:g.phaseOrder[g.currentPhaseIdx],
      phaseOrder:g.phaseOrder,
    });
    setTimeout(()=>launchCurrentPhase(s), 1500);
  }
}

// ══════════════════════════════════════════════════════════
// BOTTLES PHASE
// ══════════════════════════════════════════════════════════
function startAllBottles(s){
  const g=s.gincana;
  const activeTeams=g.teams.map(tid=>s.teams.find(t=>t.id===tid));
  // First tell everyone a new phase is starting (shows transition screen)
  io.to(s.code).emit('phase_started',{phase:'bottles'});
  // After 2s, send each team their role-select screen
  setTimeout(()=>{
    activeTeams.forEach(t=>{ t.phase='roles'; t.players.forEach(p=>p.role=null); emitTeamPhase(s,t); });
  }, 2000);
}

function startBottlesRound(s,t){
  t.secret=shuffleArr(BOTTLE_COLORS); t.guesserOrder=shuffleArr(BOTTLE_COLORS);
  t.roundDone=false; t.lastHint=null; t.timeLeft=MAX_ROUND_TIME; t.phase='bottles';
  clearInterval(t.timerInterval);
  const guesser=t.players.find(p=>p.role==='guesser');
  const hinter=t.players.find(p=>p.role==='hinter');
  io.to(guesser.socketId).emit('game_start',{role:'guesser',guesserOrder:t.guesserOrder});
  io.to(hinter.socketId).emit('game_start',{role:'hinter',secret:t.secret,guesserOrder:t.guesserOrder});
  t.timerInterval=setInterval(()=>{
    if(t.roundDone){clearInterval(t.timerInterval);return;}
    t.timeLeft--;
    io.to(teamChannel(s.code,t.id)).emit('timer_tick',{timeLeft:t.timeLeft});
    if(t.timeLeft<=0){clearInterval(t.timerInterval);endBottlesRound(s,t,false);}
  },1000);
}

function endBottlesRound(s,t,success){
  if(t.roundDone) return;
  t.roundDone=true; clearInterval(t.timerInterval);
  const elapsed=MAX_ROUND_TIME-t.timeLeft;
  if(success){t.completionTime=elapsed;t.score+=5;}
  const g=s.gincana;
  if(g) g.bottlesResults[t.id]={success,elapsed};
  io.to(teamChannel(s.code,t.id)).emit('round_end',{success,elapsed,secret:t.secret,guesserOrder:t.guesserOrder,score:t.score});
  t.phase='result';
  if(g){
    const allDone=g.teams.every(tid=>g.bottlesResults[tid]!==undefined);
    if(allDone){ applyBottlesBonus(s); notifyPhaseComplete(s,'bottles'); }
  }
  broadcastLobby(s);
}

function applyBottlesBonus(s){
  const g=s.gincana;
  const completed=g.teams.filter(tid=>g.bottlesResults[tid]?.success);
  completed.forEach(tid=>{s.teams.find(t=>t.id===tid).score+=5;});
  if(completed.length>1){
    const fastest=completed.reduce((a,b)=>g.bottlesResults[a].elapsed<g.bottlesResults[b].elapsed?a:b);
    s.teams.find(t=>t.id===fastest).score+=5;
  }
}

// ══════════════════════════════════════════════════════════
// PENALTY PHASE
// ══════════════════════════════════════════════════════════
function startPenaltyPhase(s){
  const g=s.gincana; if(!g) return;
  const activeTeams=g.teams.map(tid=>s.teams.find(t=>t.id===tid));
  g.penaltyMatches={}; g.matchCounter=0;
  // Show transition screen first
  io.to(s.code).emit('phase_started',{phase:'penalty'});
  // After 2s, send penalty role-select to each team
  setTimeout(()=>{
    for(let i=0;i<activeTeams.length;i+=2){
      const tA=activeTeams[i],tB=activeTeams[i+1];
      const matchId=`m${++g.matchCounter}`;
      const match={matchId,teamA:tA.id,teamB:tB.id,shots:[],goalsA:0,goalsB:0,savesA:0,savesB:0,maxShots:5,inSuddenDeath:false,phase:'role_select',rolesReady:{},kickerTeamId:null,currentKick:null,kickingTeam:tA.id,winner:null};
      g.penaltyMatches[matchId]=match;
      [tA,tB].forEach(t=>{
        t.phase='penalty'; t.penaltyMatchId=matchId; t.players.forEach(p=>p.penaltyRole=null);
        io.to(teamChannel(s.code,t.id)).emit('penalty_start',{matchId,myTeam:t.customName||t.label,opponentTeam:t===tA?tB.customName||tB.label:tA.customName||tA.label});
      });
    }
    broadcastLobby(s);
  }, 2000);
}

function checkPenaltyRolesReady(s,matchId){
  const m=s.gincana.penaltyMatches[matchId]; if(!m) return;
  const tA=s.teams.find(t=>t.id===m.teamA),tB=s.teams.find(t=>t.id===m.teamB);
  if(tA.players.length===2&&tA.players.every(p=>p.penaltyRole)&&tB.players.length===2&&tB.players.every(p=>p.penaltyRole)){
    m.phase='kick'; broadcastMatchState(s,matchId);
  }
}

function resolvePenaltyShot(s,matchId,kickZone,saveZone){
  const m=s.gincana.penaltyMatches[matchId]; if(!m) return;
  const isGoal=kickZone!==saveZone;
  const kicker=s.teams.find(t=>t.id===m.kickerTeamId);
  const defId=m.teamA===m.kickerTeamId?m.teamB:m.teamA;
  const defender=s.teams.find(t=>t.id===defId);
  if(isGoal){if(m.kickerTeamId===m.teamA)m.goalsA++;else m.goalsB++;kicker.score+=2;}
  else{if(defId===m.teamA)m.savesA++;else m.savesB++;defender.score+=2;}
  m.shots.push({kickerTeamId:m.kickerTeamId,kickZone,saveZone,goal:isGoal});
  m.phase='shot_result'; broadcastMatchState(s,matchId);
  setTimeout(()=>{
    const sA=m.shots.filter(s=>s.kickerTeamId===m.teamA).length;
    const sB=m.shots.filter(s=>s.kickerTeamId===m.teamB).length;
    if(!m.inSuddenDeath){
      if(sA<m.maxShots||sB<sA) nextPenaltyTurn(s,m);
      else if(sA===m.maxShots&&sB===m.maxShots){
        if(m.goalsA!==m.goalsB) endPenaltyMatch(s,m);
        else{m.inSuddenDeath=true;nextPenaltyTurn(s,m);}
      } else nextPenaltyTurn(s,m);
    } else {
      const base=m.maxShots*2,sd=m.shots.slice(base);
      if(sd.length%2===0&&sd.length>0){if(m.goalsA!==m.goalsB)endPenaltyMatch(s,m);else nextPenaltyTurn(s,m);}
      else nextPenaltyTurn(s,m);
    }
  },2500);
}

function nextPenaltyTurn(s,m){
  m.kickingTeam=m.shots.length%2===0?m.teamA:m.teamB;
  m.phase='kick'; m.currentKick=null; broadcastMatchState(s,m.matchId);
}

function endPenaltyMatch(s,m){
  m.phase='final'; m.winner=m.goalsA>m.goalsB?m.teamA:m.teamB;
  s.teams.find(t=>t.id===m.winner).score+=5;
  broadcastMatchState(s,m.matchId);
  const allDone=Object.values(s.gincana.penaltyMatches).every(x=>x.phase==='final');
  if(allDone) notifyPhaseComplete(s,'penalty');
}

function broadcastMatchState(s,matchId){
  const m=s.gincana.penaltyMatches[matchId]; if(!m) return;
  const tA=s.teams.find(t=>t.id===m.teamA),tB=s.teams.find(t=>t.id===m.teamB);
  const payload={matchId,phase:m.phase,shots:m.shots,goalsA:m.goalsA,goalsB:m.goalsB,savesA:m.savesA,savesB:m.savesB,maxShots:m.maxShots,inSuddenDeath:m.inSuddenDeath,kickingTeam:m.kickingTeam,winner:m.winner,kickerTeamId:m.kickerTeamId,teamA:{id:tA.id,name:tA.customName||tA.label,emoji:tA.emoji,score:tA.score},teamB:{id:tB.id,name:tB.customName||tB.label,emoji:tB.emoji,score:tB.score},players:{[tA.id]:tA.players.map(p=>({name:p.name,penaltyRole:p.penaltyRole})),[tB.id]:tB.players.map(p=>({name:p.name,penaltyRole:p.penaltyRole}))}};
  io.to(teamChannel(s.code,m.teamA)).emit('match_state',{...payload,myTeamId:m.teamA});
  io.to(teamChannel(s.code,m.teamB)).emit('match_state',{...payload,myTeamId:m.teamB});
}

// ══════════════════════════════════════════════════════════
// BOMBERGUYS PHASE
// ══════════════════════════════════════════════════════════
function buildBomberMap(){
  // 0=floor, 1=wall(solid), 2=destructible block
  const grid=[];
  for(let y=0;y<GRID_H;y++){
    grid[y]=[];
    for(let x=0;x<GRID_W;x++){
      if(x%2===1&&y%2===1) grid[y][x]=1; // solid pillars
      else grid[y][x]=0;
    }
  }
  // Spawn corners stay clear (3x3 around corners)
  const corners=[[0,0],[GRID_W-1,0],[0,GRID_H-1],[GRID_W-1,GRID_H-1]];
  // Add destructible blocks randomly
  for(let y=0;y<GRID_H;y++){
    for(let x=0;x<GRID_W;x++){
      if(grid[y][x]===1) continue;
      const nearCorner=corners.some(([cx,cy])=>Math.abs(x-cx)<=1&&Math.abs(y-cy)<=1);
      if(!nearCorner&&Math.random()<0.5) grid[y][x]=2;
    }
  }
  return grid;
}

// Bomb types
const BOMB_TYPES={
  normal:{name:'Normal',radius:3,shape:'cross',fuseMs:3000,emoji:'💣'},
  mega:  {name:'Mega',  radius:5,shape:'cross',fuseMs:3000,emoji:'💥'},
  x:     {name:'X',    radius:4,shape:'x',    fuseMs:3000,emoji:'✖'},
  remote:{name:'Remota',radius:3,shape:'cross',fuseMs:null,emoji:'📡'}, // triggered manually
  freeze:{name:'Gelo', radius:3,shape:'cross',fuseMs:3500,emoji:'❄'},   // freezes instead of killing
};

function getSpawnPositions(n){
  // top-left, top-right, bottom-left, bottom-right (sub-positions for 8 players)
  const spawns=[
    {x:0,y:0},{x:GRID_W-1,y:0},{x:0,y:GRID_H-1},{x:GRID_W-1,y:GRID_H-1},
    {x:2,y:0},{x:GRID_W-3,y:0},{x:2,y:GRID_H-1},{x:GRID_W-3,y:GRID_H-1},
  ];
  return spawns.slice(0,n);
}

function startBombersPhase(s){
  const g=s.gincana; if(!g) return;
  const activeTeams=g.teams.map(tid=>s.teams.find(t=>t.id===tid));
  const grid=buildBomberMap();
  const allPlayers=[];
  activeTeams.forEach((team)=>{
    team.players.forEach((p)=>{
      allPlayers.push({socketId:p.socketId,name:p.name,teamId:team.id});
    });
  });
  const spawns=getSpawnPositions(allPlayers.length);
  const bm={
    phase:'playing', grid, bombs:{}, nextBombId:1,
    players:{}, teamKills:{}, remoteBombs:{}, powerups:[],
  };
  g.teams.forEach(tid=>bm.teamKills[tid]=0);
  allPlayers.forEach((p,i)=>{
    const pid=`p${i}`;
    bm.players[pid]={
      socketId:p.socketId, name:p.name, teamId:p.teamId,
      x:spawns[i].x, y:spawns[i].y,
      alive:true, frozen:false, frozenUntil:0,
      bombs:1, bombType:'normal', powerups:[],
    };
  });
  g.bombersMatch=bm;
  activeTeams.forEach(t=>t.phase='bomberguys');
  // Show transition screen first
  io.to(s.code).emit('phase_started',{phase:'bomberguys'});
  // After 2s send game state so canvas renders
  setTimeout(()=>{
    broadcastBomberState(s);
    broadcastLobby(s);
  }, 2000);
}

function broadcastBomberState(s){
  const bm=s.gincana?.bombersMatch; if(!bm) return;
  const state={
    phase:bm.phase, grid:bm.grid,
    players:bm.players,
    bombs:bm.bombs,
    teamKills:bm.teamKills,
    scores:s.teams.map(t=>({id:t.id,name:t.customName||t.label,emoji:t.emoji,score:t.score})),
  };
  io.to(s.code).emit('bomber_state',state);
}

function processBomberInput(s,pid,input){
  const bm=s.gincana.bombersMatch; if(!bm) return;
  const p=bm.players[pid]; if(!p||!p.alive) return;
  const now=Date.now();
  if(p.frozen&&now<p.frozenUntil) return;
  if(p.frozen&&now>=p.frozenUntil) p.frozen=false;

  let nx=p.x,ny=p.y;
  if(input==='up')    ny--;
  else if(input==='down')  ny++;
  else if(input==='left')  nx--;
  else if(input==='right') nx++;
  else return;

  // Bounds check
  if(nx<0||nx>=GRID_W||ny<0||ny>=GRID_H) return;
  // Wall/block check
  if(bm.grid[ny][nx]===1||bm.grid[ny][nx]===2) return;
  // Bomb collision check (can't walk onto active bomb cell)
  const bombOnCell=Object.values(bm.bombs).some(b=>b.x===nx&&b.y===ny);
  if(bombOnCell) return;

  p.x=nx; p.y=ny;

  // Check powerup pick
  checkPowerupPick(s,pid,nx,ny);
  broadcastBomberState(s);
}

function placeBomb(s,pid){
  const bm=s.gincana.bombersMatch; if(!bm) return;
  const p=bm.players[pid]; if(!p||!p.alive) return;
  // Check player hasn't exceeded bomb limit
  const myBombs=Object.values(bm.bombs).filter(b=>b.placedBy===pid&&!b.exploded);
  if(myBombs.length>=p.bombs) return;

  const bombId=`b${bm.nextBombId++}`;
  const type=bm.bombType||'normal';
  const bt=BOMB_TYPES[type];
  const bomb={
    id:bombId, x:p.x, y:p.y,
    type, radius:bt.radius, shape:bt.shape,
    placedBy:pid, teamId:p.teamId,
    placedAt:Date.now(), fuseMs:bt.fuseMs,
    exploded:false, freeze:type==='freeze',
  };
  bm.bombs[bombId]=bomb;
  broadcastBomberState(s);

  if(bt.fuseMs){
    setTimeout(()=>explodeBomb(s,bombId), bt.fuseMs);
  } else {
    // Remote bomb — store for manual trigger
    if(!bm.remoteBombs[pid]) bm.remoteBombs[pid]=[];
    bm.remoteBombs[pid].push(bombId);
  }
}

function explodeBomb(s,bombId){
  const bm=s.gincana?.bombersMatch; if(!bm) return;
  const bomb=bm.bombs[bombId]; if(!bomb||bomb.exploded) return;
  bomb.exploded=true;

  const blastCells=getBlastCells(bm.grid, bomb.x, bomb.y, bomb.radius, bomb.shape);
  const destroyed=[]; // destructible blocks destroyed
  const hit=[]; // players hit

  blastCells.forEach(({x,y})=>{
    if(bm.grid[y][x]===2){ bm.grid[y][x]=0; destroyed.push({x,y}); }
  });

  // Check players in blast
  Object.entries(bm.players).forEach(([pid2,p2])=>{
    if(!p2.alive) return;
    const inBlast=blastCells.some(c=>c.x===p2.x&&c.y===p2.y);
    if(!inBlast) return;
    if(bomb.freeze){
      p2.frozen=true; p2.frozenUntil=Date.now()+3000;
      hit.push({pid:pid2,effect:'frozen'});
    } else {
      p2.alive=false;
      hit.push({pid:pid2,effect:'eliminated'});
      // Score: +3 to bomber's team (unless friendly fire)
      if(p2.teamId!==bomb.teamId){
        const bomberTeam=s.teams.find(t=>t.id===bomb.teamId);
        if(bomberTeam){ bomberTeam.score+=3; bm.teamKills[bomb.teamId]=(bm.teamKills[bomb.teamId]||0)+1; }
      }
    }
  });

  // Chain reaction — explode other bombs in blast cells
  Object.values(bm.bombs).forEach(b2=>{
    if(b2.id!==bombId&&!b2.exploded&&blastCells.some(c=>c.x===b2.x&&c.y===b2.y)){
      setTimeout(()=>explodeBomb(s,b2.id), 200);
    }
  });

  io.to(s.code).emit('bomber_explosion',{bombId,blastCells,destroyed,hit,grid:bm.grid});
  broadcastBomberState(s);

  // Check win condition
  checkBomberWin(s);
}

function getBlastCells(grid,bx,by,radius,shape){
  const cells=[{x:bx,y:by}];
  const dirs=shape==='cross'
    ?[[1,0],[-1,0],[0,1],[0,-1]]
    :[[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]; // X shape

  dirs.forEach(([dx,dy])=>{
    for(let r=1;r<=radius;r++){
      const x=bx+dx*r, y=by+dy*r;
      if(x<0||x>=GRID_W||y<0||y>=GRID_H) break;
      cells.push({x,y});
      if(grid[y][x]===1) break; // solid wall stops blast
      if(grid[y][x]===2) break; // destructible stops after destroying
    }
  });
  return cells;
}

function checkPowerupPick(s,pid,x,y){
  const bm=s.gincana.bombersMatch; if(!bm) return;
  const p=bm.players[pid];
  // Powerups: stored in bm.powerups as {x,y,type}
  if(!bm.powerups) return;
  const idx=bm.powerups.findIndex(pu=>pu.x===x&&pu.y===y);
  if(idx===-1) return;
  const pu=bm.powerups.splice(idx,1)[0];
  if(pu.type==='extra_bomb') p.bombs=Math.min(p.bombs+1,3);
  else if(pu.type==='bomb_type') p.bombType=pu.bombSubtype||'mega';
  io.to(p.socketId).emit('powerup_collected',{type:pu.type,subtype:pu.bombSubtype});
}

function checkBomberWin(s){
  const bm=s.gincana?.bombersMatch; if(!bm||bm.phase!=='playing') return;
  const g=s.gincana;
  const activeTeams=g.teams.map(tid=>s.teams.find(t=>t.id===tid));
  const teamsAlive=activeTeams.filter(t=>
    Object.values(bm.players).some(p=>p.teamId===t.id&&p.alive)
  );
  if(teamsAlive.length<=1){
    bm.phase='done';
    const winner=teamsAlive[0]||null;
    io.to(s.code).emit('bomber_done',{
      winner:winner?{id:winner.id,name:winner.customName||winner.label,emoji:winner.emoji}:null,
      teamKills:bm.teamKills,
      scores:s.teams.map(t=>({id:t.id,name:t.customName||t.label,emoji:t.emoji,score:t.score})),
    });
    notifyPhaseComplete(s,'bomberguys');
  }
}

// ── Phase complete notification ────────────────────────────
function notifyPhaseComplete(s,phase){
  const g=s.gincana; if(!g) return;
  const isLast=g.currentPhaseIdx===g.phaseOrder.length-1;
  io.to(s.code).emit('phase_complete',{
    phase,
    phaseOrder:g.phaseOrder,
    currentPhaseIdx:g.currentPhaseIdx,
    isLast,
    scores:s.teams.map(t=>({id:t.id,name:t.customName||t.label,emoji:t.emoji,score:t.score})),
  });
}

// ── Final ranking ─────────────────────────────────────────
function broadcastFinalRanking(s){
  const g=s.gincana;
  const ranking=s.teams
    .filter(t=>g?.teams.includes(t.id))
    .map(t=>({name:t.customName||t.label,emoji:t.emoji,score:t.score,id:t.id}))
    .sort((a,b)=>b.score-a.score);
  io.to(s.code).emit('final_ranking',{ranking});
  s.phase='done';
  setTimeout(()=>{ delete sessions[s.code]; }, 120000);
}

// ── Health ─────────────────────────────────────────────────
app.get('/health',(_,res)=>res.json({ok:true,sessions:Object.keys(sessions).length}));
const PORT=process.env.PORT||3001;
server.listen(PORT,()=>console.log(`Ginka v4 porta ${PORT}`));
