/*
 * Règles métier de la billetterie Red Star (billets pour les clebards).
 * Module pur (aucun accès réseau ni DOM) : utilisable dans le navigateur
 * (window.RedStarRules) et dans Node (require('./rules.js')).
 *
 * Principe : chaque match a un journal d'actions horodatées par le serveur.
 * L'état du match est recalculé en rejouant ce journal dans l'ordre. Une action
 * contraire aux règles au moment où elle arrive est ignorée (et signalée).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RedStarRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var QUOTA = 4;
  var PRICE = 8;
  var STADIUM = 'Stade Bauer';

  // ---------- Noms ----------

  function cleanName(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  function normalizeName(s) {
    return cleanName(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function findMemberByName(members, name) {
    var key = normalizeName(name);
    if (!key) return null;
    for (var i = 0; i < members.length; i++) {
      if (normalizeName(members[i].name) === key) return members[i];
    }
    return null;
  }

  function validateNewName(members, name) {
    var n = cleanName(name);
    if (!n) return 'Indique un prénom.';
    if (n.length > 40) return 'Nom trop long (40 caractères maximum).';
    if (!normalizeName(n)) return 'Nom invalide.';
    var existing = findMemberByName(members, n);
    if (existing) return '« ' + existing.name + ' » existe déjà. Ajoute une initiale, par exemple « ' + n + ' B. ».';
    return null;
  }

  // ---------- Dates (heure de Paris) ----------

  function lastSundayUtc(year, month) {
    var last = new Date(Date.UTC(year, month + 1, 0));
    return Date.UTC(year, month, last.getUTCDate() - last.getUTCDay(), 1, 0);
  }

  /** "2026-11-20", "20:00" (heure de Paris) -> millisecondes UTC, ou null. */
  function parisToMs(dateStr, timeStr) {
    var d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').trim());
    if (!d) return null;
    var h = 0, mi = 0;
    if (timeStr) {
      var t = /^(\d{1,2})\s*[:hH]\s*(\d{2})?$/.exec(String(timeStr).trim());
      if (!t) return null;
      h = +t[1]; mi = t[2] ? +t[2] : 0;
      if (h > 23 || mi > 59) return null;
    }
    var y = +d[1], mo = +d[2] - 1, day = +d[3];
    var utc = Date.UTC(y, mo, day, h, mi) - 3600000;
    if (utc >= lastSundayUtc(y, 2) && utc < lastSundayUtc(y, 9)) utc -= 3600000;
    return utc;
  }

  function normalizeTime(timeStr) {
    var t = /^(\d{1,2})\s*[:hH]\s*(\d{2})?$/.exec(String(timeStr || '').trim());
    if (!t) return '';
    return ('0' + t[1]).slice(-2) + ':' + (t[2] || '00');
  }

  /** Coup d'envoi ; heure inconnue = fin de journée (23 h 59). */
  function kickoffMs(match) {
    return parisToMs(match.date, normalizeTime(match.time) || '23:59');
  }

  /** Ouverture de la billetterie, stockée "AAAA-MM-JJ HH:MM" (heure de Paris). */
  function openingMs(match) {
    var s = String(match.opening || '').trim();
    if (!s) return null;
    var p = s.split(/[ T]/);
    return parisToMs(p[0], p[1] || '00:00');
  }

  var DAYS = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];
  var MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

  function formatDateFr(dateStr, withYear) {
    var d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
    if (!d) return dateStr || '';
    var dt = new Date(Date.UTC(+d[1], +d[2] - 1, +d[3]));
    return DAYS[dt.getUTCDay()] + ' ' + (+d[3]) + ' ' + MONTHS[+d[2] - 1] + (withYear ? ' ' + d[1] : '');
  }

  function formatTimeFr(timeStr) {
    var t = normalizeTime(timeStr);
    if (!t) return '';
    var p = t.split(':');
    return (+p[0]) + ' h' + (p[1] === '00' ? '' : ' ' + p[1]);
  }

  function formatMatchWhen(match) {
    var t = formatTimeFr(match.time);
    return formatDateFr(match.date) + (t ? ', ' + t : ' (heure à confirmer)');
  }

  function formatOpeningFr(opening) {
    var s = String(opening || '').trim();
    if (!s) return '';
    var p = s.split(/[ T]/);
    return formatDateFr(p[0]) + ' à ' + formatTimeFr(p[1] || '00:00');
  }

  // ---------- Valeurs ----------

  function truthy(v) {
    return v === true || v === 1 || v === '1' || /^(true|vrai|oui|x)$/i.test(String(v || '').trim());
  }

  // ---------- État d'un match ----------

  function indexMembers(members) {
    var byId = {};
    (members || []).forEach(function (m) { byId[m.id] = m; });
    return byId;
  }

  function newState(match, members) {
    return {
      match: match,
      members: indexMembers(members),
      opening: openingMs(match),
      kickoff: kickoffMs(match),
      frozen: false,
      closed: false,
      regs: [],          // inscriptions actives, dans l'ordre d'inscription
      confirms: {},      // abonnéId -> { ts, order } : a déclaré des places (ordre de première déclaration)
      absent: {},        // abonnéId -> true : déclaré non présent
      extra: {},         // abonnéId -> places achetées pour d'autres (0 à 4) ; sa place d'abonné est en plus
      pins: {},          // personneId -> { subId, ts, order } : déplacement manuel
      alloc: null,       // répartition calculée (avant l'ouverture)
      seats: [],         // places figées (après l'ouverture)
      waitlist: [],      // liste d'attente figée (après l'ouverture)
      replacements: [],  // historique des remplacements (après l'ouverture)
      rejected: []
    };
  }

  function isSub(st, id) {
    var m = st.members[id];
    return !!m && m.type === 'abonne';
  }

  function nameOf(st, id) {
    var m = st.members[id];
    return m ? m.name : '(inconnu)';
  }

  function byTime(a, b) { return (a.ts - b.ts) || (a.order - b.order); }

  function confirmedSubs(st) {
    return Object.keys(st.confirms)
      .map(function (id) { return { id: id, ts: st.confirms[id].ts, order: st.confirms[id].order }; })
      .sort(byTime)
      .map(function (x) { return x.id; });
  }

  function regIndex(st, id) {
    for (var i = 0; i < st.regs.length; i++) if (st.regs[i].memberId === id) return i;
    return -1;
  }

  /**
   * Répartition avant l'ouverture (recalculée après chaque action).
   * Chaque abonné qui a déclaré a une place d'abonné (la sienne, déjà acquise) et
   * 0 à 4 places achetées. S'il est absent, sa place d'abonné est prêtée sans achat.
   */
  function recompute(st) {
    var subs = confirmedSubs(st);
    var cap = {}, rem = {}, purch = {}, assign = {}, season = {}, total = 0;
    subs.forEach(function (s) {
      cap[s] = st.extra[s] || 0;
      rem[s] = cap[s];
      purch[s] = [];
    });

    // 0. Invités nommés par un abonné : toujours sur une place achetée par cet abonné.
    st.regs.forEach(function (r) {
      if (r.personal && st.confirms[r.personal] && rem[r.personal] > 0) {
        assign[r.memberId] = r.personal;
        rem[r.personal]--;
        purch[r.personal].push({ memberId: r.memberId, ts: r.ts, personal: true });
      }
    });
    subs.forEach(function (s) { total += rem[s]; });
    var lenders = subs.filter(function (s) { return st.absent[s]; });

    var candidates = st.regs.filter(function (r) { return !st.confirms[r.memberId] && !assign[r.memberId]; });
    var served = candidates.slice(0, total + lenders.length);
    var waitlist = candidates.slice(total + lenders.length).map(function (r) { return r.memberId; });
    var servedSet = {};
    served.forEach(function (r) { servedSet[r.memberId] = true; });

    // 1. Épingles, de la plus ancienne à la plus récente : la plus récente saute en premier.
    Object.keys(st.pins)
      .map(function (id) { var p = st.pins[id]; return { memberId: id, subId: p.subId, ts: p.ts, order: p.order }; })
      .sort(byTime)
      .forEach(function (p) {
        if (!st.confirms[p.subId] || rem[p.subId] <= 0) { delete st.pins[p.memberId]; return; }
        if (!servedSet[p.memberId]) return;
        assign[p.memberId] = p.subId;
        rem[p.subId]--;
      });

    // 2. Places d'abonné prêtées : aux dernières demandes servies, c'est-à-dire aux
    //    plus anciennes en attente quand les places achetées sont pleines.
    var holders = [];
    for (var k = served.length - 1; k >= 0 && holders.length < lenders.length; k--) {
      if (!assign[served[k].memberId]) holders.unshift(served[k]);
    }
    holders.forEach(function (r, i) {
      assign[r.memberId] = lenders[i];
      season[r.memberId] = true;
    });

    // 3. Chez l'abonné qui a inscrit la personne, s'il a encore des places à acheter.
    served.forEach(function (r) {
      if (assign[r.memberId]) return;
      if (r.by !== r.memberId && st.confirms[r.by] && rem[r.by] > 0) {
        assign[r.memberId] = r.by;
        rem[r.by]--;
      }
    });
    // 4. Sinon chez l'abonné qui a le plus de places restantes (égalité : premier à avoir déclaré).
    served.forEach(function (r) {
      if (assign[r.memberId]) return;
      var best = null;
      subs.forEach(function (s) { if (rem[s] > 0 && (best === null || rem[s] > rem[best])) best = s; });
      assign[r.memberId] = best;
      rem[best]--;
    });
    served.forEach(function (r) {
      if (!season[r.memberId]) purch[assign[r.memberId]].push({ memberId: r.memberId, ts: r.ts, pinned: !!st.pins[r.memberId] });
    });

    var bySub = {};
    subs.forEach(function (s) {
      var seat;
      if (!st.absent[s]) seat = { memberId: s, own: true, season: true };
      else {
        var h = holders[lenders.indexOf(s)];
        seat = { memberId: h ? h.memberId : null, own: false, season: true, ts: h ? h.ts : null };
      }
      bySub[s] = [seat].concat(purch[s]);
    });

    st.alloc = { subs: subs, cap: cap, rem: rem, bySub: bySub, assign: assign, season: season, waitlist: waitlist };
  }

  function freeze(st, ts) {
    if (!st.alloc) recompute(st);
    var a = st.alloc;
    st.seats = [];
    a.subs.forEach(function (s) {
      a.bySub[s].forEach(function (x, i) {
        st.seats.push({
          id: s + ':' + (i + 1), subId: s, occupant: x.memberId, own: !!x.own, season: !!x.season, personal: !!x.personal,
          since: x.own || !x.memberId ? ts : x.ts, bought: false, paid: false, refunded: false
        });
      });
    });
    st.waitlist = a.waitlist.slice();
    st.frozen = true;
    st.frozenAt = ts;
  }

  function advanceTime(st, t) {
    if (!st.frozen && st.opening !== null && t >= st.opening) freeze(st, st.opening);
    if (!st.closed && st.kickoff !== null && t >= st.kickoff) {
      if (!st.frozen) freeze(st, st.kickoff);
      st.closed = true;
    }
  }

  function seatById(st, id) {
    for (var i = 0; i < st.seats.length; i++) if (st.seats[i].id === id) return st.seats[i];
    return null;
  }

  function seatOf(st, memberId) {
    for (var i = 0; i < st.seats.length; i++) if (st.seats[i].occupant === memberId) return st.seats[i];
    return null;
  }

  /** Libère une place après l'ouverture : la plus ancienne personne en attente la reprend, chez le même abonné. */
  function releaseSeat(st, seat, ev, reason) {
    var from = seat.occupant;
    var fromPaid = seat.paid && from !== seat.subId && !seat.season;
    seat.own = false;
    var next = st.waitlist.length ? st.waitlist.shift() : null;
    seat.occupant = next;
    seat.personal = false;
    seat.paid = false;
    seat.since = ev.ts;
    st.replacements.push({
      ts: ev.ts, seatId: seat.id, subId: seat.subId, fromId: from, toId: next,
      bought: seat.bought, season: !!seat.season, fromPaid: fromPaid, reason: reason || 'desistement'
    });
  }

  function seatsOfSub(st, subId) {
    return st.seats.filter(function (x) { return x.subId === subId; });
  }

  var PRE_ONLY_MSG = {
    register: 'La billetterie est ouverte : plus de nouvelle demande. Prends une place libre s\'il y en a.',
    confirm: 'La billetterie est ouverte : la liste des acheteurs est figée.',
    unconfirm: 'La billetterie est ouverte : la liste des acheteurs est figée.',
    move: 'La billetterie est ouverte : les déplacements sont arrêtés.',
    addGuest: 'La billetterie est ouverte : la liste est figée. Ton invité peut prendre une place libre s\'il y en a.'
  };

  /** "1:3" = présent, achète 3 places pour d'autres ; "0:4" = absent, achète 4 places. */
  function parseDeclaration(v) {
    var m = /^\s*(1|0|oui|non|true|false)\s*:\s*(\d)\s*$/i.exec(String(v == null ? '' : v));
    if (!m) return null;
    return { present: /^(1|oui|true)$/i.test(m[1]), extra: +m[2] };
  }

  /** Places sur la liste d'un abonné : sa place d'abonné + celles qu'il achète. */
  function seatsDeclared(st, subId) {
    if (!st.confirms[subId]) return 0;
    return 1 + (st.extra[subId] || 0);
  }

  function purchasedCount(st, subId) {
    return st.alloc.bySub[subId].filter(function (x) { return !x.season; }).length;
  }

  function undeclare(st, id) {
    delete st.confirms[id];
    delete st.absent[id];
    delete st.extra[id];
    Object.keys(st.pins).forEach(function (p) { if (st.pins[p].subId === id) delete st.pins[p]; });
  }

  function declare(st, id, present, extra, ev) {
    if (!isSub(st, id)) return 'Seul un abonné déclare ses places.';
    if (extra < 0 || extra > QUOTA) return 'Au plus ' + QUOTA + ' places achetées pour d\'autres (ta place d\'abonné est en plus).';
    var named = st.regs.filter(function (r) { return r.personal === id; }).length;
    if (extra < named) return nameOf(st, id) + ' a ' + named + ' invité' + (named > 1 ? 's' : '') + ' nommé' + (named > 1 ? 's' : '') + ' : il faut garder au moins ' + named + ' place' + (named > 1 ? 's' : '') + ' en plus, ou les retirer d\'abord.';
    var i = regIndex(st, id);
    if (i >= 0) st.regs.splice(i, 1);
    delete st.pins[id];
    if (!st.confirms[id]) st.confirms[id] = { ts: ev.ts, order: ev.order };
    st.extra[id] = extra;
    if (present) delete st.absent[id]; else st.absent[id] = true;
    return null;
  }

  function applyPre(st, ev) {
    var id = ev.memberId, i;
    switch (ev.type) {
      case 'register':
        if (st.confirms[id]) return nameOf(st, id) + ' a déjà déclaré ses places : il suffit de modifier « Présent ».';
        if (regIndex(st, id) >= 0) return nameOf(st, id) + ' a déjà demandé une place.';
        st.regs.push({ memberId: id, by: ev.by || id, ts: ev.ts, order: ev.order });
        return null;

      case 'unregister':
        if (st.confirms[id]) {
          if (st.absent[id]) return nameOf(st, id) + ' est déjà indiqué absent.';
          return declare(st, id, false, st.extra[id], ev);
        }
        i = regIndex(st, id);
        if (i < 0) return nameOf(st, id) + ' n\'a pas demandé de place.';
        st.regs.splice(i, 1);
        delete st.pins[id];
        return null;

      case 'declare': {
        var d = parseDeclaration(ev.value);
        if (!d) return 'Déclaration invalide.';
        return declare(st, id, d.present, d.extra, ev);
      }

      case 'confirm':
        if (st.confirms[id]) return nameOf(st, id) + ' a déjà déclaré ses places.';
        return declare(st, id, true, QUOTA - 1, ev);

      case 'unconfirm':
        if (!st.confirms[id]) return nameOf(st, id) + ' n\'a pas déclaré de places.';
        undeclare(st, id);
        return null;

      case 'setAbsent':
        if (!st.confirms[id]) return 'Seul un abonné qui a déclaré ses places peut se dire absent.';
        if (truthy(ev.value)) {
          if (st.absent[id]) return nameOf(st, id) + ' est déjà indiqué absent.';
          return declare(st, id, false, st.extra[id], ev);
        }
        if (!st.absent[id]) return nameOf(st, id) + ' n\'est pas indiqué absent.';
        return declare(st, id, true, st.extra[id], ev);

      case 'addGuest': {
        var host = ev.target;
        if (!st.confirms[host]) return nameOf(st, host) + ' n\'a pas déclaré de places.';
        if (st.confirms[id]) return nameOf(st, id) + ' est abonné et a déclaré ses propres places.';
        var mine = st.regs.filter(function (r) { return r.personal === host; }).length;
        i = regIndex(st, id);
        if (i >= 0 && st.regs[i].personal) return nameOf(st, id) + ' est déjà sur la liste de ' + nameOf(st, st.regs[i].personal) + '.';
        if (mine >= (st.extra[host] || 0)) return nameOf(st, host) + ' n\'a plus de place dispo en plus : augmente « places dispo en plus ».';
        if (i >= 0) { st.regs[i].personal = host; delete st.pins[id]; return null; }
        st.regs.push({ memberId: id, by: ev.by || host, personal: host, ts: ev.ts, order: ev.order });
        return null;
      }

      case 'move': {
        var cur = st.alloc && st.alloc.assign[id];
        if (!cur) return nameOf(st, id) + ' n\'a pas de place à déplacer.';
        var reg = st.regs[regIndex(st, id)];
        if (reg && reg.personal) return nameOf(st, id) + ' est l\'invité de ' + nameOf(st, reg.personal) + ' : il reste sur sa liste.';
        var target = ev.target;
        if (!st.confirms[target]) return nameOf(st, target) + ' n\'a pas déclaré de places.';
        if (target === cur && !st.alloc.season[id]) return 'La place de ' + nameOf(st, id) + ' est déjà achetée par ' + nameOf(st, target) + '.';
        if (purchasedCount(st, target) >= (st.extra[target] || 0)) return nameOf(st, target) + ' n\'a plus de place dispo.';
        st.pins[id] = { subId: target, ts: ev.ts, order: ev.order };
        return null;
      }

      case 'takeSeat': case 'setBought': case 'setPaid': case 'setRefunded':
        return 'Possible seulement après l\'ouverture de la billetterie.';
    }
    return 'Action inconnue.';
  }

  function applyPost(st, ev) {
    var id = ev.memberId, seat;
    if (PRE_ONLY_MSG[ev.type]) return PRE_ONLY_MSG[ev.type];
    switch (ev.type) {
      case 'unregister': {
        var w = st.waitlist.indexOf(id);
        if (w >= 0) { st.waitlist.splice(w, 1); return null; }
        seat = seatOf(st, id);
        if (!seat) return nameOf(st, id) + ' n\'a pas de place.';
        if (seat.own && seat.subId === id) return applyPost(st, { type: 'setAbsent', memberId: id, value: true, ts: ev.ts, order: ev.order });
        releaseSeat(st, seat, ev, 'desistement');
        return null;
      }

      case 'declare': {
        var d = parseDeclaration(ev.value);
        if (!d) return 'Déclaration invalide.';
        if (!st.confirms[id]) return PRE_ONLY_MSG.confirm;
        var presentNow = !st.absent[id];
        if (d.present === presentNow || d.extra !== (st.extra[id] || 0)) {
          return 'La billetterie est ouverte : ton nombre de places est figé. Tu peux seulement indiquer si tu es présent.';
        }
        return applyPost(st, { type: 'setAbsent', memberId: id, value: !d.present, ts: ev.ts, order: ev.order });
      }

      case 'setAbsent':
        if (!st.confirms[id]) return 'Seul un abonné qui a déclaré ses places peut se dire absent.';
        if (truthy(ev.value)) {
          if (st.absent[id]) return nameOf(st, id) + ' est déjà indiqué absent.';
          seat = seatOf(st, id);
          st.absent[id] = true;
          if (seat) releaseSeat(st, seat, ev, 'absence');
          return null;
        }
        if (!st.absent[id]) return nameOf(st, id) + ' n\'est pas indiqué absent.';
        return returnFromAbsence(st, id, ev);

      case 'takeSeat': {
        seat = seatById(st, ev.seatId);
        if (!seat) return 'Place introuvable.';
        if (seat.refunded) return 'Cette place a été remboursée : elle n\'est plus proposée.';
        if (seat.occupant) return 'Cette place est déjà prise par ' + nameOf(st, seat.occupant) + '.';
        if (!st.members[id]) return 'Personne inconnue.';
        if (seatOf(st, id)) return nameOf(st, id) + ' a déjà une place.';
        if (st.confirms[id] && st.absent[id]) return nameOf(st, id) + ' : retire d\'abord « je serai absent ».';
        var w2 = st.waitlist.indexOf(id);
        if (w2 >= 0) st.waitlist.splice(w2, 1);
        seat.occupant = id;
        seat.personal = false;
        seat.paid = false;
        seat.since = ev.ts;
        st.replacements.push({ ts: ev.ts, seatId: seat.id, subId: seat.subId, fromId: null, toId: id, bought: seat.bought, season: !!seat.season, fromPaid: false, reason: 'place-libre' });
        return null;
      }

      case 'setBought':
        seat = seatById(st, ev.seatId);
        if (!seat) return 'Place introuvable.';
        if (seat.season) return 'Place d\'abonné : rien à acheter.';
        if (!truthy(ev.value) && seat.refunded) return 'Place remboursée : « Acheté » reste coché.';
        seat.bought = truthy(ev.value);
        return null;

      case 'setPaid':
        seat = seatById(st, ev.seatId);
        if (!seat) return 'Place introuvable.';
        if (!seat.occupant) return 'Personne n\'occupe cette place.';
        if (seat.occupant === seat.subId) return 'L\'abonné ne se doit rien à lui-même.';
        if (seat.season) return 'Place d\'abonné prêtée : rien à payer.';
        seat.paid = truthy(ev.value);
        return null;

      case 'setRefunded':
        seat = seatById(st, ev.seatId);
        if (!seat) return 'Place introuvable.';
        if (seat.season) return 'Place d\'abonné : rien à rembourser.';
        if (truthy(ev.value)) {
          if (seat.occupant) return 'Remboursé impossible : ' + nameOf(st, seat.occupant) + ' occupe la place.';
          if (!seat.bought) return 'Remboursé possible seulement sur une place achetée.';
          seat.refunded = true;
        } else {
          seat.refunded = false;
        }
        return null;
    }
    return 'Action inconnue.';
  }

  function returnFromAbsence(st, subId, ev) {
    var seat = seatsOfSub(st, subId).filter(function (x) { return x.season; })[0];
    if (!seat) return 'Place d\'abonné introuvable.';
    if (seat.occupant && seat.occupant !== subId) {
      st.waitlist.unshift(seat.occupant);
      st.replacements.push({ ts: ev.ts, seatId: seat.id, subId: subId, fromId: seat.occupant, toId: subId, bought: false, season: true, fromPaid: false, reason: 'retour-abonne' });
    }
    seat.occupant = subId;
    seat.own = true;
    seat.personal = false;
    seat.paid = false;
    seat.since = ev.ts;
    delete st.absent[subId];
    return null;
  }

  function applyEvent(st, ev) {
    var err;
    if (ev.memberId && !st.members[ev.memberId]) err = 'Personne inconnue.';
    else if (st.closed && ev.type !== 'setPaid') err = 'Match commencé : lecture seule.';
    else err = st.frozen ? applyPost(st, ev) : applyPre(st, ev);
    if (err) st.rejected.push({ event: ev, error: err });
    else if (!st.frozen) recompute(st);
    return err;
  }

  function normalizeEvent(e, i) {
    return {
      seq: e.seq != null ? +e.seq : i,
      order: e.seq != null ? +e.seq : i,
      ts: +e.ts,
      matchId: e.matchId,
      type: e.type,
      memberId: e.memberId || '',
      by: e.by || '',
      target: e.target || '',
      seatId: e.seatId || '',
      value: e.value
    };
  }

  /** Rejoue le journal d'un match jusqu'à `now`. */
  function buildMatchState(match, members, events, now) {
    var st = newState(match, members);
    recompute(st);
    (events || [])
      .filter(function (e) { return e.matchId === match.id; })
      .map(normalizeEvent)
      .sort(function (a, b) { return a.seq - b.seq; })
      .forEach(function (ev) {
        advanceTime(st, ev.ts);
        applyEvent(st, ev);
      });
    advanceTime(st, now);
    st.now = now;
    return st;
  }

  /** Teste une action sur l'état courant. Renvoie { error, state }. */
  function simulate(match, members, events, action, now) {
    var st = buildMatchState(match, members, events, now);
    var ev = normalizeEvent(Object.assign({ matchId: match.id, ts: now, seq: Number.MAX_SAFE_INTEGER }, action), 0);
    ev.order = Number.MAX_SAFE_INTEGER;
    var err = applyEvent(st, ev);
    return { error: err, state: st };
  }

  // ---------- Lectures pour l'affichage ----------

  function phase(st) {
    if (st.closed) return 'terminee';
    if (st.frozen) return 'ouverte';
    return 'avant';
  }

  /** Listes par abonné qui a déclaré, au même format avant et après l'ouverture. */
  function lists(st) {
    if (!st.frozen) {
      return st.alloc.subs.map(function (s) {
        var seats = st.alloc.bySub[s].map(function (x) {
          return { id: null, subId: s, occupant: x.memberId, own: !!x.own, season: !!x.season, pinned: !!x.pinned, personal: !!x.personal, bought: false, paid: false, refunded: false };
        });
        var bought = seats.length - 1;
        return { subId: s, absent: !!st.absent[s], extra: st.extra[s] || 0, declared: seatsDeclared(st, s), purchased: bought, seats: seats, holes: (st.extra[s] || 0) - bought };
      });
    }
    return confirmedSubs(st).map(function (s) {
      var seats = seatsOfSub(st, s);
      return { subId: s, absent: !!st.absent[s], extra: st.extra[s] || 0, declared: seats.length, purchased: seats.length - 1, seats: seats, holes: 0 };
    });
  }

  function counters(st) {
    var nConf = Object.keys(st.confirms).length;
    var capacity = 0;
    Object.keys(st.confirms).forEach(function (s) { capacity += seatsDeclared(st, s); });
    if (!st.frozen) {
      var taken = 0;
      st.alloc.subs.forEach(function (s) { st.alloc.bySub[s].forEach(function (x) { if (x.memberId) taken++; }); });
      return { capacity: capacity, subs: nConf, taken: taken, remaining: capacity - taken, waiting: st.alloc.waitlist.length, free: 0 };
    }
    var active = st.seats.filter(function (x) { return !x.refunded; });
    var occ = active.filter(function (x) { return x.occupant; }).length;
    var toBuy = st.seats.filter(function (x) { return !x.season; });
    return {
      capacity: capacity, subs: nConf, taken: occ, remaining: active.length - occ, waiting: st.waitlist.length,
      free: active.length - occ, seats: toBuy.length,
      bought: toBuy.filter(function (x) { return x.bought; }).length,
      toBuy: toBuy.filter(function (x) { return !x.bought; }).length
    };
  }

  function waitlistOf(st) {
    return st.frozen ? st.waitlist.slice() : st.alloc.waitlist.slice();
  }

  function freeSeats(st) {
    return st.frozen ? st.seats.filter(function (x) { return !x.occupant && !x.refunded; }) : [];
  }

  /** Situation d'une personne sur le match. */
  function personStatus(st, id) {
    var res = {
      id: id, isSub: isSub(st, id), confirmed: !!st.confirms[id], absent: !!st.absent[id], extra: st.extra[id] || 0,
      declared: seatsDeclared(st, id), kind: 'none', subId: null, seat: null, waitPos: 0, requested: regIndex(st, id) >= 0
    };
    var wl = waitlistOf(st);
    var w = wl.indexOf(id);
    if (w >= 0) { res.kind = 'wait'; res.waitPos = w + 1; return res; }
    if (st.frozen) {
      var seat = seatOf(st, id);
      if (seat) { res.kind = seat.subId === id ? 'own' : 'seat'; res.subId = seat.subId; res.seat = seat; res.season = !!seat.season && seat.subId !== id; }
      else if (res.confirmed && res.absent) res.kind = 'absent';
      return res;
    }
    if (res.confirmed) { res.kind = res.absent ? 'absent' : 'own'; res.subId = id; return res; }
    if (st.alloc.assign[id]) {
      res.kind = 'seat'; res.subId = st.alloc.assign[id]; res.pinned = !!st.pins[id]; res.season = !!st.alloc.season[id];
      res.personal = !!(st.regs[regIndex(st, id)] || {}).personal;
    }
    return res;
  }

  function allBought(st) {
    var toBuy = st.seats.filter(function (x) { return !x.season; });
    return st.frozen && toBuy.length > 0 && toBuy.every(function (x) { return x.bought; });
  }

  /** Dettes du match : chaque place achetée pour quelqu'un d'autre vaut 8 € ; une place d'abonné prêtée est gratuite. */
  function debts(st) {
    var out = [];
    if (st.frozen) {
      st.seats.forEach(function (x) {
        if (x.occupant && x.occupant !== x.subId && !x.refunded && !x.season) {
          out.push({ matchId: st.match.id, seatId: x.id, debtorId: x.occupant, creditorId: x.subId, amount: PRICE, paid: x.paid, bought: x.bought, provisional: false });
        }
      });
    } else {
      st.alloc.subs.forEach(function (s) {
        st.alloc.bySub[s].forEach(function (x) {
          if (!x.season) out.push({ matchId: st.match.id, seatId: null, debtorId: x.memberId, creditorId: s, amount: PRICE, paid: false, bought: false, provisional: true });
        });
      });
    }
    return out;
  }

  // ---------- Textes WhatsApp ----------

  function matchTitle(match) {
    return 'Red Star - ' + match.opponent + ' (' + formatMatchWhen(match) + ', ' + STADIUM + ')';
  }

  function payLinkText(st, subId) {
    var m = st.members[subId];
    return m && m.payLink ? ' : ' + m.payLink : '';
  }

  function recapText(st) {
    var c = counters(st);
    var lines = [matchTitle(st.match)];
    if (!st.frozen) {
      lines.push(st.match.opening ? 'Ouverture billetterie : ' + formatOpeningFr(st.match.opening) : 'Ouverture billetterie : pas encore connue');
      lines.push('Places : ' + c.taken + '/' + c.capacity + ' (' + c.remaining + ' restantes)');
    } else {
      lines.push('Billetterie ouverte : liste figée. Achetées : ' + c.bought + '/' + c.seats);
    }
    lines.push('');
    var ls = lists(st);
    if (!ls.length) lines.push('Aucun abonné n\'a encore déclaré de places.');
    ls.forEach(function (l) {
      var seasonSeat = l.seats.filter(function (x) { return x.season; })[0];
      var names = l.seats.filter(function (x) { return !x.season; }).map(function (x) {
        if (x.refunded) return '(remboursée)';
        if (!x.occupant) return '(libre)';
        return nameOf(st, x.occupant) + (st.frozen && x.bought ? ' [acheté]' : '');
      });
      var head = nameOf(st, l.subId);
      if (l.absent) head += ' (absent) prête sa place d\'abonné à ' + (seasonSeat && seasonSeat.occupant ? nameOf(st, seasonSeat.occupant) : '(libre)') + ' ;';
      lines.push(head + ' achète ' + names.length + (names.length ? ' : ' + names.join(', ') : '') +
        (!st.frozen && l.holes > 0 ? ' (+' + l.holes + ' dispo)' : ''));
    });
    var wl = waitlistOf(st);
    if (wl.length) {
      lines.push('');
      lines.push('Liste d\'attente : ' + wl.map(function (id, i) { return (i + 1) + '. ' + nameOf(st, id); }).join(', '));
    }
    var fs = freeSeats(st);
    if (fs.length) {
      lines.push('');
      lines.push('Places libres : ' + fs.map(function (x) { return x.season ? 'la place d\'abonné de ' + nameOf(st, x.subId) + ' (gratuite)' : '1 sur la liste de ' + nameOf(st, x.subId); }).join(', '));
    }
    lines.push('');
    lines.push(PRICE + ' € la place, à payer à l\'abonné qui achète. Une place d\'abonné prêtée est gratuite.');
    return lines.join('\n');
  }

  function replacementText(st, r) {
    var buyer = nameOf(st, r.subId);
    var title = 'Red Star - ' + st.match.opponent + ' (' + formatDateFr(st.match.date) + ')';
    var parts = [];
    if (r.season) return seasonReplacementText(st, r, title);
    if (r.reason === 'retour-abonne') {
      parts.push(title + ' : ' + buyer + ' vient finalement et reprend sa place. ' + nameOf(st, r.fromId) + ' repasse en tête de liste d\'attente et ne doit plus rien.');
      if (r.fromPaid) parts.push(buyer + ' rembourse ' + PRICE + ' € à ' + nameOf(st, r.fromId) + '.');
      return parts.join(' ');
    }
    var from = r.fromId ? nameOf(st, r.fromId) + (r.reason === 'absence' ? ' (abonné absent)' : '') + ' libère sa place' : 'Une place libre';
    if (r.toId) {
      parts.push(title + ' : ' + from + ', ' + nameOf(st, r.toId) + ' la reprend.');
      parts.push('Acheteur : ' + buyer + (r.bought ? ' (place déjà achetée)' : ' (place à acheter)') + '.');
      if (r.toId !== r.subId) parts.push(nameOf(st, r.toId) + ' doit ' + PRICE + ' € à ' + buyer + payLinkText(st, r.subId) + '.');
      if (r.fromId && r.fromId !== r.subId) parts.push(nameOf(st, r.fromId) + ' ne doit plus rien.');
    } else {
      parts.push(title + ' : ' + from + ' et personne n\'est en attente. La place achetée par ' + buyer + ' est libre, qui la veut ?');
      if (r.fromId && r.fromId !== r.subId) parts.push(nameOf(st, r.fromId) + ' ne doit plus rien.');
    }
    if (r.fromPaid && r.fromId) parts.push(buyer + ' rembourse ' + PRICE + ' € à ' + nameOf(st, r.fromId) + '.');
    return parts.join(' ');
  }

  function seasonReplacementText(st, r, title) {
    var owner = nameOf(st, r.subId);
    if (r.reason === 'retour-abonne') {
      return title + ' : ' + owner + ' vient finalement et reprend sa place d\'abonné. ' + nameOf(st, r.fromId) + ' repasse en tête de liste d\'attente.';
    }
    var from = r.reason === 'absence' ? owner + ' (abonné absent) libère sa place d\'abonné'
      : r.fromId ? nameOf(st, r.fromId) + ' libère la place d\'abonné de ' + owner
      : 'La place d\'abonné de ' + owner + ' est libre';
    if (r.toId) return title + ' : ' + from + ', ' + nameOf(st, r.toId) + ' la reprend. Rien à acheter : c\'est la place d\'abonné de ' + owner + ', ' + nameOf(st, r.toId) + ' ne doit rien.';
    return title + ' : ' + from + ' et personne n\'est en attente. Place gratuite, qui la veut ?';
  }

  var MONTHS_SHORT = ['janv', 'févr', 'mars', 'avr', 'mai', 'juin', 'juil', 'août', 'sept', 'oct', 'nov', 'déc'];

  /** "2026-11-20 20:00" -> "20 nov 20h". */
  function formatOpeningShort(opening) {
    var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/.exec(String(opening || '').trim());
    if (!m) return '';
    return (+m[3]) + ' ' + MONTHS_SHORT[+m[2] - 1] + ' ' + (+m[4]) + 'h' + (m[5] === '00' ? '' : m[5]);
  }

  /** Statut affiché sur la carte d'un match. */
  function statusLabel(st) {
    if (st.closed) return { key: 'fermee', label: 'Billetterie fermée' };
    if (st.frozen) return { key: 'ouverte', label: 'Billetterie ouverte' };
    if (st.match.opening) return { key: 'ouverture', label: 'Ouverture ' + formatOpeningShort(st.match.opening) };
    return { key: 'inconnue', label: 'Ouverture à confirmer' };
  }

  return {
    QUOTA: QUOTA, PRICE: PRICE, STADIUM: STADIUM,
    cleanName: cleanName, normalizeName: normalizeName, findMemberByName: findMemberByName, validateNewName: validateNewName,
    parisToMs: parisToMs, normalizeTime: normalizeTime, kickoffMs: kickoffMs, openingMs: openingMs,
    formatDateFr: formatDateFr, formatTimeFr: formatTimeFr, formatMatchWhen: formatMatchWhen, formatOpeningFr: formatOpeningFr,
    truthy: truthy, buildMatchState: buildMatchState, simulate: simulate,
    phase: phase, lists: lists, counters: counters, waitlistOf: waitlistOf, freeSeats: freeSeats,
    personStatus: personStatus, allBought: allBought, debts: debts, confirmedSubs: confirmedSubs,
    recapText: recapText, replacementText: replacementText, matchTitle: matchTitle,
    parseDeclaration: parseDeclaration, seatsDeclared: seatsDeclared, formatOpeningShort: formatOpeningShort, statusLabel: statusLabel
  };
});
