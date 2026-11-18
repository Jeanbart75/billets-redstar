(function () {
  'use strict';

  var R = window.RedStarRules;
  var CFG = window.REDSTAR_CONFIG || {};
  var params = new URLSearchParams(location.search);
  var DEMO = params.has('demo') || !String(CFG.apiUrl || '').trim();
  var KEY_ME = DEMO ? 'redstar-demo-me' : 'redstar-me';
  var KEY_DEMO_DB = 'redstar-demo-db';
  var REFRESH_MS = 45000;

  var data = null;
  var clockOffset = 0;
  var me = localStorage.getItem(KEY_ME);
  var busy = false;
  var lastJson = '';
  var pickQuery = '';
  var api = DEMO ? demoBackend() : realBackend(String(CFG.apiUrl).trim());

  var $app = document.getElementById('app');
  var $tabs = document.getElementById('tabs');
  var $toast = document.getElementById('toast');

  // ---------- Outils ----------

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function now() { return Date.now() + clockOffset; }
  function member(id) { return data.members.find(function (m) { return m.id === id; }) || null; }
  function nameOf(id) { var m = member(id); return m ? m.name : '(inconnu)'; }
  function isSub(id) { var m = member(id); return !!m && m.type === 'abonne'; }
  function match(id) { return data.matches.find(function (m) { return m.id === id; }) || null; }
  function stateOf(m) { return R.buildMatchState(m, data.members, data.events, now()); }
  function newId(prefix) { return prefix + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4); }

  function parisLocal(ms) {
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
    }).format(new Date(ms)).replace(',', '');
  }

  function relTime(ms) {
    var d = ms - now();
    if (d <= 0) return 'maintenant';
    var min = Math.round(d / 60000);
    if (min < 60) return 'dans ' + min + ' min';
    var h = Math.floor(min / 60);
    if (h < 48) return 'dans ' + h + ' h' + (min % 60 ? ' ' + (min % 60) + ' min' : '');
    return 'dans ' + Math.round(h / 24) + ' jours';
  }

  function sortedMatches() {
    return data.matches.slice().sort(function (a, b) { return (R.kickoffMs(a) || 0) - (R.kickoffMs(b) || 0); });
  }

  function payLinkHtml(subId, label) {
    var m = member(subId);
    if (!m || !m.payLink) return '<small class="muted">' + esc(nameOf(subId)) + ' n\'a pas encore mis de lien Lydia/Wero.</small>';
    if (/^https?:\/\//i.test(m.payLink)) return '<a class="btn btn-small btn-primary" href="' + esc(m.payLink) + '" target="_blank" rel="noopener">' + esc(label || 'Payer') + '</a>';
    return '<small>Paiement : ' + esc(m.payLink) + '</small>';
  }

  var toastTimer = null;
  function toast(text, isError) {
    $toast.textContent = text;
    $toast.className = 'toast' + (isError ? ' error' : '');
    $toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { $toast.hidden = true; }, isError ? 6000 : 3000);
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { toast('Texte copié : colle-le dans WhatsApp.'); }, fallback);
    } else fallback();
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('Texte copié : colle-le dans WhatsApp.'); } catch (e) { toast('Copie impossible : sélectionne le texte à la main.', true); }
      document.body.removeChild(ta);
    }
  }

  // ---------- Serveur ----------

  function realBackend(url) {
    function parse(res) {
      if (!res.ok) throw new Error('Serveur injoignable (' + res.status + ').');
      return res.json();
    }
    return {
      load: function () {
        return fetch(url + (url.indexOf('?') >= 0 ? '&' : '?') + 'action=load&t=' + Date.now()).then(parse);
      },
      // text/plain évite la requête préalable CORS, qu'Apps Script ne gère pas.
      send: function (actions) {
        return fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ actions: actions }) }).then(parse);
      }
    };
  }

  function setData(d) {
    data = d;
    clockOffset = d.now ? d.now - Date.now() : 0;
  }

  function load(silent) {
    setRefreshing(true);
    return api.load().then(function (res) {
      if (!res.ok) throw new Error(res.error || 'Erreur de chargement.');
      var json = JSON.stringify([res.data.members, res.data.matches, res.data.events]);
      setData(res.data);
      if (json !== lastJson || !silent) { lastJson = json; render(); }
    }).catch(function (e) {
      if (!data) $app.innerHTML = '<div class="card"><h2>Impossible de charger</h2><p>' + esc(e.message) + '</p><p class="muted">Vérifie ta connexion puis touche le bouton d\'actualisation en haut à droite.</p></div>';
      else if (!silent) toast(e.message, true);
    }).then(function () { setRefreshing(false); });
  }

  function setRefreshing(on) {
    var b = document.querySelector('[data-act=refresh]');
    if (b) b.classList.toggle('spin', on);
  }

  /** Vérifie localement avec les règles, envoie, puis signale un éventuel refus. */
  function send(actions, okMsg) {
    if (busy) return Promise.resolve(false);
    actions = actions.map(function (a) { return Object.assign({ by: me }, a); });
    var members = data.members.slice();
    var events = data.events.slice();
    for (var i = 0; i < actions.length; i++) {
      var a = actions[i];
      if (a.type === 'addMember') {
        var err0 = R.validateNewName(members, a.name);
        if (err0) { toast(err0, true); return Promise.resolve(false); }
        members.push({ id: a.id, name: R.cleanName(a.name), type: 'invite' });
      } else if (a.matchId && ['setOpening', 'setSchedule'].indexOf(a.type) < 0) {
        var sim = R.simulate(match(a.matchId), members, events, a, now());
        if (sim.error) { toast(sim.error, true); return Promise.resolve(false); }
        events.push(Object.assign({ seq: Number.MAX_SAFE_INTEGER - 10 + i, ts: now() }, a));
      }
    }
    var maxSeq = data.events.reduce(function (mx, e) { return Math.max(mx, e.seq); }, 0);
    busy = true;
    document.body.style.cursor = 'progress';
    return api.send(actions).then(function (res) {
      if (res.data) { setData(res.data); lastJson = JSON.stringify([res.data.members, res.data.matches, res.data.events]); }
      if (!res.ok) { toast(res.error || 'Action refusée.', true); return false; }
      var refused = null;
      actions.forEach(function (a) {
        if (!a.matchId || refused) return;
        var st = stateOf(match(a.matchId));
        st.rejected.forEach(function (r) { if (r.event.seq > maxSeq && r.event.by === me) refused = r.error; });
      });
      if (refused) toast('Refusé : ' + refused, true);
      else if (okMsg) toast(okMsg);
      return !refused;
    }).catch(function (e) {
      toast('Pas de connexion au serveur : ' + e.message, true);
      return false;
    }).then(function (ok) {
      busy = false;
      document.body.style.cursor = '';
      render();
      return ok;
    });
  }

  // ---------- Rendu ----------

  function route() {
    var h = location.hash.replace(/^#\/?/, '');
    var p = h.split('/');
    return { name: p[0] || 'home', id: p[1] ? decodeURIComponent(p[1]) : null };
  }

  function render() {
    if (!data) return;
    if (me && !member(me)) { me = null; localStorage.removeItem(KEY_ME); }
    var r = route();
    var scroll = window.scrollY;
    var keepScroll = render.lastRoute === location.hash;
    render.lastRoute = location.hash;
    $tabs.hidden = !me;
    document.querySelectorAll('.tabs a').forEach(function (a) {
      a.classList.toggle('active', a.dataset.tab === (r.name === 'm' ? 'home' : r.name));
    });
    if (!me) $app.innerHTML = viewPicker();
    else if (r.name === 'm' && match(r.id)) $app.innerHTML = viewMatch(match(r.id));
    else if (r.name === 'liste') $app.innerHTML = viewMyList();
    else if (r.name === 'dettes') $app.innerHTML = viewDebts();
    else if (r.name === 'moi') $app.innerHTML = viewMe();
    else $app.innerHTML = viewHome();
    document.querySelectorAll('form[data-form=declare]').forEach(function (f) { syncDeclareForm(f); });
    if (!me) {
      var q = document.getElementById('pick-q');
      if (q) { q.value = pickQuery; renderPickList(); }
    }
    window.scrollTo(0, keepScroll ? scroll : 0);
  }

  // ----- Choix du nom -----

  function viewPicker() {
    return '<section class="card">' +
      '<h2>Qui es-tu ?</h2>' +
      '<p>Non abonné :renseigne ton prénom de clébard</p>' +
      '<input id="pick-q" type="search" placeholder="Ton prénom" autocomplete="off" data-input="pick">' +
      '<ul id="pick-list" class="pick-list"></ul>' +
      '<div id="pick-add"></div>' +
      '</section>' +
      '<p class="muted" style="padding:0 6px">Pas de compte ni de mot de passe : tout le groupe partage ce lien et se fait confiance. Les abonnés sont déjà dans la liste.</p>';
  }

  function renderPickList() {
    var q = R.normalizeName(pickQuery);
    var list = data.members.filter(function (m) { return !q || R.normalizeName(m.name).indexOf(q) >= 0; })
      .sort(function (a, b) { return (a.type === b.type ? 0 : a.type === 'abonne' ? -1 : 1) || a.name.localeCompare(b.name, 'fr'); });
    document.getElementById('pick-list').innerHTML = list.map(function (m) {
      return '<li><button data-act="pick" data-id="' + esc(m.id) + '">' + esc(m.name) + (m.type === 'abonne' ? ' <span class="tag">abonné</span>' : '') + '</button></li>';
    }).join('') || '<li class="muted">Personne à ce nom.</li>';
    var exact = R.findMemberByName(data.members, pickQuery);
    document.getElementById('pick-add').innerHTML = pickQuery.trim() && !exact
      ? '<button class="btn-primary btn-block" style="margin-top:12px" data-act="add-me">Je ne suis pas dans la liste : ajouter « ' + esc(R.cleanName(pickQuery)) + ' » (invité)</button>'
      : '';
  }

  // ----- Accueil -----

  function phaseBadge(st) {
    var s = R.statusLabel(st);
    var cls = { fermee: 'grey', ouverte: 'red', ouverture: 'amber', inconnue: 'grey' }[s.key];
    return '<span class="tag status ' + cls + '">' + esc(s.label) + '</span>';
  }

  function plural(n, word) { return n + ' ' + word + (n > 1 ? 's' : ''); }

  function myChip(st) {
    var s = R.personStatus(st, me);
    if (s.kind === 'own') return '<span class="chip ok">Présent · ' + (s.extra ? 'tu achètes ' + plural(s.extra, 'place') : 'rien à acheter') + '</span>';
    if (s.kind === 'seat' && s.season) return '<span class="chip ok">Ta place : place d\'abonné de ' + esc(nameOf(s.subId)) + ' (gratuite)</span>';
    if (s.kind === 'seat') return '<span class="chip ok">Ta place : achetée par ' + esc(nameOf(s.subId)) + '</span>';
    if (s.kind === 'wait') return '<span class="chip wait">En attente (n° ' + s.waitPos + ')</span>';
    if (s.kind === 'absent') return '<span class="chip">Absent · ' + (s.extra ? 'tu achètes ' + plural(s.extra, 'place') : 'rien à acheter') + '</span>';
    if (s.isSub && !st.frozen) return '<span class="chip wait">Places à déclarer</span>';
    return '<span class="chip">Pas de place demandée</span>';
  }

  function counterLine(st) {
    var c = R.counters(st);
    if (!st.frozen && !c.capacity) return '<span>Aucune place déclarée par les abonnés' + (c.waiting ? ' · ' + c.waiting + ' en attente' : '') + '</span>';
    if (!st.frozen) return '<span><b>' + c.remaining + '</b> place' + (c.remaining > 1 ? 's' : '') + ' restante' + (c.remaining > 1 ? 's' : '') + ' sur ' + c.capacity + (c.waiting ? ' · ' + c.waiting + ' en attente' : '') + '</span>';
    return '<span>' + c.taken + ' places · <b>' + c.free + '</b> libre' + (c.free > 1 ? 's' : '') + (c.waiting ? ' · ' + c.waiting + ' en attente' : '') + '</span>';
  }

  function matchCard(m) {
    var st = stateOf(m);
    var c = R.counters(st);
    var pct = c.capacity ? Math.min(100, Math.round(100 * c.taken / c.capacity)) : 0;
    return '<a class="card match-card" href="#/m/' + encodeURIComponent(m.id) + '">' +
      '<div class="mc-top"><div><div class="mc-opp">Red Star – ' + esc(m.opponent) + '</div>' +
      '<div class="mc-when">' + esc(R.formatMatchWhen(m)) + (m.competition && m.competition !== 'Ligue 2' ? ' · ' + esc(m.competition) : '') + '</div></div>' +
      phaseBadge(st) + '</div>' +
      '<div class="meter"><span style="width:' + pct + '%"></span></div>' +
      '<div class="mc-bottom">' + counterLine(st) + myChip(st) + '</div></a>';
  }

  function viewHome() {
    var all = sortedMatches();
    var upcoming = all.filter(function (m) { return now() < R.kickoffMs(m); });
    var past = all.filter(function (m) { return now() >= R.kickoffMs(m); }).reverse();
    return '<div class="section-title"><h2>Matchs à domicile</h2><small>' + esc(R.STADIUM) + ' · ' + R.PRICE + ' € la place</small></div>' +
      (upcoming.map(matchCard).join('') || '<div class="card empty">Aucun match à venir.</div>') +
      (past.length ? '<details class="card flat"><summary>Matchs passés (' + past.length + ')</summary>' + past.map(matchCard).join('') + '</details>' : '') +
      '<details class="card flat"><summary>Ajouter un match à domicile (Coupe de France…)</summary>' +
      '<form data-form="add-match">' +
      '<label class="field">Adversaire</label><input type="text" name="opponent" required placeholder="ex. Lens">' +
      '<div class="grid-2"><div><label class="field">Date</label><input type="date" name="date" required></div>' +
      '<div><label class="field">Heure (si connue)</label><input type="time" name="time"></div></div>' +
      '<label class="field">Compétition</label><input type="text" name="competition" value="Coupe de France">' +
      '<div class="btn-row"><button class="btn-primary" type="submit">Ajouter le match</button></div>' +
      '</form></details>';
  }

  // ----- Page match -----

  function viewMatch(m) {
    var st = stateOf(m);
    var ph = R.phase(st);
    return '<a class="back" href="#/">← Tous les matchs</a>' +
      sectionHero(st, ph) +
      sectionMe(st, ph) +
      sectionLists(st, ph) +
      sectionWaitlist(st, ph) +
      sectionWhatsApp(st) +
      (ph !== 'terminee' ? sectionSchedule(st) : '');
  }

  function sectionHero(st, ph) {
    var m = st.match;
    var c = R.counters(st);
    var html = '<section class="card hero">' +
      '<div class="mc-top"><h1>Red Star – ' + esc(m.opponent) + '</h1>' + phaseBadge(st) + '</div>' +
      '<p class="mc-when">' + esc(R.formatDateFr(m.date, true)) + ' · ' + (R.normalizeTime(m.time) ? esc(R.formatTimeFr(m.time)) : 'heure à confirmer') + ' · ' + esc(R.STADIUM) + (m.competition ? ' · ' + esc(m.competition) : '') + '</p>';
    if (!st.frozen && !c.capacity) {
      html += '<div class="counter"><strong>0</strong><span>place : aucun abonné n\'a encore déclaré de places' + (c.waiting ? ' · ' + c.waiting + ' en attente' : '') + '</span></div>';
    } else if (!st.frozen) {
      html += '<div class="counter"><strong>' + c.remaining + '</strong><span>place' + (c.remaining > 1 ? 's' : '') + ' restante' + (c.remaining > 1 ? 's' : '') + ' sur ' + c.capacity + ' (déclarées par ' + plural(c.subs, 'abonné') + ')' + (c.waiting ? ' · ' + c.waiting + ' en attente' : '') + '</span></div>';
    } else {
      html += '<div class="counter"><strong>' + c.free + '</strong><span>place' + (c.free > 1 ? 's' : '') + ' libre' + (c.free > 1 ? 's' : '') + ' · ' + c.taken + ' personnes · achetées ' + c.bought + '/' + c.seats + (c.waiting ? ' · ' + c.waiting + ' en attente' : '') + '</span></div>';
    }
    if (ph === 'avant') {
      var op = m.opening ? R.openingMs(m) : null;
      html += m.opening
        ? '<div class="notice warn"><b>Ouverture de la billetterie : ' + esc(R.formatOpeningFr(m.opening)) + '</b> (' + relTime(op) + '). À cette heure-là, la liste se fige : plus de nouvelle demande, chaque abonné achète les places de sa liste.</div>'
        : '<div class="notice info">Heure d\'ouverture de la billetterie pas encore connue. Demandes libres, la répartition se recalcule en continu.</div>';
      var p = (m.opening || '').split(' ');
      html += '<details><summary>' + (m.opening ? 'Modifier' : 'Saisir') + ' l\'heure d\'ouverture de la billetterie</summary>' +
        '<form data-form="opening" data-match="' + esc(m.id) + '"><div class="grid-2">' +
        '<div><label class="field">Jour</label><input type="date" name="d" required value="' + esc(p[0] || '') + '"></div>' +
        '<div><label class="field">Heure</label><input type="time" name="t" required value="' + esc(p[1] || '12:00') + '"></div></div>' +
        '<p class="muted">S\'applique dès l\'enregistrement. Une heure déjà passée ouvre la billetterie tout de suite.</p>' +
        '<div class="btn-row"><button class="btn-primary" type="submit">Enregistrer</button>' +
        (m.opening ? '<button type="button" data-act="clear-opening" data-match="' + esc(m.id) + '">Effacer</button>' : '') + '</div></form></details>';
    } else if (ph === 'ouverte') {
      html += '<div class="notice alert"><b>Billetterie ouverte</b> depuis ' + esc(R.formatOpeningFr(m.opening) || 'le coup d\'envoi') + ' : liste figée. Chaque abonné achète les places de sa liste sur le site du club et coche « Acheté ». Un désistement est remplacé automatiquement par la liste d\'attente.</div>';
    } else {
      html += '<div class="notice info">Billetterie fermée : match commencé, lecture seule. On peut encore cocher « Payé ».</div>';
    }
    return html + '</section>';
  }

  function myLine(st, s) {
    var buys = s.extra ? 'tu achètes ' + plural(s.extra, 'place') + ' pour d\'autres' : 'tu n\'achètes aucune place pour d\'autres';
    if (s.kind === 'own') return 'Tu viens avec ta place d\'abonné (déjà acquise) et ' + buys + '.';
    if (s.kind === 'absent') {
      var lent = R.lists(st).filter(function (l) { return l.subId === me; })[0];
      var holder = lent && lent.seats.filter(function (x) { return x.season; })[0];
      return 'Tu ne viens pas : ta place d\'abonné est prêtée gratuitement' +
        (holder && holder.occupant ? ' à <b>' + esc(nameOf(holder.occupant)) + '</b>' : ' au premier en liste d\'attente') + '. Et ' + buys + '.';
    }
    if (s.kind === 'seat' && s.season) {
      return 'Ta place : la place d\'abonné de <b>' + esc(nameOf(s.subId)) + '</b>, qui ne vient pas. Rien à acheter : <b>tu ne dois rien</b>.' +
        (st.frozen ? '' : ' (Prévu : peut encore changer jusqu\'à l\'ouverture.)');
    }
    if (s.kind === 'seat') {
      return 'Ta place : achetée par <b>' + esc(nameOf(s.subId)) + '</b>' + (s.personal ? ' (tu es son invité)' : s.pinned ? ' (choisi à la main)' : '') +
        '. Tu lui dois ' + R.PRICE + '&nbsp;€' + (st.frozen ? (s.seat.paid ? ' : <b>payé</b>.' : '.') : ' (prévu : l\'acheteur peut encore changer jusqu\'à l\'ouverture).');
    }
    if (s.kind === 'wait') return 'Tu es <b>n° ' + s.waitPos + '</b> en liste d\'attente. Tu passes dès qu\'une place se libère.';
    if (s.isSub && !st.frozen) return 'Tu n\'as pas encore déclaré tes places pour ce match : tant que ce n\'est pas fait, elles ne comptent pas.';
    if (s.isSub && st.frozen) return 'Tu n\'avais pas déclaré de places pour ce match. Si tu en as déjà acheté, ajoute-les ci-dessous.';
    return st.frozen ? 'Tu n\'as pas de place pour ce match.' : 'Tu n\'as pas demandé de place.';
  }

  function declareForm(st, s) {
    var present = s.confirmed ? !s.absent : true;
    var extra = s.confirmed ? s.extra : R.QUOTA - 1;
    var nums = '';
    for (var n = 0; n <= R.QUOTA; n++) {
      nums += '<label class="seg-opt"><input type="radio" name="extra" value="' + n + '"' + (n === extra ? ' checked' : '') + '><span>' + n + '</span></label>';
    }
    return '<form class="declare" data-form="declare" data-match="' + esc(st.match.id) + '">' +
      '<div class="decl-row"><span class="decl-label">Présent ?</span><div class="seg">' +
      '<label class="seg-opt"><input type="radio" name="present" value="1"' + (present ? ' checked' : '') + '><span>Oui</span></label>' +
      '<label class="seg-opt"><input type="radio" name="present" value="0"' + (!present ? ' checked' : '') + '><span>Non</span></label></div></div>' +
      '<div class="decl-row"><span class="decl-label">Places dispo en plus</span><div class="seg seg-num">' + nums + '</div></div>' +
      '<p class="muted decl-sum"></p>' +
      '<div class="btn-row"><button class="btn-primary" type="submit">' + (s.confirmed ? 'Mettre à jour' : 'Enregistrer') + '</button></div></form>';
  }

  function guestForm(st, s) {
    var named = st.regs.filter(function (r) { return r.personal === me; }).length;
    var left = s.extra - named;
    return '<div class="guest-box"><h3>Inviter quelqu\'un hors du groupe</h3>' +
      '<p class="muted">Tape son nom : il prend une de tes places en plus et te doit ' + R.PRICE + ' €. ' +
      (left > 0 ? plural(left, 'place') + ' encore possible' + (left > 1 ? 's' : '') + '.' : 'Plus de place en plus disponible pour un invité nommé.') + '</p>' +
      '<form class="inline-form" data-form="guest" data-match="' + esc(st.match.id) + '">' +
      '<input type="text" name="name" placeholder="Nom de ton invité" autocomplete="off" required' + (left > 0 ? '' : ' disabled') + '>' +
      '<button class="btn-primary" type="submit"' + (left > 0 ? '' : ' disabled') + '>Ajouter</button></form></div>';
  }

  function boughtForm(st) {
    var mid = esc(st.match.id);
    var bought = st.seats.filter(function (x) { return x.subId === me && !x.season && !x.refunded; }).length;
    var left = R.QUOTA - bought;
    var choices = data.members.filter(function (m) {
      if (m.id === me || st.confirms[m.id]) return false;
      var k = R.personStatus(st, m.id).kind;
      return k === 'none' || k === 'wait';
    });
    return '<div class="guest-box"><h3>Places déjà achetées</h3>' +
      '<p class="muted">Tu as déjà acheté des places sur le site du club ? Inscris le prénom de chaque personne : un invité hors du groupe ou un membre du groupe. ' +
      'La place s\'ajoute à ta liste, cochée « Acheté », et personne d\'autre ne bouge. ' +
      (left > 0 ? bought + '/' + R.QUOTA + ' places achetées pour d\'autres (ta place d\'abonné est en plus).' : 'Tu as atteint ' + R.QUOTA + ' places achetées pour d\'autres.') + '</p>' +
      '<form class="inline-form" data-form="bought" data-match="' + mid + '">' +
      '<input type="text" name="name" list="names-bought-' + mid + '" placeholder="Prénom" autocomplete="off" required' + (left > 0 ? '' : ' disabled') + '>' +
      '<button class="btn-primary" type="submit"' + (left > 0 ? '' : ' disabled') + '>Ajouter</button></form>' +
      '<datalist id="names-bought-' + mid + '">' + choices.map(function (m) { return '<option value="' + esc(m.name) + '">'; }).join('') + '</datalist></div>';
  }

  function sectionMe(st, ph) {
    var s = R.personStatus(st, me);
    var mid = esc(st.match.id);
    var lines = [myLine(st, s)], btns = [], extraHtml = '';
    var btn = function (cls, type, label, value, confirmMsg) {
      return '<button class="' + cls + '" data-act="ev" data-type="' + type + '" data-match="' + mid + '" data-member="' + esc(me) + '"' +
        (value !== undefined ? ' data-value="' + value + '"' : '') + (confirmMsg ? ' data-confirm="' + esc(confirmMsg) + '"' : '') + '>' + label + '</button>';
    };
    if (s.kind === 'seat' && st.frozen && !s.seat.paid && !s.season) btns.push(payLinkHtml(s.subId, 'Payer ' + R.PRICE + ' € à ' + nameOf(s.subId)));

    if (ph === 'avant') {
      if (s.isSub) {
        extraHtml += declareForm(st, s);
        if (s.confirmed && s.extra > 0) extraHtml += guestForm(st, s);
      } else {
        btns.push(s.requested
          ? btn('btn-danger', 'unregister', 'Je n\'en veux plus')
          : btn('btn-primary', 'register', 'Je veux une place'));
      }
    } else if (ph === 'ouverte') {
      if (s.isSub && (s.confirmed || s.kind === 'none' || s.kind === 'wait')) extraHtml += boughtForm(st);
      if (s.confirmed) {
        lines.push('<span class="muted">Ta liste est figée depuis l\'ouverture : ' + plural(s.extra, 'place') + ' pour d\'autres. Tu peux encore dire si tu viens.</span>');
        btns.push(s.absent
          ? btn('btn-primary', 'setAbsent', 'Finalement je viens', 'false', 'Reprendre ta place ? La personne qui l\'avait reprise repasse en tête de liste d\'attente.')
          : btn('', 'setAbsent', 'Je serai absent', 'true', releaseWarning(st, me, true)));
      } else if (s.kind === 'seat' || s.kind === 'wait') {
        btns.push(btn('btn-danger', 'unregister', 'Je n\'en veux plus', undefined, s.kind === 'wait' ? 'Quitter la liste d\'attente ?' : releaseWarning(st)));
      } else if (R.freeSeats(st).length) {
        lines.push('Il reste une place libre : tu peux la prendre plus bas.');
      }
    }
    return '<section class="card"><h2>Moi, ' + esc(nameOf(me)) + (s.isSub ? ' <span class="tag">abonné</span>' : '') + '</h2>' +
      lines.map(function (l) { return '<p>' + l + '</p>'; }).join('') +
      (btns.length ? '<div class="btn-row">' + btns.join('') + '</div>' : '') + extraHtml + '</section>';
  }

  function releaseWarning(st, who, season) {
    var wl = R.waitlistOf(st);
    var place = season ? 'ta place d\'abonné' : !who || who === me ? 'ta place' : 'sa place';
    return wl.length
      ? place.charAt(0).toUpperCase() + place.slice(1) + ' ira à ' + nameOf(wl[0]) + ' (1er en liste d\'attente)' + (season ? ', gratuitement' : ', avec le même acheteur') + '. Confirmer ?'
      : 'Personne n\'est en attente : ' + place + ' deviendra libre. Confirmer ?';
  }

  function inMatch(st, id) {
    return R.personStatus(st, id).kind !== 'none' || st.regs.some(function (r) { return r.memberId === id; });
  }

  /** Met à jour le résumé et les choix possibles du formulaire « Présent ? / Places dispo en plus ». */
  function syncDeclareForm(f, changed) {
    var present = f.querySelector('input[name=present]:checked').value === '1';
    var radios = f.querySelectorAll('input[name=extra]');
    var cur = +(f.querySelector('input[name=extra]:checked') || { value: 0 }).value;
    radios.forEach(function (r) { r.checked = +r.value === cur; });
    f.querySelector('.decl-sum').textContent =
      (cur ? 'Tu achèteras ' + plural(cur, 'place') + ' pour d\'autres' : 'Tu n\'achèteras aucune place pour d\'autres') +
      ' (ta place d\'abonné est déjà acquise).' +
      (present ? '' : ' Absent : ta place d\'abonné sera prêtée gratuitement au premier en liste d\'attente.');
  }

  function seatRow(st, ph, l, x, i) {
    var mid = esc(st.match.id);
    var cls = 'seat' + (!x.occupant && !x.refunded ? ' free-seat' : '') + (x.refunded ? ' refunded' : '');
    var name;
    if (x.refunded) name = 'Place remboursée par le club';
    else if (!x.occupant) name = x.season ? 'Place d\'abonné libre <small>(gratuite)</small>' : 'Place libre';
    else name = esc(nameOf(x.occupant)) + (x.own ? ' <small>(place d\'abonné)</small>' : x.season ? ' <span class="tag grey">place d\'abonné prêtée, gratuite</span>' : '') + (x.added ? ' <span class="tag">déjà achetée</span>' : x.personal ? ' <span class="tag">son invité</span>' : '') + (x.pinned ? ' <span class="tag grey">choisi à la main</span>' : '');
    var main = '<div class="seat-main"><span class="seat-name' + (x.occupant === me ? ' me' : '') + '">' + name + '</span>';
    if (ph !== 'terminee' && x.occupant && !x.own) {
      main += '<button class="x-btn" title="Retirer" aria-label="Retirer ' + esc(nameOf(x.occupant)) + '" data-act="ev" data-type="unregister" data-match="' + mid + '" data-member="' + esc(x.occupant) + '" data-confirm="' + esc((ph === 'avant' ? 'Retirer la demande de ' + nameOf(x.occupant) + ' ?' : nameOf(x.occupant) + ' se désiste. ' + releaseWarning(st, x.occupant))) + '">×</button>';
    }
    main += '</div>';
    var tools = '';
    if (ph === 'avant' && x.occupant && !x.season && !x.personal) {
      var targets = R.lists(st).filter(function (o) { return o.subId !== l.subId && o.purchased < o.extra; });
      if (targets.length) {
        tools += '<select data-change="move" data-match="' + mid + '" data-member="' + esc(x.occupant) + '" aria-label="Faire acheter par">' +
          '<option value="">Faire acheter par…</option>' +
          targets.map(function (o) { return '<option value="' + esc(o.subId) + '">' + esc(nameOf(o.subId)) + ' (' + o.purchased + '/' + o.extra + ')</option>'; }).join('') + '</select>';
      }
    }
    if (st.frozen && x.season) {
      if (x.occupant && !x.own) tools += '<span class="muted">Rien à acheter ni à payer</span>';
    } else if (st.frozen) {
      var dis = ph === 'terminee';
      tools += checkbox('setBought', st, x, 'Acheté', x.bought, dis || x.refunded, x.refunded ? 'Place remboursée' : '');
      if (!x.own || !x.occupant) {
        var payOk = x.occupant && x.occupant !== x.subId;
        tools += checkbox('setPaid', st, x, 'Payé', x.paid, !payOk, payOk ? '' : 'Personne ne doit rien pour cette place');
      }
      if (!x.occupant || x.refunded) {
        var refOk = !x.occupant && x.bought && !dis;
        tools += checkbox('setRefunded', st, x, 'Remboursé', x.refunded, !refOk, refOk ? '' : (x.bought ? '' : 'Seulement sur une place achetée'));
      }
    }
    var take = '';
    if (ph === 'ouverte' && !x.occupant && !x.refunded) {
      take = '<form class="inline-form" data-form="take" data-match="' + mid + '" data-seat="' + esc(x.id) + '">' +
        '<input type="text" name="name" list="names-take-' + mid + '" placeholder="Pour qui ?" value="' + esc(inMatch(st, me) ? '' : nameOf(me)) + '" required>' +
        '<button class="btn-primary btn-small" type="submit">Prendre la place</button></form>';
    }
    return '<li class="' + cls + '">' + main + (tools ? '<div class="seat-tools">' + tools + '</div>' : '') + take + '</li>';
  }

  function checkbox(type, st, x, label, checked, disabled, title) {
    return '<label class="check' + (disabled ? ' disabled' : '') + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' +
      '<input type="checkbox" data-change="flag" data-type="' + type + '" data-match="' + esc(st.match.id) + '" data-seat="' + esc(x.id) + '"' +
      (checked ? ' checked' : '') + (disabled ? ' disabled' : '') + '> ' + label + '</label>';
  }

  function sectionLists(st, ph) {
    var ls = R.lists(st);
    var html = '<section class="card"><h2>' + (st.frozen ? 'Qui achète pour qui (liste figée)' : 'Qui achète pour qui') + '</h2>';
    if (!st.frozen) html += '<p class="muted">Calculé automatiquement : chaque demande de place va à l\'abonné qui a le plus de places dispo. Les invités nommés par un abonné restent sur sa liste. La place d\'abonné d\'un absent est prêtée gratuitement. « Faire acheter par » change l\'acheteur à la main.</p>';
    if (!ls.length) html += '<p class="empty">Aucun abonné n\'a encore déclaré de places : pas encore de place.</p>';
    ls.forEach(function (l) {
      var mine = l.subId === me;
      html += '<div class="buyer"' + (mine ? ' style="border-color:var(--green)"' : '') + '><div class="buyer-head"><strong>' + esc(nameOf(l.subId)) + (mine ? ' (toi)' : '') + ' achète ' + plural(l.purchased, 'place') + '</strong>' +
        '<span>' + (l.absent ? '<span class="tag amber">absent</span> ' : '') + '<span class="tag grey" title="places achetées / déclarées">' + l.purchased + '/' + l.extra + '</span></span></div>' +
        '<ul class="seats">' + l.seats.map(function (x, i) { return seatRow(st, ph, l, x, i); }).join('') + '</ul>' +
        (!st.frozen && l.holes > 0 ? '<p class="hole">' + l.holes + ' place' + (l.holes > 1 ? 's' : '') + ' dispo</p>' : '') +
        (st.frozen && mine ? '' : '') + '</div>';
    });
    if (ph === 'ouverte') {
      html += '<datalist id="names-take-' + esc(st.match.id) + '">' + data.members.filter(function (m) { return R.personStatus(st, m.id).kind === 'none' || R.personStatus(st, m.id).kind === 'wait'; })
        .map(function (m) { return '<option value="' + esc(m.name) + '">'; }).join('') + '</datalist>';
    }
    var notConf = data.members.filter(function (m) { return m.type === 'abonne' && !st.confirms[m.id]; });
    if (notConf.length) html += '<p class="muted" style="margin-top:10px">' + (st.frozen ? 'Abonnés sans place à acheter : ' : 'Abonnés qui n\'ont pas encore déclaré leurs places : ') + notConf.map(function (m) { return esc(m.name); }).join(', ') + '.</p>';
    return html + '</section>';
  }

  function sectionWaitlist(st, ph) {
    var wl = R.waitlistOf(st);
    if (!wl.length) return '';
    return '<section class="card"><h2>Liste d\'attente (' + wl.length + ')</h2>' +
      '<p class="muted">Dans l\'ordre des demandes : le premier passe dès qu\'une place se libère.</p>' +
      '<ol class="waitlist">' + wl.map(function (id) {
        return '<li><div><span' + (id === me ? ' class="seat-name me"' : '') + '>' + esc(nameOf(id)) + '</span>' +
          (ph !== 'terminee' ? '<button class="x-btn" title="Retirer" aria-label="Retirer ' + esc(nameOf(id)) + '" data-act="ev" data-type="unregister" data-match="' + esc(st.match.id) + '" data-member="' + esc(id) + '" data-confirm="Retirer ' + esc(nameOf(id)) + ' de la liste d\'attente ?">×</button>' : '') +
          '</div></li>';
      }).join('') + '</ol></section>';
  }

  function waButtons(text) {
    return '<div class="btn-row"><button class="btn-small" data-act="copy" data-text="' + esc(text) + '">Copier</button>' +
      '<a class="btn btn-small btn-wa" href="https://wa.me/?text=' + encodeURIComponent(text) + '" target="_blank" rel="noopener">Envoyer sur WhatsApp</a></div>';
  }

  function sectionWhatsApp(st) {
    var recap = R.recapText(st);
    var html = '<section class="card"><h2>Textes pour WhatsApp</h2>' +
      '<h3>Récap complet</h3><textarea class="wa-text" readonly>' + esc(recap) + '</textarea>' + waButtons(recap);
    if (st.replacements.length) {
      html += '<h3 style="margin-top:16px">Remplacements</h3>';
      st.replacements.slice().reverse().forEach(function (r) {
        var t = R.replacementText(st, r);
        html += '<p class="muted" style="margin-top:10px">' + esc(new Date(r.ts).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })) + '</p>' +
          '<textarea class="wa-text wa-small" readonly>' + esc(t) + '</textarea>' + waButtons(t);
      });
    }
    return html + '</section>';
  }

  function sectionSchedule(st) {
    var m = st.match;
    return '<details class="card flat"><summary>Corriger la date ou l\'heure du match</summary>' +
      '<form data-form="schedule" data-match="' + esc(m.id) + '"><div class="grid-2">' +
      '<div><label class="field">Date</label><input type="date" name="date" required value="' + esc(m.date) + '"></div>' +
      '<div><label class="field">Heure</label><input type="time" name="time" value="' + esc(R.normalizeTime(m.time)) + '"></div></div>' +
      '<p class="muted">Le club déplace parfois les matchs. Sans heure, le match passe en lecture seule à minuit.</p>' +
      '<div class="btn-row"><button class="btn-primary" type="submit">Enregistrer</button></div></form></details>';
  }

  // ----- Ma liste (abonné) -----

  function allStates() {
    return sortedMatches().map(stateOf);
  }

  function viewMyList() {
    if (!isSub(me)) {
      return '<section class="card"><h2>Ma liste d\'achat</h2><p>Réservé aux abonnés : c\'est la liste des places qu\'un abonné achète sur le site du club.</p><p><a href="#/dettes">Voir à qui je dois de l\'argent →</a></p></section>';
    }
    var html = '<div class="section-title"><h2>Ma liste d\'achat</h2></div>';
    var states = allStates();
    var any = false;
    states.forEach(function (st) {
      if (R.phase(st) === 'terminee' || !st.confirms[me]) return;
      any = true;
      var l = R.lists(st).find(function (x) { return x.subId === me; });
      html += '<section class="card"><div class="mc-top"><h3><a href="#/m/' + encodeURIComponent(st.match.id) + '">Red Star – ' + esc(st.match.opponent) + '</a></h3>' + phaseBadge(st) + '</div>' +
        '<p class="mc-when">' + esc(R.formatMatchWhen(st.match)) + '</p>' +
        (st.frozen ? '' : '<p class="notice info">Liste provisoire : elle se fige à l\'ouverture de la billetterie.</p>') +
        '<ul class="seats">' + l.seats.map(function (x, i) { return seatRow(st, R.phase(st), l, x, i); }).join('') + '</ul></section>';
    });
    if (!any) html += '<div class="card empty">Tu n\'as déclaré de places sur aucun match à venir.</div>';

    var owed = [];
    states.forEach(function (st) {
      R.debts(st).forEach(function (d) { if (d.creditorId === me && !d.provisional) owed.push({ d: d, st: st }); });
    });
    owed.sort(function (a, b) { return (a.d.paid - b.d.paid); });
    var due = owed.filter(function (o) { return !o.d.paid; }).length * R.PRICE;
    html += '<div class="section-title"><h2>Qui me doit quoi</h2><small>' + due + ' € à recevoir</small></div><section class="card">';
    html += owed.length ? owed.map(function (o) {
      var x = o.st.seats.find(function (s) { return s.id === o.d.seatId; });
      return '<div class="row"><div class="grow"><b>' + esc(nameOf(o.d.debtorId)) + '</b><br><small>' + esc(o.st.match.opponent) + ' · ' + esc(R.formatDateFr(o.st.match.date)) + '</small></div>' +
        '<span class="amount">' + R.PRICE + ' €</span>' + checkbox('setPaid', o.st, x, 'Payé', x.paid, false, '') + '</div>';
    }).join('') : '<p class="empty">Personne ne te doit rien pour l\'instant.</p>';
    if (!member(me).payLink) html += '<p class="notice warn">Ajoute ton lien Lydia ou Wero dans l\'onglet <a href="#/moi">Moi</a> pour être payé plus vite.</p>';
    return html + '</section>';
  }

  // ----- Mes dettes -----

  function viewDebts() {
    var mine = [];
    allStates().forEach(function (st) {
      R.debts(st).forEach(function (d) { if (d.debtorId === me) mine.push({ d: d, st: st }); });
    });
    var due = mine.filter(function (o) { return !o.d.paid && !o.d.provisional; });
    var html = '<div class="section-title"><h2>Mes dettes</h2><small>' + (due.length * R.PRICE) + ' € à payer</small></div><section class="card">';
    if (!mine.length) html += '<p class="empty">Tu ne dois rien à personne.</p>';
    mine.forEach(function (o) {
      var d = o.d;
      var status = d.provisional ? '<span class="tag grey">prévu</span>' : d.paid ? '<span class="tag">payé</span>' : '<span class="tag red">à payer</span>';
      html += '<div class="row"><div class="grow"><b>' + R.PRICE + ' € à ' + esc(nameOf(d.creditorId)) + '</b> ' + status +
        '<br><small><a href="#/m/' + encodeURIComponent(o.st.match.id) + '">' + esc(o.st.match.opponent) + ' · ' + esc(R.formatDateFr(o.st.match.date)) + '</a>' +
        (d.provisional ? ' · acheteur prévu, peut encore changer' : d.bought ? ' · place achetée' : ' · pas encore achetée') + '</small></div>' +
        (!d.paid && !d.provisional ? payLinkHtml(d.creditorId, 'Payer') : '') + '</div>';
    });
    html += '</section><p class="muted" style="padding:0 6px">Une fois payé, c\'est l\'abonné qui coche « Payé » (dans « Ma liste » ou sur la page du match).</p>';
    return html;
  }

  // ----- Moi -----

  function viewMe() {
    var m = member(me);
    var html = '<section class="card"><h2>' + esc(m.name) + ' ' + (m.type === 'abonne' ? '<span class="tag">abonné</span>' : '<span class="tag grey">invité</span>') + '</h2>' +
      '<p class="muted">Ce téléphone se souvient de toi. Si ce n\'est pas toi :</p>' +
      '<button data-act="logout">Changer de personne</button></section>';
    if (m.type === 'abonne') {
      html += '<section class="card"><h2>Mon lien de paiement</h2>' +
        '<p class="muted">Lien Lydia ou Wero repris pour tous les matchs : chaque personne de ta liste le voit pour te payer ' + R.PRICE + ' €.</p>' +
        '<form class="inline-form" data-form="paylink"><input type="text" name="link" inputmode="url" placeholder="https://lydia.me/…" value="' + esc(m.payLink || '') + '">' +
        '<button class="btn-primary" type="submit">Enregistrer</button></form></section>';
    }
    html += '<section class="card flat"><h3>Comment ça marche</h3>' +
      '<p>1. Abonnés : sur chaque match, indiquez « Présent ? » et combien de places vous pouvez acheter pour d\'autres (0 à 4 ; votre place d\'abonné est déjà acquise). Absent ? Votre place d\'abonné est prêtée gratuitement au premier en attente. Sans réponse, vos places ne comptent pas. Un abonné peut aussi nommer un invité hors du groupe, qui prend une des places qu\'il achète.</p>' +
      '<p>2. Les autres disent simplement « Je veux une place ». L\'appli choisit qui achète pour qui ; au-delà des places déclarées, c\'est la liste d\'attente.</p>' +
      '<p>3. À l\'heure d\'ouverture de la billetterie, la liste se fige. Chaque abonné achète sa liste sur le site du club et coche « Acheté ».</p>' +
      '<p>4. Chacun paie ' + R.PRICE + ' € à l\'abonné qui achète sa place (onglet « Mes dettes »). Une place d\'abonné prêtée ne coûte rien.</p>' +
      '<p>5. Un désistement ? La place va au premier de la liste d\'attente. Copie le texte WhatsApp prêt sur la page du match.</p></section>';
    return html;
  }

  // ---------- Événements ----------

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t) return;
    var act = t.dataset.act;
    if (act === 'refresh') { load(false); return; }
    if (act === 'copy') { copyText(t.dataset.text); return; }
    if (act === 'pick') { setMe(t.dataset.id); return; }
    if (act === 'logout') { me = null; localStorage.removeItem(KEY_ME); pickQuery = ''; location.hash = '#/'; render(); return; }
    if (act === 'add-me') {
      var id = newId('i');
      send([{ type: 'addMember', id: id, name: pickQuery }], 'Bienvenue !').then(function (ok) { if (ok) setMe(id); });
      return;
    }
    if (act === 'clear-opening') {
      send([{ type: 'setOpening', matchId: t.dataset.match, value: '' }], 'Heure d\'ouverture effacée.');
      return;
    }
    if (act === 'ev') {
      if (t.dataset.confirm && !window.confirm(t.dataset.confirm)) return;
      var a = { type: t.dataset.type, matchId: t.dataset.match, memberId: t.dataset.member };
      if (t.dataset.value !== undefined) a.value = t.dataset.value === 'true';
      send([a], okMessage(a));
    }
  });

  function okMessage(a) {
    return {
      register: 'Demande de place enregistrée.', unregister: 'C\'est noté.', confirm: 'Merci, c\'est noté.',
      unconfirm: 'C\'est noté : tes places sont retirées.', setAbsent: a.value ? 'Absence enregistrée.' : 'Bon retour !', move: 'Déplacement enregistré.'
    }[a.type] || 'Enregistré.';
  }

  function setMe(id) {
    me = id;
    localStorage.setItem(KEY_ME, id);
    render();
  }

  document.addEventListener('input', function (e) {
    if (e.target.dataset.input === 'pick') { pickQuery = e.target.value; renderPickList(); }
  });

  document.addEventListener('change', function (e) {
    var t = e.target;
    var decl = t.closest('form[data-form=declare]');
    if (decl) { syncDeclareForm(decl, t.name); return; }
    if (t.dataset.change === 'flag') {
      send([{ type: t.dataset.type, matchId: t.dataset.match, seatId: t.dataset.seat, value: t.checked }], null).then(function (ok) { if (!ok) render(); });
    } else if (t.dataset.change === 'move' && t.value) {
      send([{ type: 'move', matchId: t.dataset.match, memberId: t.dataset.member, target: t.value }], 'Place désormais achetée par ' + nameOf(t.value) + '.');
    }
  });

  document.addEventListener('submit', function (e) {
    var f = e.target.closest('form[data-form]');
    if (!f) return;
    e.preventDefault();
    var kind = f.dataset.form;
    var fd = new FormData(f);
    var mid = f.dataset.match;
    if (kind === 'declare') {
      var present = fd.get('present') === '1';
      var extra = +fd.get('extra');
      var dval = (present ? '1' : '0') + ':' + extra;
      var prev = R.personStatus(stateOf(match(mid)), me);
      if (prev.confirmed && dval === (prev.absent ? '0' : '1') + ':' + prev.extra) { toast('Rien n\'a changé.'); return; }
      send([{ type: 'declare', matchId: mid, memberId: me, value: dval }],
        'C\'est noté : ' + (extra ? 'tu achètes ' + plural(extra, 'place') + ' pour d\'autres' : 'tu n\'achètes aucune place') +
        (present ? '.' : ', et ta place d\'abonné est prêtée.'));
    } else if (kind === 'guest' || kind === 'take' || kind === 'bought') {
      var name = R.cleanName(fd.get('name'));
      var existing = R.findMemberByName(data.members, name);
      var acts = [];
      var pid = existing ? existing.id : newId('i');
      if (!existing) acts.push({ type: 'addMember', id: pid, name: name });
      acts.push(kind === 'guest'
        ? { type: 'addGuest', matchId: mid, memberId: pid, target: me, by: me }
        : kind === 'bought'
          ? { type: 'addBought', matchId: mid, memberId: pid, target: me, by: me }
          : { type: 'takeSeat', matchId: mid, memberId: pid, seatId: f.dataset.seat, by: me });
      var shown = existing ? existing.name : name;
      send(acts, kind === 'guest' ? shown + ' prend une de tes places.' : kind === 'bought' ? 'Place achetée ajoutée pour ' + shown + '.' : shown + ' prend la place.');
    } else if (kind === 'opening') {
      send([{ type: 'setOpening', matchId: mid, value: fd.get('d') + ' ' + fd.get('t') }], 'Heure d\'ouverture enregistrée.');
    } else if (kind === 'schedule') {
      send([{ type: 'setSchedule', matchId: mid, date: fd.get('date'), time: fd.get('time') || '' }], 'Date du match corrigée.');
    } else if (kind === 'add-match') {
      send([{ type: 'addMatch', id: newId('m'), opponent: fd.get('opponent'), date: fd.get('date'), time: fd.get('time') || '', competition: fd.get('competition') }], 'Match ajouté.');
    } else if (kind === 'paylink') {
      send([{ type: 'setPayLink', memberId: me, value: String(fd.get('link') || '').trim() }], 'Lien de paiement enregistré.');
    }
  });

  window.addEventListener('hashchange', render);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) load(true); });
  setInterval(function () {
    var a = document.activeElement;
    var typing = a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName);
    if (!document.hidden && !busy && !typing) load(true);
  }, REFRESH_MS);

  // ---------- Mode démo (sans serveur) ----------

  function demoBackend() {
    function read() {
      try { return JSON.parse(localStorage.getItem(KEY_DEMO_DB)); } catch (e) { return null; }
    }
    function write(db) { localStorage.setItem(KEY_DEMO_DB, JSON.stringify(db)); }
    function snapshot(db) { return JSON.parse(JSON.stringify({ members: db.members, matches: db.matches, events: db.events, now: Date.now() })); }
    function later(v) { return new Promise(function (res) { setTimeout(function () { res(v); }, 150); }); }

    function handle(db, a) {
      var t = Date.now();
      if (a.type === 'addMember') {
        var err = R.validateNewName(db.members, a.name);
        if (err) return err;
        db.members.push({ id: a.id || newId('i'), name: R.cleanName(a.name), type: 'invite', payLink: '' });
        return null;
      }
      if (a.type === 'setPayLink') {
        var mm = db.members.find(function (x) { return x.id === a.memberId; });
        if (!mm || mm.type !== 'abonne') return 'Seuls les abonnés renseignent un lien de paiement.';
        mm.payLink = String(a.value || '').trim();
        return null;
      }
      if (a.type === 'addMatch') {
        if (!R.cleanName(a.opponent) || !/^\d{4}-\d{2}-\d{2}$/.test(a.date || '')) return 'Adversaire et date obligatoires.';
        db.matches.push({ id: a.id, opponent: R.cleanName(a.opponent), competition: R.cleanName(a.competition) || 'Coupe de France', date: a.date, time: R.normalizeTime(a.time), opening: '' });
        return null;
      }
      var m = db.matches.find(function (x) { return x.id === a.matchId; });
      if (!m) return 'Match introuvable.';
      var started = t >= R.kickoffMs(m);
      if (a.type === 'setSchedule') {
        if (started) return 'Match commencé : lecture seule.';
        m.date = a.date; m.time = R.normalizeTime(a.time);
        return null;
      }
      if (a.type === 'setOpening') {
        if (started) return 'Match commencé : lecture seule.';
        var cur = R.openingMs(m);
        if (cur !== null && cur <= t) return 'La billetterie est déjà ouverte : l\'heure d\'ouverture ne se modifie plus.';
        if (!a.value) { m.opening = ''; return null; }
        var ms = R.openingMs({ opening: a.value });
        if (ms === null) return 'Date ou heure d\'ouverture invalide.';
        m.opening = ms < t ? parisLocal(t + 60000) : a.value;
        return null;
      }
      if (started && a.type !== 'setPaid') return 'Match commencé : lecture seule.';
      db.seq += 1;
      db.events.push({ seq: db.seq, ts: t, matchId: m.id, type: a.type, memberId: a.memberId || '', by: a.by || '', target: a.target || '', seatId: a.seatId || '', value: a.value === undefined ? '' : String(a.value) });
      return null;
    }

    return {
      load: function () {
        var db = read();
        if (!db) { db = demoSeed(); write(db); }
        return later({ ok: true, data: snapshot(db) });
      },
      send: function (actions) {
        var db = read() || demoSeed();
        for (var i = 0; i < actions.length; i++) {
          var err = handle(db, actions[i]);
          if (err) { write(db); return later({ ok: false, error: err, data: snapshot(db) }); }
        }
        write(db);
        return later({ ok: true, data: snapshot(db) });
      }
    };
  }

  function demoSeed() {
    var t = Date.now();
    var subs = ['Karim', 'Sophie', 'Julien', 'Nadia', 'Thomas', 'Léa', 'Mehdi', 'Camille', 'Antoine'];
    var guests = ['Paul B.', 'Inès', 'Yanis', 'Chloé', 'Hugo', 'Sarah', 'Lucas', 'Emma', 'Nico', 'Jade', 'Malik', 'Zoé', 'Bastien', 'Lina',
      'Rayan', 'Manon', 'Théo', 'Alice', 'Samir', 'Clara', 'Ilyes', 'Louise', 'Max', 'Anaïs', 'Victor', 'Elsa', 'Omar', 'Julie'];
    var members = subs.map(function (n, i) { return { id: 'a' + (i + 1), name: n, type: 'abonne', payLink: i < 6 ? 'https://lydia.me/' + R.normalizeName(n) : '' }; })
      .concat(guests.map(function (n, i) { return { id: 'g' + (i + 1), name: n, type: 'invite', payLink: '' }; }))
      .concat([{ id: 'x1', name: 'Jean-Marc', type: 'invite', payLink: '' }, { id: 'x2', name: 'Martine', type: 'invite', payLink: '' }]);
    var cal = [['Pau', '2026-11-20', '20:00'], ['Grenoble', '2026-12-12', ''], ['Annecy', '2027-01-15', ''], ['Laval', '2027-01-29', ''],
      ['Montpellier', '2027-02-05', ''], ['Guingamp', '2027-02-26', ''], ['Dijon', '2027-03-12', ''], ['Boulogne', '2027-04-02', ''],
      ['Nantes', '2027-04-16', ''], ['Rodez', '2027-04-23', ''], ['Dunkerque', '2027-05-07', ''], ['Clermont', '2027-05-22', '']];
    var matches = cal.map(function (c, i) { return { id: 'm' + ('0' + (i + 1)).slice(-2), opponent: c[0], competition: 'Ligue 2', date: c[1], time: c[2], opening: '' }; });
    // Données fictives : on décale les deux premiers matchs si la date réelle est déjà passée.
    if (R.kickoffMs(matches[0]) < t + 86400000) matches[0].date = parisLocal(t + 3 * 86400000).slice(0, 10);
    if (R.kickoffMs(matches[1]) < t + 10 * 86400000) matches[1].date = parisLocal(t + 25 * 86400000).slice(0, 10);
    matches[0].opening = parisLocal(t - 2 * 3600000);
    matches[1].opening = parisLocal(t + 2 * 86400000 + 3 * 3600000).slice(0, 10) + ' 12:00';

    var events = [];
    var seq = 0;
    function ev(matchId, ts, type, memberId, extra) {
      seq += 1;
      events.push(Object.assign({ seq: seq, ts: ts, matchId: matchId, type: type, memberId: memberId, by: memberId, target: '', seatId: '', value: '' }, extra || {}));
    }
    // Pau : billetterie ouverte il y a 2 h, liste figée.
    var t0 = t - 4 * 86400000;
    var step = 0;
    function at() { step += 1; return t0 + step * 600000; }
    var decl = { a1: '1:3', a2: '1:3', a3: '1:3', a4: '1:3', a5: '1:2', a6: '1:3', a7: '1:1', a8: '0:4' };
    Object.keys(decl).forEach(function (id) { ev('m01', at(), 'declare', id, { value: decl[id] }); });
    ev('m01', at(), 'addGuest', 'x1', { target: 'a1', by: 'a1' });
    ev('m01', at(), 'addGuest', 'g4', { target: 'a3', by: 'a3' });
    for (var i = 1; i <= 24; i++) if (i !== 4) ev('m01', at(), 'register', 'g' + i);
    ev('m01', at(), 'move', 'g9', { target: 'a6', by: 'a6' });
    var tOpen = t - 2 * 3600000 + 60000;
    ev('m01', tOpen + 1000, 'setBought', '', { seatId: 'a1:2', value: 'true', by: 'a1' });
    ev('m01', tOpen + 2000, 'setBought', '', { seatId: 'a1:3', value: 'true', by: 'a1' });
    ev('m01', tOpen + 3000, 'setBought', '', { seatId: 'a1:4', value: 'true', by: 'a1' });
    ev('m01', tOpen + 4000, 'setPaid', '', { seatId: 'a1:2', value: 'true', by: 'a1' });
    ev('m01', tOpen + 5000, 'setBought', '', { seatId: 'a2:2', value: 'true', by: 'a2' });
    ev('m01', tOpen + 6000, 'setBought', '', { seatId: 'a2:3', value: 'true', by: 'a2' });
    ev('m01', tOpen + 600000, 'unregister', 'g3', { by: 'g3' });
    ev('m01', tOpen + 900000, 'setPaid', '', { seatId: 'a1:3', value: 'true', by: 'a1' });

    // Grenoble : inscriptions en cours, ouverture dans deux jours.
    step = 0;
    t0 = t - 2 * 86400000;
    var decl2 = { a2: '1:3', a1: '1:3', a4: '1:2', a5: '1:1', a3: '1:2' };
    Object.keys(decl2).forEach(function (id) { ev('m02', at(), 'declare', id, { value: decl2[id] }); });
    ev('m02', at(), 'addGuest', 'x2', { target: 'a4', by: 'a4' });
    [1, 2, 5, 6, 8, 10, 11, 12].forEach(function (n) { ev('m02', at(), 'register', 'g' + n); });
    ev('m02', at(), 'move', 'g5', { target: 'a3', by: 'a1' });

    // Annecy : peu de places déclarées, déjà pleines (une nouvelle demande va en liste d'attente).
    step = 0;
    t0 = t - 86400000;
    ev('m03', at(), 'declare', 'a1', { value: '1:1' });
    ev('m03', at(), 'declare', 'a2', { value: '1:1' });
    ev('m03', at(), 'register', 'g1');
    ev('m03', at(), 'register', 'g2');
    return { members: members, matches: matches, events: events, seq: seq };
  }

  function showDemoBanner() {
    var b = document.getElementById('demo-banner');
    b.hidden = false;
    b.innerHTML = '<span><b>Mode démo</b> : données fictives, gardées sur ce téléphone uniquement.</span><button data-act-demo="reset">Réinitialiser</button>';
    b.querySelector('button').addEventListener('click', function () {
      localStorage.removeItem(KEY_DEMO_DB);
      load(false);
      toast('Démo réinitialisée.');
    });
  }

  // ---------- Démarrage ----------

  if (DEMO) {
    showDemoBanner();
    var as = params.get('moi');
    if (as) {
      api.load().then(function (res) {
        var m = R.findMemberByName(res.data.members, as);
        if (m) { me = m.id; localStorage.setItem(KEY_ME, m.id); }
        load(false);
      });
    } else load(false);
  } else load(false);
})();
