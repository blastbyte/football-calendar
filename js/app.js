/* MATCHDAY 26/27 — interactive football calendar
   Data: ESPN public site API (CORS-enabled). No build step, no dependencies. */
(() => {
  "use strict";

  const API = "https://site.api.espn.com/apis/site/v2/sports/soccer/";
  const LEAGUES = {
    "eng.1": { name: "Premier League", short: "PL", logo: "https://a.espncdn.com/i/leaguelogos/soccer/500-dark/23.png" },
    "esp.1": { name: "LaLiga", short: "LaLiga", logo: "https://a.espncdn.com/i/leaguelogos/soccer/500-dark/15.png" },
    "ger.1": { name: "Bundesliga", short: "Bundesliga", logo: "https://a.espncdn.com/i/leaguelogos/soccer/500-dark/10.png" },
  };
  const MONTHS = ["202608", "202609", "202610", "202611", "202612", "202701", "202702", "202703", "202704", "202705"];
  const CACHE_KEY = "matchday-2627-v1";
  const PREFS_KEY = "matchday-2627-prefs";
  const PHOTOS = window.VENUE_PHOTOS || {};

  const state = {
    league: "all",
    status: "all",
    team: "",
    matches: [],
    byId: new Map(),
    summaries: new Map(),
    openId: null,
    heroId: null,
  };

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---------------- storage (all wrapped: may be unavailable) ---------------- */
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota / private mode */ } },
  };

  /* ---------------- formatting ---------------- */
  const fmt = {
    time: (d) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
    dayLong: (d) => d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }),
    dayShort: (d) => d.toLocaleDateString(undefined, { weekday: "short", day: "2-digit", month: "short" }),
    monthName: (d) => d.toLocaleDateString(undefined, { month: "long" }),
  };
  const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const darkLogo = (url) => (url ? url.replace("/teamlogos/soccer/500/", "/teamlogos/soccer/500-dark/") : "");
  const photo = (venueId, size = 960) => {
    const u = PHOTOS[venueId];
    if (!u) return "";
    return size === 1280 ? u : u.replace("/1280px-", `/${size}px-`);
  };

  /* ---------------- normalise ESPN event ---------------- */
  function normalize(ev, league) {
    const c = ev.competitions?.[0] || {};
    const st = c.status?.type || ev.status?.type || {};
    const side = (s) => c.competitors?.find((x) => x.homeAway === s) || {};
    const team = (t) => ({
      id: t.team?.id,
      name: t.team?.displayName || "TBC",
      short: t.team?.shortDisplayName || t.team?.displayName || "TBC",
      abbr: t.team?.abbreviation || "",
      logo: t.team?.logo || "",
      score: t.score !== undefined && t.score !== "" ? Number(t.score) : null,
      winner: !!t.winner,
      form: t.form || "",
      record: t.records?.[0]?.summary || "",
    });
    const name = st.name || "";
    let kind = "pre";
    if (st.completed) kind = "ft";
    else if (st.state === "in") kind = "live";
    else if (/POSTPONED|CANCELED|CANCELLED|SUSPENDED|ABANDONED|DELAYED/.test(name)) kind = "ppd";
    else if (st.state === "post") kind = "ft";

    const details = (c.details || [])
      .map((d) => {
        const k = d.redCard ? "red" : d.yellowCard ? "yellow" : d.scoringPlay ? "goal" : null;
        if (!k) return null;
        const a = d.athletesInvolved?.[0];
        return { k, min: d.clock?.displayValue || "", team: d.team?.id, p: a?.shortName || a?.displayName || "", pen: !!d.penaltyKick, og: !!d.ownGoal };
      })
      .filter(Boolean);

    return {
      id: ev.id,
      league,
      date: ev.date,
      kind,
      statusText: st.shortDetail || st.detail || "",
      statusName: name,
      clock: c.status?.displayClock || "",
      venue: { id: c.venue?.id || "", name: c.venue?.fullName || "", city: c.venue?.address?.city || "" },
      attendance: c.attendance || 0,
      home: team(side("home")),
      away: team(side("away")),
      details,
      broadcasts: (c.broadcasts || []).flatMap((b) => b.names || []).slice(0, 3),
    };
  }

  const result = (m) => {
    if (m.kind !== "ft" || m.home.score == null) return null;
    if (m.home.score > m.away.score) return "home";
    if (m.away.score > m.home.score) return "away";
    return "draw";
  };

  /* ---------------- data loading ---------------- */
  async function fetchJSON(url, tries = 2) {
    for (let i = 0; i <= tries; i++) {
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
      } catch (e) {
        if (i === tries) throw e;
        await new Promise((res) => setTimeout(res, 400 * (i + 1)));
      }
    }
  }
  async function fetchMonth(league, month) {
    const d = await fetchJSON(`${API}${league}/scoreboard?dates=${month}&limit=400`);
    return (d.events || []).map((e) => normalize(e, league));
  }
  async function pool(tasks, size) {
    const out = [];
    let i = 0;
    const workers = Array.from({ length: size }, async () => {
      while (i < tasks.length) {
        const idx = i++;
        try { out[idx] = await tasks[idx](); } catch (e) { out[idx] = { error: e }; }
      }
    });
    await Promise.all(workers);
    return out;
  }

  function setMatches(list) {
    const map = new Map(state.byId);
    list.forEach((m) => map.set(m.id, m));
    state.byId = map;
    state.matches = [...map.values()].sort((a, b) => new Date(a.date) - new Date(b.date) || a.league.localeCompare(b.league));
  }

  async function loadAll() {
    const cached = store.get(CACHE_KEY);
    if (cached?.matches?.length) {
      setMatches(cached.matches);
      renderAll();
    }
    const tasks = Object.keys(LEAGUES).flatMap((l) => MONTHS.map((m) => () => fetchMonth(l, m)));
    const res = await pool(tasks, 8);
    const ok = res.filter((r) => Array.isArray(r));
    if (!ok.length && !state.matches.length) {
      $("#calendar").innerHTML = `<div class="error-box"><b>Couldn't load fixtures.</b><p class="d-muted">The match data service didn't respond. Check your connection and refresh.</p></div>`;
      $("#heroInner").innerHTML = "";
      return;
    }
    setMatches(ok.flat());
    store.set(CACHE_KEY, { t: Date.now(), matches: state.matches });
    renderAll();
  }

  /* Live refresh: re-poll the months that contain matches around "now". */
  async function refreshLive() {
    const now = Date.now();
    const hot = state.matches.filter((m) => {
      const t = new Date(m.date).getTime();
      return m.kind === "live" || (m.kind === "pre" && t < now + 2 * 60e3 && t > now - 4 * 3600e3);
    });
    if (!hot.length) return;
    const keys = new Set(hot.map((m) => { const d = new Date(m.date); return `${m.league}|${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`; }));
    const res = await pool([...keys].map((k) => () => { const [l, mo] = k.split("|"); return fetchMonth(l, mo); }), 4);
    setMatches(res.filter(Array.isArray).flat());
    store.set(CACHE_KEY, { t: Date.now(), matches: state.matches });
    renderAll(true);
    if (state.openId && state.byId.get(state.openId)?.kind === "live") {
      state.summaries.delete(state.openId);
      openMatch(state.openId, true);
    }
  }

  /* ---------------- filtering ---------------- */
  function leagueMatches() {
    return state.matches.filter((m) => state.league === "all" || m.league === state.league);
  }
  function teamMatches() {
    return leagueMatches().filter((m) => !state.team || m.home.id === state.team || m.away.id === state.team);
  }
  function visibleMatches() {
    const list = teamMatches().filter((m) => {
      if (state.status === "upcoming") return m.kind !== "ft";
      if (state.status === "results") return m.kind === "ft" || m.kind === "live";
      return true;
    });
    if (state.status === "results") list.reverse();
    return list;
  }

  /* ---------------- small HTML helpers ---------------- */
  const ballSvg = `<svg class="ico-ball" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#fff"/><path d="M12 7.2l3.6 2.6-1.4 4.2H9.8L8.4 9.8z" fill="#1a0d30"/><path d="M12 2v5.2M15.6 9.8l4.9-1.6M14.2 14l3 4.2M9.8 14l-3 4.2M8.4 9.8 3.5 8.2" stroke="#1a0d30" stroke-width="1.3"/></svg>`;
  const crest = (t, cls = "crest", size = "") => t.logo
    ? `<img class="${cls}" data-crest src="${esc(darkLogo(t.logo))}" data-fallback="${esc(t.logo)}" alt="${esc(t.name)} crest" loading="lazy" ${size}>`
    : `<span class="${cls}"></span>`;
  const leagueChip = (l) => `<span class="league-chip"><img src="${LEAGUES[l].logo}" alt="">${LEAGUES[l].short}</span>`;
  const formDots = (f) => f ? `<span class="form" title="Recent form">${[...f.slice(-5)].map((c) => `<i class="${c}">${c}</i>`).join("")}</span>` : "";
  function statusChip(m) {
    const d = new Date(m.date);
    if (m.kind === "live") return `<span class="status live">${esc(m.statusName === "STATUS_HALFTIME" ? "HT" : m.clock || "LIVE")}</span>`;
    if (m.kind === "ft") return `<span class="status ft">${esc(m.statusText || "FT")}</span>`;
    if (m.kind === "ppd") return `<span class="status ppd">${esc(m.statusText || "Postponed")}</span>`;
    return `<span class="status ko">${fmt.time(d)}</span>`;
  }

  /* ---------------- card ---------------- */
  function cardHTML(m) {
    const r = result(m);
    const played = m.kind === "ft" || m.kind === "live";
    const img = photo(m.venue.id);
    const row = (side) => {
      const t = m[side];
      const cls = r === side ? "is-winner" : r && r !== "draw" ? "is-loser" : "";
      const right = played
        ? `<span class="score">${t.score ?? "–"}</span>`
        : formDots(t.form);
      return `<div class="row ${cls}">
        ${crest(t)}
        <span class="tname">${esc(t.name)}${r === side ? `<span class="win-tag">Win</span>` : ""}</span>
        ${right}
      </div>`;
    };
    const goals = m.details.filter((d) => d.k === "goal");
    const ev = (teamId) => goals.filter((g) => g.team === teamId).map((g) =>
      `<li>${ballSvg}<span><b>${esc(g.p)}</b> ${esc(g.min)}${g.pen ? " (P)" : ""}${g.og ? " (OG)" : ""}</span></li>`).join("");
    const yel = m.details.filter((d) => d.k === "yellow").length;
    const red = m.details.filter((d) => d.k === "red").length;
    const d = new Date(m.date);
    const events = goals.length
      ? `<div class="card-events"><ul class="home">${ev(m.home.id)}</ul><ul class="away">${ev(m.away.id)}</ul></div>`
      : "";
    const foot = played
      ? `<span class="bookings">${yel ? `<span><i class="cardico y"></i>${yel}</span>` : ""}${red ? `<span><i class="cardico r"></i>${red}</span>` : ""}${!yel && !red ? "No bookings" : ""}</span>`
      : `<span>${m.kind === "ppd" ? "Date TBC" : `Kick-off ${fmt.time(d)}`}</span>`;
    return `<article class="card ${m.kind === "live" ? "is-live" : ""} ${r === "draw" ? "is-draw" : ""}" data-id="${m.id}" data-league="${m.league}" tabindex="0" role="button" aria-label="${esc(`${m.home.name} vs ${m.away.name}`)}">
      <div class="card-photo">
        <div class="photo-fallback"></div>
        ${img ? `<img src="${esc(img)}" alt="" loading="lazy" data-photo>` : ""}
        <div class="card-top">${leagueChip(m.league)}${statusChip(m)}</div>
        <div class="card-venue">${esc(m.venue.name)}${m.venue.city ? ` · ${esc(m.venue.city)}` : ""}</div>
      </div>
      <div class="card-body">
        ${row("home")}
        ${row("away")}
        ${events}
        <div class="card-foot">${foot}<span class="more">${played ? "Match centre" : "Preview"} →</span></div>
      </div>
    </article>`;
  }

  /* ---------------- calendar ---------------- */
  function renderCalendar() {
    const list = visibleMatches();
    const cal = $("#calendar");
    if (!list.length) {
      cal.innerHTML = `<div class="empty"><b>No matches</b>Try a different league, team or status filter.</div>`;
      renderMonthNav([]);
      return;
    }
    const todayKey = dayKey(new Date());
    const months = new Map();
    for (const m of list) {
      const d = new Date(m.date);
      const mk = monthKey(d), dk = dayKey(d);
      if (!months.has(mk)) months.set(mk, { date: d, days: new Map(), count: 0 });
      const mo = months.get(mk);
      mo.count++;
      if (!mo.days.has(dk)) mo.days.set(dk, { date: d, items: [] });
      mo.days.get(dk).items.push(m);
    }
    let html = "";
    for (const [mk, mo] of months) {
      html += `<section class="month-block" id="m-${mk}" data-month="${mk}">
        <div class="month-head"><h3>${fmt.monthName(mo.date)} <span>${mo.date.getFullYear()}</span></h3><span class="count">${mo.count} match${mo.count === 1 ? "" : "es"}</span></div>`;
      for (const [dk, day] of mo.days) {
        const d = day.date;
        html += `<div class="day-block" data-day="${dk}">
          <div class="day-head">
            <span class="day-name">${d.toLocaleDateString(undefined, { weekday: "short" })} <em>${d.toLocaleDateString(undefined, { day: "2-digit", month: "short" })}</em></span>
            ${dk === todayKey ? `<span class="today-badge">TODAY</span>` : ""}
            <span class="rule"></span>
            <span class="day-count">${day.items.length} match${day.items.length === 1 ? "" : "es"}</span>
          </div>
          <div class="grid">${day.items.map(cardHTML).join("")}</div>
        </div>`;
      }
      html += `</section>`;
    }
    cal.innerHTML = html;
    renderMonthNav([...months.keys()]);
  }

  function renderMonthNav(present) {
    const nav = $("#monthNav");
    const set = new Set(present);
    const cur = monthKey(new Date());
    nav.innerHTML = MONTHS.map((m) => {
      const mk = `${m.slice(0, 4)}-${m.slice(4)}`;
      const d = new Date(+m.slice(0, 4), +m.slice(4) - 1, 1);
      const label = d.toLocaleDateString(undefined, { month: "short" });
      return `<button class="month-btn ${set.has(mk) ? "" : "is-empty"} ${mk === cur ? "is-current" : ""}" data-month="${mk}">${label}</button>`;
    }).join("");
  }

  /* ---------------- season stats ---------------- */
  function renderSeason() {
    const list = teamMatches();
    const played = list.filter((m) => m.kind === "ft");
    const goals = played.reduce((s, m) => s + (m.home.score || 0) + (m.away.score || 0), 0);
    const leagueName = state.league === "all" ? "Premier League · LaLiga · Bundesliga" : LEAGUES[state.league].name;
    let stats;
    if (state.team) {
      const t = state.team;
      let w = 0, dr = 0, l = 0, gf = 0, ga = 0;
      for (const m of played) {
        const home = m.home.id === t;
        const f = home ? m.home.score : m.away.score, a = home ? m.away.score : m.home.score;
        gf += f; ga += a;
        if (f > a) w++; else if (f === a) dr++; else l++;
      }
      const teamName = (list[0] && (list[0].home.id === t ? list[0].home.name : list[0].away.name)) || "";
      $("#seasonEyebrow").textContent = `${teamName} · ${leagueName}`;
      stats = [["Played", played.length], ["Won", w], ["Drawn", dr], ["Lost", l], ["Goals for", gf], ["Against", ga], ["Points", w * 3 + dr]];
    } else {
      $("#seasonEyebrow").textContent = leagueName;
      stats = [["Matches", list.length], ["Played", played.length], ["To play", list.length - played.length], ["Goals", goals], ["Per game", played.length ? (goals / played.length).toFixed(2) : "0"]];
    }
    $("#seasonStats").innerHTML = stats.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("");
    $("#progressFill").style.width = list.length ? `${(played.length / list.length) * 100}%` : "0";
  }

  /* ---------------- team filter ---------------- */
  function renderTeamOptions() {
    const sel = $("#teamFilter");
    const teams = new Map();
    for (const m of leagueMatches()) for (const t of [m.home, m.away]) if (t.id) teams.set(t.id, t.name);
    const sorted = [...teams].sort((a, b) => a[1].localeCompare(b[1]));
    if (state.team && !teams.has(state.team)) state.team = "";
    sel.innerHTML = `<option value="">All teams</option>` + sorted.map(([id, n]) => `<option value="${id}" ${id === state.team ? "selected" : ""}>${esc(n)}</option>`).join("");
  }

  /* ---------------- hero ---------------- */
  let countdownTimer = null;
  function pickHero() {
    const list = teamMatches();
    const now = Date.now();
    const live = list.filter((m) => m.kind === "live");
    const upcoming = list.filter((m) => m.kind === "pre" && new Date(m.date).getTime() > now - 5 * 60e3);
    let hero, mode;
    if (live.length) { hero = live[0]; mode = "live"; }
    else if (upcoming.length) { hero = upcoming[0]; mode = "next"; }
    else { hero = list.filter((m) => m.kind === "ft").at(-1); mode = "last"; }
    const side = [...live.filter((m) => m !== hero), ...upcoming.filter((m) => m !== hero)].slice(0, 5);
    return { hero, mode, side };
  }

  function renderHero() {
    const { hero: m, mode, side } = pickHero();
    const inner = $("#heroInner");
    clearInterval(countdownTimer);
    if (!m) { inner.innerHTML = `<div><p class="hero-tag">No matches for this filter</p></div>`; return; }

    const bg = $("#heroBg");
    const src = photo(m.venue.id, 1280);
    if (state.heroId !== m.id || !bg.querySelector("img")) {
      bg.innerHTML = src ? `<img src="${esc(src)}" alt="" data-photo>` : "";
    }
    state.heroId = m.id;

    const d = new Date(m.date);
    const r = result(m);
    const tag = mode === "live" ? `<span class="hero-tag is-live"><span class="dot"></span>Live now</span>`
      : mode === "next" ? `<span class="hero-tag"><span class="dot"></span>Next match</span>`
      : `<span class="hero-tag">Latest result</span>`;
    const centre = mode === "next"
      ? `<span class="hero-vs">VS</span>`
      : `<div><div class="hero-score"><span>${m.home.score ?? 0}</span><span class="sep">–</span><span>${m.away.score ?? 0}</span></div>
          <span class="hero-score minute">${mode === "live" ? esc(m.statusName === "STATUS_HALFTIME" ? "HALF TIME" : m.clock) : "FULL TIME"}</span></div>`;
    const teamBlock = (s) => `<div class="hero-team">
        ${crest(m[s], "crest", 'loading="eager"')}
        <div class="name" ${r === s ? 'style="color:var(--green)"' : ""}>${esc(m[s].short)}</div>
        <div class="sub">${s === "home" ? "Home" : "Away"}${m[s].record ? ` · ${esc(m[s].record.split("-").map((n, i) => "WDL"[i] + n).join(" "))}` : ""}</div>
      </div>`;

    inner.innerHTML = `
      <div class="hero-main">
        <div class="hero-meta-top">${tag}${leagueChip(m.league)}</div>
        <div class="hero-match">${teamBlock("home")}${centre}${teamBlock("away")}</div>
        <div class="hero-info">
          <span class="date-flag">${fmt.dayShort(d)} · ${fmt.time(d)}</span>
          <span>${esc(m.venue.name)}</span>${m.venue.city ? `<span class="sep"></span><span>${esc(m.venue.city)}</span>` : ""}
          ${m.broadcasts.length ? `<span class="sep"></span><span>${esc(m.broadcasts.join(" · "))}</span>` : ""}
        </div>
        ${mode === "next" ? `<div class="countdown" id="countdown">
          <div class="cd-box"><b data-cd="d">00</b><small>DAYS</small></div>
          <div class="cd-box"><b data-cd="h">00</b><small>HRS</small></div>
          <div class="cd-box"><b data-cd="m">00</b><small>MINS</small></div>
          <div class="cd-box"><b data-cd="s">00</b><small>SECS</small></div>
        </div>` : ""}
        <div class="hero-actions">
          <button class="btn btn-primary" data-open="${m.id}">${mode === "next" ? "Match preview" : "Match centre"} <span aria-hidden="true">→</span></button>
          <button class="btn" data-jump="today">Full calendar</button>
        </div>
      </div>
      <aside class="hero-side">
        <p class="side-title">${side.some((x) => x.kind === "live") ? "Also live / up next" : "Up next"}</p>
        ${side.map((x) => {
          const xd = new Date(x.date);
          return `<button class="side-match" data-open="${x.id}">
            <span class="teams">
              <span class="t">${crest(x.home)}${esc(x.home.short)}</span>
              <span class="t">${crest(x.away)}${esc(x.away.short)}</span>
            </span>
            <span class="when">${x.kind === "live"
              ? `<b class="live">${x.home.score}–${x.away.score}</b><span class="live">${esc(x.clock)}</span>`
              : `<b>${fmt.time(xd)}</b>${xd.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}`}
              <br>${LEAGUES[x.league].short}</span>
          </button>`;
        }).join("") || `<p class="d-muted">Nothing else scheduled.</p>`}
      </aside>`;

    if (mode === "next") {
      const tick = () => {
        const diff = Math.max(0, d.getTime() - Date.now());
        const v = { d: Math.floor(diff / 864e5), h: Math.floor(diff / 36e5) % 24, m: Math.floor(diff / 6e4) % 60, s: Math.floor(diff / 1e3) % 60 };
        for (const k in v) { const el = inner.querySelector(`[data-cd="${k}"]`); if (el) el.textContent = String(v[k]).padStart(2, "0"); }
        if (diff === 0) { clearInterval(countdownTimer); setTimeout(refreshLive, 60e3); }
      };
      tick();
      countdownTimer = setInterval(tick, 1000);
    }
  }

  function renderAll(soft = false) {
    $("#loading")?.remove();
    renderTeamOptions();
    renderHero();
    renderSeason();
    renderCalendar();
    if (!soft) syncControls();
  }

  function syncControls() {
    $$("#leagueFilter .pill").forEach((b) => b.classList.toggle("is-active", b.dataset.league === state.league));
    $$("#statusFilter .seg-btn").forEach((b) => b.classList.toggle("is-active", b.dataset.status === state.status));
    $("#teamFilter").value = state.team;
  }
  function savePrefs() { store.set(PREFS_KEY, { league: state.league, status: state.status, team: state.team }); }

  /* ---------------- jump to today ---------------- */
  function jumpToToday() {
    const today = dayKey(new Date());
    const days = $$(".day-block");
    if (!days.length) return;
    const target = state.status === "results"
      ? days.find((el) => el.dataset.day <= today)
      : days.find((el) => el.dataset.day >= today);
    (target || days.at(-1)).scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* ======================================================================
     Match drawer
     ====================================================================== */
  const drawer = $("#drawer"), backdrop = $("#drawerBackdrop"), body = $("#drawerBody");
  let lastFocus = null;

  function showDrawer() {
    lastFocus = document.activeElement;
    backdrop.hidden = false;
    requestAnimationFrame(() => { backdrop.classList.add("is-open"); drawer.classList.add("is-open"); });
    drawer.setAttribute("aria-hidden", "false");
    document.body.classList.add("no-scroll");
    drawer.focus();
  }
  function closeDrawer() {
    state.openId = null;
    backdrop.classList.remove("is-open");
    drawer.classList.remove("is-open");
    drawer.setAttribute("aria-hidden", "true");
    document.body.classList.remove("no-scroll");
    setTimeout(() => { backdrop.hidden = true; }, 300);
    if (history.state?.match) history.back();
    lastFocus?.focus?.();
  }

  async function getSummary(m) {
    if (state.summaries.has(m.id)) return state.summaries.get(m.id);
    const s = await fetchJSON(`${API}${m.league}/summary?event=${m.id}`, 1);
    state.summaries.set(m.id, s);
    return s;
  }

  function dHeroHTML(m, s) {
    const r = result(m);
    const d = new Date(m.date);
    const played = m.kind === "ft" || m.kind === "live";
    const att = s?.gameInfo?.attendance || m.attendance;
    const ref = s?.gameInfo?.officials?.[0]?.displayName;
    const t = (side) => `<div class="d-team ${r === side ? "is-winner" : r && r !== "draw" ? "is-loser" : ""}">
        ${crest(m[side], "", 'loading="eager"')}
        <span class="n">${esc(m[side].short)}</span>
        ${r === side ? `<span class="win-badge">WINNER</span>` : ""}
      </div>`;
    const pin = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>`;
    const cal = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>`;
    const ppl = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6"/></svg>`;
    const whistle = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="14" r="6"/><path d="M13 9.5 21 6v4l-6 1.5"/></svg>`;
    return `<div class="d-hero">
      <div class="d-hero-bg">${photo(m.venue.id, 1280) ? `<img src="${esc(photo(m.venue.id, 1280))}" alt="">` : ""}</div>
      <div class="d-league">${leagueChip(m.league)}${statusChip(m)}</div>
      <div class="d-score">
        ${t("home")}
        <div class="d-mid">${played
          ? `<div class="big">${m.home.score ?? 0}<span class="dash">–</span>${m.away.score ?? 0}</div>${r === "draw" ? `<span class="status ft st">DRAW</span>` : ""}`
          : `<div class="big" style="font-size:44px">${m.kind === "ppd" ? "TBC" : fmt.time(d)}</div>`}
        </div>
        ${t("away")}
      </div>
      <div class="d-facts">
        <span>${cal}${fmt.dayLong(d)}</span>
        <span>${pin}${esc(m.venue.name)}${m.venue.city ? `, ${esc(m.venue.city)}` : ""}</span>
        ${att ? `<span>${ppl}${Number(att).toLocaleString()}</span>` : ""}
        ${ref ? `<span>${whistle}${esc(ref)}</span>` : ""}
      </div>
    </div>`;
  }

  const STAT_KEYS = ["totalGoals", "goalAssists", "shotsOnTarget", "totalShots", "saves", "foulsSuffered", "foulsCommitted", "yellowCards", "redCards", "ownGoals", "goalsConceded"];
  function statsOf(p) {
    const st = Object.fromEntries(STAT_KEYS.map((k) => [k, 0]));
    for (const x of p.stats || []) st[x.name] = Number(x.value) || 0;
    return st;
  }

  /* ---- Player of the match: a transparent stat-based rating ---- */
  function playerOfMatch(m, s) {
    if (!s?.rosters?.length || m.kind !== "ft") return null;
    const conceded = { [m.home.id]: m.away.score, [m.away.id]: m.home.score };
    const r = result(m);
    const winId = r === "home" ? m.home.id : r === "away" ? m.away.id : null;
    let best = null;
    for (const side of s.rosters) {
      const tid = side.team?.id;
      for (const p of side.roster || []) {
        if (!p.starter && !p.subbedIn) continue;
        const st = statsOf(p);
        const pos = p.position?.abbreviation || "";
        const gk = pos === "G";
        const def = /^(D|CD|LB|RB|LWB|RWB|SW)/.test(pos);
        const cs = conceded[tid] === 0 && p.starter && !p.subbedOut;
        let score = 6.0
          + st.totalGoals * 1.25
          + st.goalAssists * 0.85
          + st.shotsOnTarget * 0.22
          + Math.max(0, st.totalShots - st.shotsOnTarget) * 0.05
          + st.saves * 0.32
          + st.foulsSuffered * 0.06
          - st.foulsCommitted * 0.05
          - st.yellowCards * 0.4
          - st.redCards * 2
          - st.ownGoals * 1.2
          - (gk ? st.goalsConceded * 0.25 : 0)
          + (cs && gk ? 0.9 : cs && def ? 0.5 : 0)
          + (tid === winId ? 0.4 : r === "draw" ? 0.1 : 0)
          + (p.subbedIn ? -0.3 : 0);
        score = Math.min(10, Math.max(3, score));
        if (!best || score > best.score) best = { p, st, score, tid, cs, gk };
      }
    }
    return best;
  }

  function motmHTML(m, best) {
    if (!best) return "";
    const { p, st, score, tid, cs, gk } = best;
    const t = tid === m.home.id ? m.home : m.away;
    const name = p.athlete?.displayName || "";
    const initials = name.split(" ").map((x) => x[0]).slice(0, 2).join("");
    const head = p.athlete?.headshot?.href || (p.athlete?.id ? `https://a.espncdn.com/i/headshots/soccer/players/full/${p.athlete.id}.png` : "");
    const chips = [];
    if (st.totalGoals) chips.push(`${st.totalGoals} goal${st.totalGoals > 1 ? "s" : ""}`);
    if (st.goalAssists) chips.push(`${st.goalAssists} assist${st.goalAssists > 1 ? "s" : ""}`);
    if (st.shotsOnTarget) chips.push(`${st.shotsOnTarget} on target`);
    if (st.saves) chips.push(`${st.saves} save${st.saves > 1 ? "s" : ""}`);
    if (cs) chips.push("Clean sheet");
    if (st.foulsSuffered) chips.push(`${st.foulsSuffered} fouls won`);
    return `<div class="d-section">
      <h4>Player of the match <span class="note">Stat-based rating</span></h4>
      <div class="motm">
        <span class="rating">${score.toFixed(1)}</span>
        <div class="motm-photo">
          <span class="initials">${esc(initials)}</span>
          ${head ? `<img src="${esc(head)}" alt="" style="position:absolute;inset:0" data-hide-on-error>` : ""}
          ${t.logo ? `<img class="crest-mini" src="${esc(darkLogo(t.logo))}" data-crest data-fallback="${esc(t.logo)}" alt="">` : ""}
        </div>
        <div>
          <div class="lbl">★ Player of the match</div>
          <div class="pname">${esc(name)}</div>
          <div class="pmeta">${esc(t.name)} · ${esc(p.position?.displayName || (gk ? "Goalkeeper" : ""))}${p.jersey ? ` · #${esc(p.jersey)}` : ""}</div>
          ${chips.length ? `<div class="pstats">${chips.map((c) => `<span>${c}</span>`).join("")}</div>` : ""}
        </div>
      </div>
    </div>`;
  }

  function keyEvents(s) {
    return (s?.keyEvents || []).map((k) => {
      const type = k.type?.type || "";
      const txt = k.text || "";
      let kind = null;
      if (k.scoringPlay || /goal/.test(type)) kind = "goal";
      else if (/red-card/.test(type)) kind = "red";
      else if (/yellow-card/.test(type)) kind = /second yellow/i.test(txt) ? "red" : "yellow";
      else if (/substitution/.test(type)) kind = "sub";
      else if (/halftime|end-regular-time|kickoff|start-2nd-half/.test(type)) kind = "phase";
      if (!kind) return null;
      const parts = k.participants || [];
      return {
        kind, type, txt,
        min: k.clock?.displayValue || "",
        team: k.team?.id,
        p1: parts[0]?.athlete?.displayName || "",
        p2: parts[1]?.athlete?.displayName || "",
        pen: /penalty/i.test(type) || /\(penalty\)|penalty kick|converts the penalty/i.test(txt),
        og: /own-goal/.test(type) || /own goal/i.test(txt),
        label: k.type?.text || "",
      };
    }).filter(Boolean);
  }

  function goalsAndCardsHTML(m, evs) {
    const goals = evs.filter((e) => e.kind === "goal");
    const cards = evs.filter((e) => e.kind === "yellow" || e.kind === "red");
    const colHead = (t) => `<div class="col-head">${crest(t)}${esc(t.short)}</div>`;
    const glist = (t, cls) => {
      const items = goals.filter((g) => g.team === t.id);
      return `<ul class="ev-list ${cls}">${items.length ? items.map((g) => `<li>
        <span class="min">${esc(g.min)}</span>${ballSvg}
        <span class="who"><b>${esc(g.p1)}</b>${g.pen ? ` <span class="tag">PEN</span>` : ""}${g.og ? ` <span class="tag">OG</span>` : ""}
        ${g.p2 && !g.og && !g.pen ? `<small>Assist: ${esc(g.p2)}</small>` : ""}</span></li>`).join("") : `<li class="none">No goals</li>`}</ul>`;
    };
    const clist = (t, cls) => {
      const items = cards.filter((c) => c.team === t.id);
      return `<ul class="ev-list ${cls}">${items.length ? items.map((c) => `<li>
        <span class="min">${esc(c.min)}</span><i class="cardico ${c.kind === "red" ? "r" : "y"}"></i>
        <span class="who"><b>${esc(c.p1)}</b>${c.kind === "red" && /second yellow/i.test(c.txt) ? `<small>Second yellow</small>` : ""}</span></li>`).join("") : `<li class="none">None</li>`}</ul>`;
    };
    return `<div class="d-section"><h4>Goals</h4>
        <div class="two-col"><div>${colHead(m.home)}${glist(m.home, "home")}</div><div>${colHead(m.away)}${glist(m.away, "away")}</div></div>
      </div>
      <div class="d-section"><h4>Bookings</h4>
        <div class="two-col"><div>${clist(m.home, "home")}</div><div>${clist(m.away, "away")}</div></div>
      </div>`;
  }

  function timelineHTML(m, evs) {
    if (!evs.length) return "";
    const item = (e) => {
      if (e.kind === "phase") {
        const lbl = /halftime/.test(e.type) ? "Half time" : /end-regular/.test(e.type) ? "Full time" : /start-2nd/.test(e.type) ? "Second half" : "Kick-off";
        return `<li class="tl-item phase"><span class="tl-min">${lbl}</span></li>`;
      }
      const side = e.team === m.home.id ? "home" : "away";
      let txt = "";
      if (e.kind === "goal") txt = `${ballSvg}<span><b>${esc(e.p1)}</b>${e.pen ? " (pen)" : ""}${e.og ? " (OG)" : ""}${e.p2 && !e.og && !e.pen ? `<br><small>Assist ${esc(e.p2)}</small>` : ""}</span>`;
      else if (e.kind === "yellow" || e.kind === "red") txt = `<i class="cardico ${e.kind === "red" ? "r" : "y"}"></i><span>${esc(e.p1)}</span>`;
      else if (e.kind === "sub") txt = `<span><span class="sub-in">↑</span> ${esc(e.p1)}<br><small><span class="sub-out">↓</span> ${esc(e.p2)}</small></span>`;
      return `<li class="tl-item ${side} ${e.kind}"><span class="tl-txt">${txt}</span><span class="tl-min">${esc(e.min)}</span></li>`;
    };
    return `<div class="d-section"><h4>Timeline</h4><ul class="timeline">${evs.map(item).join("")}</ul></div>`;
  }

  function statsHTML(m, s) {
    const teams = s?.boxscore?.teams || [];
    const get = (id) => Object.fromEntries((teams.find((t) => t.team?.id === id)?.statistics || []).map((x) => [x.name, x.displayValue]));
    const h = get(m.home.id), a = get(m.away.id);
    if (!Object.keys(h).length) return "";
    const rows = [
      ["possessionPct", "Possession", "%"], ["totalShots", "Shots"], ["shotsOnTarget", "Shots on target"],
      ["wonCorners", "Corners"], ["accuratePasses", "Accurate passes"], ["saves", "Saves"],
      ["foulsCommitted", "Fouls"], ["offsides", "Offsides"], ["yellowCards", "Yellow cards"], ["redCards", "Red cards"],
    ].filter(([k]) => h[k] !== undefined || a[k] !== undefined);
    return `<div class="d-section"><h4>Match stats</h4><div class="stats">${rows.map(([k, label, unit = ""]) => {
      const hv = parseFloat(h[k]) || 0, av = parseFloat(a[k]) || 0, tot = hv + av || 1;
      const lowerBetter = k === "foulsCommitted" || k === "yellowCards" || k === "redCards" || k === "offsides";
      const hl = lowerBetter ? hv < av : hv > av, al = lowerBetter ? av < hv : av > hv;
      return `<div class="stat-row">
        <div class="labels"><b>${h[k] ?? 0}${unit}</b><span>${label}</span><b>${a[k] ?? 0}${unit}</b></div>
        <div class="bars"><div class="bar h ${hl ? "lead" : ""}"><i style="width:${(hv / tot) * 100}%"></i></div><div class="bar ${al ? "lead" : ""}"><i style="width:${(av / tot) * 100}%"></i></div></div>
      </div>`;
    }).join("")}</div></div>`;
  }

  function lineupsHTML(m, s) {
    const rosters = s?.rosters || [];
    if (!rosters.some((r) => r.roster?.length)) return "";
    const col = (t) => {
      const r = rosters.find((x) => x.team?.id === t.id);
      if (!r?.roster?.length) return `<div>${crest(t)}<p class="d-muted">Not available</p></div>`;
      const icons = (p) => {
        const st = statsOf(p);
        let out = "";
        for (let i = 0; i < st.totalGoals; i++) out += ballSvg;
        if (st.yellowCards) out += `<i class="cardico y"></i>`;
        if (st.redCards) out += `<i class="cardico r"></i>`;
        if (p.subbedOut) out += `<span class="sub-out">↓</span>`;
        if (p.subbedIn) out += `<span class="sub-in">↑</span>`;
        return out;
      };
      const li = (p) => `<li><span class="no">${esc(p.jersey || "")}</span><span>${esc(p.athlete?.displayName || "")}</span><span class="icons">${icons(p)}</span><span class="pos">${esc(p.position?.abbreviation || "")}</span></li>`;
      const starters = r.roster.filter((p) => p.starter);
      const subs = r.roster.filter((p) => !p.starter && p.subbedIn);
      return `<div>
        <div class="col-head">${crest(t)}${esc(t.short)}<span class="formation">${esc(r.formation || "")}</span></div>
        <ul class="lu-list">${starters.map(li).join("")}</ul>
        ${subs.length ? `<p class="lu-sub-title">Used subs</p><ul class="lu-list">${subs.map(li).join("")}</ul>` : ""}
      </div>`;
    };
    return `<div class="d-section lineups"><h4>Line-ups</h4><div class="two-col">${col(m.home)}${col(m.away)}</div></div>`;
  }

  function recapHTML(s) {
    const a = s?.article;
    if (!a?.headline) return "";
    const img = a.images?.[0]?.url;
    const link = a.links?.web?.href;
    return `<div class="d-section"><h4>Match report</h4><div class="recap">
      ${img ? `<img src="${esc(img)}" alt="" data-hide-on-error>` : ""}
      <div><b>${esc(a.headline)}</b><p>${esc(a.description || "")}</p>${link ? `<a href="${esc(link.replace(/^http:/, "https:"))}" target="_blank" rel="noopener">Read full report on ESPN →</a>` : ""}</div>
    </div></div>`;
  }

  function previewHTML(m, s) {
    const fr = (t) => `<div class="form-row"><span class="t">${crest(t)}${esc(t.name)}</span>${formDots(t.form) || `<span class="d-muted">—</span>`}</div>`;
    let html = `<div class="d-section"><h4>Form guide <span class="note">Last five, all competitions</span></h4>${fr(m.home)}${fr(m.away)}</div>`;
    const l5 = s?.lastFiveGames || [];
    if (l5.length) {
      const col = (t) => {
        const g = l5.find((x) => x.team?.id === t.id);
        if (!g?.events?.length) return `<div><p class="d-muted">No recent matches</p></div>`;
        return `<div><div class="col-head">${crest(t)}${esc(t.short)}</div><ul class="last5">${g.events.slice(0, 5).map((e) =>
          `<li><span class="res ${esc(e.gameResult)}">${esc(e.gameResult)}</span><span>${e.atVs === "@" ? "at " : "vs "}${esc(e.opponent?.displayName || "")}</span><span class="sc">${esc(e.score || "")}</span></li>`).join("")}</ul></div>`;
      };
      html += `<div class="d-section"><h4>Recent results</h4><div class="two-col">${col(m.home)}${col(m.away)}</div></div>`;
    }
    const d = new Date(m.date);
    html += `<div class="d-section"><h4>Kick-off</h4><p class="d-muted">${fmt.dayLong(d)} at ${fmt.time(d)} (your time)${m.broadcasts.length ? ` · ${esc(m.broadcasts.join(", "))}` : ""}</p></div>`;
    return html;
  }

  async function openMatch(id, silent = false) {
    const m = state.byId.get(id);
    if (!m) return;
    state.openId = id;
    const played = m.kind === "ft" || m.kind === "live";
    if (!silent) {
      body.innerHTML = dHeroHTML(m) + `<div class="d-loading"><div class="ball"></div></div>`;
      drawer.scrollTop = 0;
      showDrawer();
      if (!history.state?.match) history.pushState({ match: id }, "", `#match-${id}`);
    }
    let s = null;
    try { s = await getSummary(m); } catch { /* fall back to scoreboard data */ }
    if (state.openId !== id) return;
    let html = dHeroHTML(m, s);
    if (played) {
      const evs = keyEvents(s);
      const fallback = m.details.map((d) => ({ kind: d.k, min: d.min, team: d.team, p1: d.p, p2: "", pen: d.pen, og: d.og, txt: "" }));
      const useEvs = evs.length ? evs : fallback;
      html += motmHTML(m, playerOfMatch(m, s));
      html += goalsAndCardsHTML(m, useEvs);
      html += statsHTML(m, s);
      html += timelineHTML(m, evs);
      html += lineupsHTML(m, s);
      html += recapHTML(s);
      if (!s) html += `<div class="d-section"><p class="d-muted">Full match details couldn't be loaded right now.</p></div>`;
    } else {
      html += previewHTML(m, s);
    }
    const top = drawer.scrollTop;
    body.innerHTML = html;
    if (silent) drawer.scrollTop = top;
  }

  /* ---------------- events ---------------- */
  // Image load / error handling (delegated, capture phase)
  document.addEventListener("load", (e) => {
    const t = e.target;
    if (t.tagName === "IMG" && t.hasAttribute("data-photo")) t.classList.add("is-loaded");
  }, true);
  document.addEventListener("error", (e) => {
    const t = e.target;
    if (t.tagName !== "IMG") return;
    if (t.hasAttribute("data-crest") && t.dataset.fallback && t.src !== t.dataset.fallback) { t.src = t.dataset.fallback; return; }
    if (t.hasAttribute("data-photo") || t.hasAttribute("data-hide-on-error") || t.hasAttribute("data-crest")) t.style.display = "none";
  }, true);

  $("#leagueFilter").addEventListener("click", (e) => {
    const b = e.target.closest("[data-league]");
    if (!b) return;
    state.league = b.dataset.league;
    renderTeamOptions();
    savePrefs();
    renderAll();
  });
  $("#statusFilter").addEventListener("click", (e) => {
    const b = e.target.closest("[data-status]");
    if (!b) return;
    state.status = b.dataset.status;
    savePrefs();
    syncControls();
    renderCalendar();
    if (state.status !== "all") $("#toolbar").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("#teamFilter").addEventListener("change", (e) => {
    state.team = e.target.value;
    savePrefs();
    renderAll();
  });
  $("#todayBtn").addEventListener("click", jumpToToday);
  $("#monthNav").addEventListener("click", (e) => {
    const b = e.target.closest("[data-month]");
    if (b) document.getElementById(`m-${b.dataset.month}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  document.addEventListener("click", (e) => {
    const open = e.target.closest("[data-open]");
    if (open) return openMatch(open.dataset.open);
    if (e.target.closest("[data-jump='today']")) return jumpToToday();
    const card = e.target.closest(".card[data-id]");
    if (card && !e.target.closest("a")) openMatch(card.dataset.id);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.openId) return closeDrawer();
    if ((e.key === "Enter" || e.key === " ") && e.target.matches?.(".card[data-id]")) {
      e.preventDefault();
      openMatch(e.target.dataset.id);
    }
  });
  $("#drawerClose").addEventListener("click", closeDrawer);
  backdrop.addEventListener("click", closeDrawer);
  window.addEventListener("popstate", () => {
    if (state.openId && !history.state?.match) {
      state.openId = null;
      backdrop.classList.remove("is-open");
      drawer.classList.remove("is-open");
      drawer.setAttribute("aria-hidden", "true");
      document.body.classList.remove("no-scroll");
      setTimeout(() => { backdrop.hidden = true; }, 300);
    }
  });

  // Highlight current month in nav while scrolling
  let spyRaf = 0;
  window.addEventListener("scroll", () => {
    cancelAnimationFrame(spyRaf);
    spyRaf = requestAnimationFrame(() => {
      const y = window.scrollY + 200;
      let cur = null;
      for (const el of $$(".month-block")) { if (el.offsetTop <= y) cur = el.dataset.month; else break; }
      if (!cur) return;
      $$(".month-btn").forEach((b) => b.classList.toggle("is-current", b.dataset.month === cur));
    });
  }, { passive: true });

  /* ---------------- boot ---------------- */
  const prefs = store.get(PREFS_KEY);
  if (prefs) Object.assign(state, { league: prefs.league || "all", status: prefs.status || "all", team: prefs.team || "" });
  syncControls();

  loadAll().then(() => {
    const m = location.hash.match(/^#match-(\d+)/);
    if (m && state.byId.has(m[1])) {
      history.replaceState(null, "", location.pathname);
      openMatch(m[1]);
    }
  });
  setInterval(refreshLive, 60e3);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshLive(); });
})();
