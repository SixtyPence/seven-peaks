// Draws the page from the data and handles what people click.
// The pattern: `state` holds the data, and render() draws the page from `state`.
// When anything changes we update `state` and call render() again, so what's on
// screen can't drift away from the data.

(function () {
  // config.js holds the connection details and challenges.js the content. The
  // content comes second, so it wins over any old peaks or places in config.js.
  const config = { ...window.PEAKS_CONFIG, ...window.PEAKS_CONTENT };
  const store = window.PeaksStore.create(config);
  const $ = (id) => document.getElementById(id);

  const state = {
    challenge: null,         // the challenge on screen, from challenges.js
    events: new Map(),       // challenge id -> its times from the database
    event: null,             // the times of the challenge on screen
    participants: new Map(), // id -> person. Shared by all challenges.
    allEntries: new Map(),   // id -> climb, in every challenge. A Map means a repeated update can't double-count.
    entries: new Map(),      // only the climbs of the challenge on screen
    boardExpanded: false,
    feedLimit: 12,
    lastLoaded: 0,
    previousTotal: null,
    appShown: false,
    isMember: false,
    endingSession: false,
  };

  // The peaks of the challenge on screen, and where each summit sits on the way
  // to the goal. Set by showChallenge().
  let peaks = [];
  let GOAL = 0;


  // ---------- Small helpers ----------
  const number = new Intl.NumberFormat("en-GB");
  const fmt = (n) => number.format(Math.round(n));

  // Two kinds of time appear on this page:
  // - Climb days, stored as plain dates (YYYY-MM-DD). Reading and formatting them
  //   as UTC means a time zone can never push one onto the wrong day.
  // - Moments, like the start and end. These are shown on the challenge's own
  //   clock (time_zone in settings.sql), so a phone set to another time zone
  //   still shows the organizer's times and agrees with the database about "today".
  const asDate = (iso) => new Date(iso + "T00:00:00Z");
  const formatDate = (iso, options) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...options }).format(asDate(iso));
  const shortDay = (iso) => formatDate(iso, { weekday: "short", day: "numeric", month: "short" });
  const dayOnly = (iso) => formatDate(iso, { weekday: "short" });

  const eventZone = () => (state.event && state.event.time_zone) || undefined;
  const formatMoment = (moment, options) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: eventZone(), ...options }).format(new Date(moment));
  const when = (moment) => formatMoment(moment, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const clock = (moment) => formatMoment(moment, { hour: "2-digit", minute: "2-digit" });

  // The calendar day of a moment on the challenge's clock, as YYYY-MM-DD.
  function dayOf(moment) {
    const parts = {};
    new Intl.DateTimeFormat("en-GB", { timeZone: eventZone(), year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date(moment)).forEach((part) => { parts[part.type] = part.value; });
    return `${parts.year}-${parts.month}-${parts.day}`;
  }
  const eventToday = () => dayOf(Date.now());

  // A challenge's key moments, in milliseconds since 1970 (easy to compare).
  function eventTimes(event = state.event) {
    const start = Date.parse(event.starts_at);
    const end = Date.parse(event.ends_at);
    return { start, end, close: end + event.late_minutes * 60000 };
  }

  // "before", "live", "late" (ended, but logging stays open), "over", or "unset".
  function phase(event = state.event) {
    if (!event) return "unset";
    const { start, end, close } = eventTimes(event);
    const now = Date.now();
    if (now < start) return "before";
    if (now < end) return "live";
    if (now < close) return "late";
    return "over";
  }

  function eventDays() {
    if (!state.event) return [];
    const { start, end } = eventTimes();
    const first = dayOf(start);
    const last = dayOf(end - 1000); // an end at exactly midnight belongs to the day before
    const days = [];
    for (let t = asDate(first).getTime(); t <= asDate(last).getTime(); t += 86400000) {
      days.push(new Date(t).toISOString().slice(0, 10));
    }
    return days;
  }

  // "2 days 4 h", "3 h 20 min", "12 min"
  function timeLeft(ms) {
    const minutes = Math.max(1, Math.round(ms / 60000));
    const days = Math.floor(minutes / 1440), hours = Math.floor((minutes % 1440) / 60), mins = minutes % 60;
    if (days) return `${days} ${days === 1 ? "day" : "days"}${hours ? ` ${hours} h` : ""}`;
    if (hours) return `${hours} h${mins ? ` ${mins} min` : ""}`;
    return `${mins} min`;
  }

  // Browser storage can be blocked (private windows, for example), so a failure
  // here must never break the page. It only costs a small convenience.
  const saved = {
    get(key) { try { return JSON.parse(localStorage.getItem("peaks." + key)); } catch { return null; } },
    set(key, value) { try { localStorage.setItem("peaks." + key, JSON.stringify(value)); } catch { /* fine */ } },
  };

  // Build elements with textContent, never innerHTML. Names and notes come from
  // other people, and this way any HTML in them is shown as text and never runs.
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  let toastTimer;
  function toast(message, ms = 4000) {
    const node = $("toast");
    node.textContent = message;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, ms);
  }


  // ---------- The ridge drawing ----------
  // The ridge is drawn to scale in both directions. Each summit sits exactly where
  // the group reaches it on the bar below, and its height is true relative to the
  // others. Only the small crags on the way up are made up. The drawing ends at
  // the final summit, which is the goal, so the ridge and the bar end together.
  const RIDGE_W = 1000;
  const RIDGE_H = 240;

  // A repeatable random generator: same seed, same mountains on every device.
  function seededRandom(seed) {
    return () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  }

  // Midpoint displacement, a classic way to draw mountains. Take a straight line,
  // nudge its middle up or down, then repeat on both halves with smaller nudges.
  // Big features and small crags appear at once, with very little code.
  function roughen(start, end, random, highestY, rounds = 4) {
    let points = [start, end];
    for (let round = 0; round < rounds; round++) {
      const next = [points[0]];
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i];
        const span = b.x - a.x;
        next.push({
          x: a.x + span * (0.4 + random() * 0.2),
          y: Math.min(RIDGE_H, Math.max(highestY, (a.y + b.y) / 2 + (random() - 0.5) * span * 0.3)),
        }, b);
      }
      points = next;
    }
    return points;
  }

  const outlineToPath = (points, close = true) =>
    "M" + points.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" L") + (close ? " Z" : "");
  const toGround = (line) => outlineToPath([{ x: 0, y: RIDGE_H }, ...line, { x: RIDGE_W, y: RIDGE_H }]);

  function buildRidge() {
    const H = RIDGE_H;
    // Each challenge gets its own mountains. (Challenge 1 keeps its original ones.)
    const random = seededRandom(20261109 + (state.challenge.id - 1) * 7919);
    const heights = peaks.map((p) => p.height);
    const tallest = Math.max(...heights);
    const lowest = Math.min(...heights) / tallest;
    const toY = (share) => H - share * (H - 4); // share of the tallest peak's height -> drawing position

    // The main ridge line, as points running left to right.
    const line = [{ x: 0, y: H * 0.9 }];
    const extend = (end, highestY) => line.push(...roughen(line[line.length - 1], end, random, highestY).slice(1));
    const summits = [];
    let previous = 0;

    peaks.forEach((peak, i) => {
      const x0 = (previous / GOAL) * RIDGE_W;
      const x1 = (peak.cumulative / GOAL) * RIDGE_W;
      const y = toY(peak.height / tallest);
      if (i > 0) {
        // A col is the low pass between two peaks, well below the lower of them.
        const lowerPeak = Math.min(peak.height, peaks[i - 1].height) / tallest;
        const colY = toY(lowerPeak * (0.42 + random() * 0.16));
        extend({ x: x0 + (x1 - x0) * (0.3 + random() * 0.12), y: colY }, summits[i - 1].y + 3);
        summits[i - 1].colIndex = line.length - 1;
      }
      const from = line[line.length - 1];
      extend({
        x: from.x + (x1 - from.x) * (0.55 + random() * 0.2),
        y: from.y + (y - from.y) * (0.58 + random() * 0.14),
      }, y + 3);
      extend({ x: x1, y }, y + 3);
      summits.push({ x: x1, y, index: line.length - 1 });
      previous = peak.cumulative;
    });


    // Snow caps: the top of each peak, closed off by a jagged lower edge.
    const caps = summits.map((summit) => {
      const snowLine = summit.y + (H - summit.y) * 0.13;
      let left = summit.index, right = summit.index;
      while (left > 0 && line[left - 1].y < snowLine) left--;
      while (right < line.length - 1 && line[right + 1].y < snowLine) right++;
      const edge = [];
      for (let i = 1; i < 6; i++) {
        edge.push({
          x: line[right].x + ((line[left].x - line[right].x) * i) / 6,
          y: snowLine + (i % 2 ? 1 : -1) * (H * 0.02) * (0.5 + random()),
        });
      }
      return outlineToPath([...line.slice(left, right + 1), ...edge]);
    }).join(" ");

    // Shadow: the side of each peak facing away from the light, down to its col.
    // The final summit is the edge of the drawing, so it has no far side to shade.
    const shade = summits.filter((summit) => summit.colIndex !== undefined).map((summit) => {
      const col = line[summit.colIndex];
      const footX = summit.x + (col.x - summit.x) * 0.22;
      const fall = [];
      for (let i = 1; i < 6; i++) {
        fall.push({
          x: footX + ((summit.x - footX) * i) / 6 + (random() - 0.5) * 9,
          y: H + ((summit.y - H) * i) / 6,
        });
      }
      return outlineToPath([
        ...line.slice(summit.index, summit.colIndex + 1),
        { x: summit.x + (col.x - summit.x) * 0.62, y: H }, { x: footX, y: H }, ...fall,
      ]);
    }).join(" ");

    // A paler, lower range in the distance, for depth.
    const farRandom = seededRandom(1953);
    const farTop = toY(lowest * 0.82); // always below the lowest real summit
    let far = [{ x: 0, y: farTop + H * 0.1 }];
    for (let i = 1; i <= 9; i++) {
      const end = { x: (RIDGE_W * i) / 9, y: farTop + H * (i % 2 ? farRandom() * 0.05 : 0.09 + farRandom() * 0.06) };
      far = far.concat(roughen(far[far.length - 1], end, farRandom, farTop, 3).slice(1));
    }

    return { line, summits, outline: toGround(line), far: toGround(far), caps, shade };
  }

  // The height of the ridge at any horizontal position, so the marker stays on it.
  function ridgeYAt(line, x) {
    let low = 0, high = line.length - 1;
    while (high - low > 1) { // binary search: halve the range until two points remain
      const mid = (low + high) >> 1;
      if (line[mid].x <= x) low = mid; else high = mid;
    }
    const a = line[low], b = line[high];
    return a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x || 1);
  }

  let ridge;
  const peakTitle = (peak) =>
    `${peak.name} (${peak.region}) is ${fmt(peak.height)} m high. The group reaches it at ${fmt(peak.cumulative)} m.`;

  function buildClimb() {
    ["summit-ticks", "summits", "peak-labels", "route-list"].forEach((id) => $(id).replaceChildren());
    ridge = buildRidge();
    $("ridge-far-path").setAttribute("d", ridge.far);
    $("gate-far-path").setAttribute("d", ridge.far);
    $("gate-ridge-path").setAttribute("d", ridge.outline);
    ["base", "fill"].forEach((layer) => {
      $(`ridge-${layer}-path`).setAttribute("d", ridge.outline);
      $(`ridge-${layer}-caps`).setAttribute("d", ridge.caps);
      $(`ridge-${layer}-shade`).setAttribute("d", ridge.shade);
    });
    const crest = outlineToPath(ridge.line, false); // the ridge's top edge, left to right
    $("route-halo").setAttribute("d", crest);
    $("route-line").setAttribute("d", crest);
    $("bar").setAttribute("aria-valuemax", GOAL);

    // Summit labels and flags are HTML on top of the drawing, because the drawing
    // stretches with the screen and would stretch text along with it.
    peaks.forEach((peak, i) => {
      const left = `${(ridge.summits[i].x / RIDGE_W) * 100}%`;
      const top = `${(ridge.summits[i].y / RIDGE_H) * 100}%`;

      const tick = el("i");
      tick.style.left = left;
      tick.style.top = top;
      $("summit-ticks").append(tick);

      const summit = el("div", i === peaks.length - 1 ? "summit is-last" : "summit");
      summit.dataset.summit = i;
      summit.style.left = left;
      summit.style.top = top;
      summit.title = peakTitle(peak);
      const name = el("span", peak.short ? "summit-name has-short" : "summit-name");
      name.append(el("span", "name-full", peak.name));
      if (peak.short) name.append(el("span", "name-short", peak.short));
      summit.append(name, el("span", "summit-flag"));
      $("summits").append(summit);
    });
    setClimbPosition(0);

    // Using each height as a column width keeps the labels on the same scale.
    $("peak-labels").style.gridTemplateColumns = peaks.map((p) => `${p.height}fr`).join(" ");
    peaks.forEach((peak, i) => {
      const label = el("li");
      label.dataset.peak = i;
      label.title = peakTitle(peak);
      label.append(
        el("span", "peak-region", peak.region),
        el("span", "peak-meta", `${fmt(peak.cumulative)} m`),
        el("span", "peak-reached") // filled in with the time the group got there
      );
      $("peak-labels").append(label);

      const row = el("li");
      row.dataset.peak = i;
      const place = el("span");
      place.append(el("span", "route-name", peak.name), el("span", "route-region", peak.region));
      const right = el("span", "route-right");
      right.append(el("span", "route-meta", `${fmt(peak.cumulative)} m`), el("span", "route-reached"));
      row.append(place, right);
      $("route-list").append(row);
    });
  }


  // ---------- Rendering ----------
  const totalMeters = () => {
    let total = 0;
    state.entries.forEach((e) => { total += e.meters; });
    return total;
  };

  // Puts everything that shows the group's position at one point on the route.
  function setClimbPosition(share) {
    const x = share * RIDGE_W;
    const y = ridgeYAt(ridge.line, x);
    const yPercent = (y / RIDGE_H) * 100;

    $("bar-fill").style.width = `${share * 100}%`;
    // The fill fades out just before this point. See the mask in styles.css.
    $("ridge-fill").style.setProperty("--edge", share >= 1 ? "110%" : `${share * 100}%`);
    // The finished look starts as the marker reaches the last summit. See .is-complete in styles.css.
    $("hero").classList.toggle("is-complete", share >= 1);

    const climber = $("climber");
    climber.hidden = share >= 1; // at the finish, the flag on the last summit says it all
    climber.style.left = `${share * 100}%`;
    climber.style.top = `${yPercent}%`;
    climber.classList.toggle("label-above", yPercent > 58); // near the valley floor, there's no room below
    climber.classList.toggle("label-start", share < 0.06);  // keep it on screen at the very start
    climber.classList.toggle("label-end", share > 0.94);    // and at the very end

    const nextIndex = peaks.findIndex((p) => share < p.cumulative / GOAL);
    document.querySelectorAll("[data-summit]").forEach((node) => {
      const i = Number(node.dataset.summit);
      node.classList.toggle("reached", nextIndex === -1 || i < nextIndex);
      node.classList.toggle("current", i === nextIndex);
    });
  }

  // Walks the marker along the ridge. requestAnimationFrame runs a function just
  // before the browser's next redraw, so each step lines up with what's on screen.
  // CSS could only slide the marker in a straight line, cutting through the peaks.
  const climbMotion = { shown: 0, frame: null, first: true };

  function moveClimbTo(share) {
    cancelAnimationFrame(climbMotion.frame);
    const from = climbMotion.shown;
    const duration = climbMotion.first ? 1800 : 800;
    climbMotion.first = false;
    if (from === share) return;

    const skip = document.hidden || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (skip) {
      climbMotion.shown = share;
      setClimbPosition(share);
      return;
    }
    const startTime = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - startTime) / duration);
      climbMotion.shown = from + (share - from) * (1 - (1 - t) ** 3); // starts fast, eases in
      setClimbPosition(climbMotion.shown);
      if (t < 1) climbMotion.frame = requestAnimationFrame(step);
    };
    climbMotion.frame = requestAnimationFrame(step);
  }

  // The summit register: when the group's running total passed each summit.
  // Climbs are added up in the order they were logged, and each summit gets the
  // time of the climb that took the total past it.
  function summitTimes() {
    const times = [];
    let running = 0, next = 0;
    [...state.entries.values()].sort((a, b) => a.id - b.id).forEach((entry) => {
      running += entry.meters;
      while (next < peaks.length && running >= peaks[next].cumulative) times[next++] = entry.created_at;
    });
    return times;
  }

  function renderHero() {
    const total = totalMeters();
    const share = Math.min(total / GOAL, 1);
    const percent = share * 100;

    $("total-climbed").textContent = fmt(total);
    // Math.floor, so the page only ever says 100% once the goal is truly reached.
    $("goal-caption").textContent = total >= GOAL
      ? `Goal of ${fmt(GOAL)} m reached${total > GOAL ? `, plus ${fmt(total - GOAL)} m` : ""}`
      : `of ${fmt(GOAL)} m, ${percent >= 10 ? Math.floor(percent) : percent.toFixed(1)}% of the way`;
    moveClimbTo(share);
    $("bar").setAttribute("aria-valuenow", Math.min(total, GOAL));
    $("bar").setAttribute("aria-valuetext", `${fmt(total)} of ${fmt(GOAL)} meters`);

    const nextIndex = peaks.findIndex((p) => total < p.cumulative);
    document.querySelectorAll("[data-peak]").forEach((node) => {
      const i = Number(node.dataset.peak);
      node.classList.toggle("reached", total >= peaks[i].cumulative);
      node.classList.toggle("current", i === nextIndex);
    });

    const reachedAt = summitTimes();
    document.querySelectorAll(".peak-reached, .route-reached").forEach((node) => {
      const time = reachedAt[Number(node.closest("[data-peak]").dataset.peak)];
      node.textContent = time ? formatMoment(time, { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "";
    });

    if (nextIndex === -1) {
      const final = reachedAt[peaks.length - 1];
      $("next-label").textContent = "Final summit reached";
      $("next-summit").textContent = final ? when(final) : peaks[peaks.length - 1].name;
      $("next-detail").textContent = "";
    } else {
      $("next-label").textContent = "Next summit";
      $("next-summit").textContent = peaks[nextIndex].name;
      $("next-detail").textContent = `${fmt(peaks[nextIndex].cumulative - total)} m to go`;
    }

    renderStatus(total);

    // Celebrate summits that were reached while the page was open.
    if (state.previousTotal !== null) {
      const crossed = peaks.filter((p) => state.previousTotal < p.cumulative && total >= p.cumulative).pop();
      if (crossed && total >= GOAL) toast(`Challenge complete! All ${peaks.length} summits climbed.`, 8000);
      else if (crossed) toast(`${crossed.name} summited! Peak ${peaks.indexOf(crossed) + 1} of ${peaks.length}.`, 6000);
    }
    state.previousTotal = total;
  }

  function renderStatus(total) {
    const now = phase();
    $("log-button").hidden = now === "over";
    $("board-title").textContent = now === "over" ? "Final leaderboard" : "Leaderboard";
    if (now === "unset") {
      $("event-status").textContent = "The organizer still needs to set the times for this challenge.";
      $("pace-block").hidden = $("bar-pace").hidden = true;
      return;
    }
    const { start, end, close } = eventTimes();
    const days = eventDays();
    const dayIndex = days.indexOf(eventToday());

    $("event-status").textContent = {
      before: `Starts ${when(start)}, in ${timeLeft(start - Date.now())}. Ends ${when(end)}.`,
      live: `Day ${dayIndex + 1} of ${days.length}. Ends ${when(end)}, in ${timeLeft(end - Date.now())}.`,
      late: `Finished ${when(end)}. Climbs from before the end can be logged until ${clock(close)}.`,
      over: `Finished. Ran from ${when(start)} to ${when(end)}.`,
    }[now];

    // Pace: the group's target by the end of today, with an equal share per day.
    const showPace = now === "live" && dayIndex !== -1 && total < GOAL;
    $("pace-block").hidden = !showPace;
    $("bar-pace").hidden = !showPace;
    if (showPace) {
      const lastDay = dayIndex === days.length - 1;
      const target = (GOAL * (dayIndex + 1)) / days.length;
      $("bar-pace").style.left = `${(target / GOAL) * 100}%`;
      const gap = total - target;
      $("pace-main").textContent = gap >= 0 ? `${fmt(gap)} m ahead` : `${fmt(-gap)} m behind`;
      $("pace-detail").textContent = `${lastDay ? `Target by ${clock(end)}` : "Tonight's target"}: ${fmt(target)} m (white mark)`;
    }
  }

  function renderBoard() {
    const totals = new Map();
    state.participants.forEach((p) => totals.set(p.id, { person: p, meters: 0 }));
    state.entries.forEach((e) => {
      const row = totals.get(e.participant_id);
      if (row) row.meters += e.meters;
    });
    const rows = [...totals.values()].sort(
      (a, b) => b.meters - a.meters || a.person.name.localeCompare(b.person.name)
    );
    const top = rows.length ? Math.max(rows[0].meters, 1) : 1;
    const me = saved.get("participant");

    const fairShare = GOAL / config.expectedParticipants;
    $("board-note").textContent =
      `With ${config.expectedParticipants} people, a fair share is about ${fmt(fairShare)} m each.`;

    const list = $("board");
    list.replaceChildren();
    const limit = 10;
    const visible = state.boardExpanded ? rows : rows.slice(0, limit);
    let rank = 0, lastMeters = null;
    rows.forEach((row, index) => {
      // People with the same meters share a rank.
      if (row.meters !== lastMeters) { rank = index + 1; lastMeters = row.meters; }
      row.rank = rank;
    });
    visible.forEach((row) => {
      const li = el("li");
      if (row.person.id === me) li.classList.add("is-you");
      const name = el("span", "board-name", row.person.name);
      if (row.person.id === me) name.append(el("span", "board-you", "  (you)"));
      const track = el("div", "board-track");
      const fill = el("span");
      fill.style.width = `${(row.meters / top) * 100}%`;
      track.append(fill);
      li.append(el("span", "board-rank", row.rank), name, el("span", "board-meters", `${fmt(row.meters)} m`), track);
      list.append(li);
    });

    const more = $("board-more");
    more.hidden = rows.length <= limit;
    more.textContent = state.boardExpanded ? "Show the top 10" : `Show all ${rows.length} people`;
  }

  function renderFeed() {
    const tokens = saved.get("tokens") || {};
    const rows = [...state.entries.values()].sort((a, b) => b.id - a.id);
    const list = $("feed");
    list.replaceChildren();
    $("feed-empty").hidden = rows.length > 0;

    rows.slice(0, state.feedLimit).forEach((entry) => {
      const li = el("li");
      const person = state.participants.get(entry.participant_id);
      li.append(
        el("span", "feed-name", person ? person.name : "Someone"),
        el("span", "feed-meters", `${fmt(entry.meters)} m`)
      );

      const bits = [shortDay(entry.climbed_on)];
      if (entry.place_name) bits.push(entry.place_name);
      if (entry.note) bits.push(entry.note);
      li.append(el("span", "feed-detail", bits.join(". ")));

      const hasLocation = entry.has_track || entry.lat != null;
      const canDelete = tokens[entry.id];
      if (hasLocation || canDelete) {
        const actions = el("div", "feed-actions");
        if (hasLocation) {
          const show = el("button", "link-button", "Show on map");
          show.type = "button";
          show.addEventListener("click", () => focusOnMap(entry.id));
          actions.append(show);
        }
        if (canDelete) actions.append(deleteButton(entry.id, canDelete));
        li.append(actions);
      }
      list.append(li);
    });
    $("feed-more").hidden = rows.length <= state.feedLimit;
  }

  // Deleting takes two presses, so a stray tap can't remove a climb.
  function deleteButton(id, token) {
    const button = el("button", "link-button", "Delete");
    button.type = "button";
    let armed = false, timer;
    button.addEventListener("click", async () => {
      if (!armed) {
        armed = true;
        button.textContent = "Press again to delete";
        button.classList.add("is-danger");
        timer = setTimeout(() => {
          armed = false;
          button.textContent = "Delete";
          button.classList.remove("is-danger");
        }, 4000);
        return;
      }
      clearTimeout(timer);
      button.disabled = true;
      try {
        await store.deleteEntry(id, token);
        removeEntry(id);
        const tokens = saved.get("tokens") || {};
        delete tokens[id];
        saved.set("tokens", tokens);
        render();
        toast("Climb deleted");
      } catch (error) {
        button.disabled = false;
        if (!handleSessionEnded(error)) toast(error.message);
      }
    });
    return button;
  }

  function render() {
    renderHero();
    renderBoard();
    renderFeed();
    renderMapData();
  }


  // ---------- The trip map ----------
  // Leaflet draws the map; OpenStreetMap supplies the background images ("tiles").
  // The map and its tracks only load once the map section is near the screen.
  const tripMap = { map: null, layers: new Map(), pins: new Map(), tracks: new Map(), fitted: false, ready: false };

  function tileLayer() {
    return L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      referrerPolicy: "strict-origin-when-cross-origin", // OpenStreetMap asks sites to send this
    });
  }
  function pinIcon() {
    return L.divIcon({ className: "map-pin", iconSize: [16, 16], iconAnchor: [8, 8] });
  }

  async function initTripMap() {
    if (tripMap.map) return;
    const start = config.mapStart;
    tripMap.map = L.map("map", { scrollWheelZoom: false }).setView([start.lat, start.lng], start.zoom);
    const tiles = tileLayer();
    tiles.on("tileerror", () => {
      $("map-note").textContent = "The background map couldn't load here, but trips are still drawn.";
    });
    tiles.addTo(tripMap.map);
    try {
      const rows = await store.loadTracks();
      rows.forEach((row) => tripMap.tracks.set(row.entry_id, row.points));
    } catch (error) {
      if (handleSessionEnded(error)) return;
      $("map-note").textContent = `Tracks couldn't load: ${error.message}`;
    }
    tripMap.ready = true;
    renderMapData();
  }

  function popupForTrack(entry) {
    const box = el("div");
    const person = state.participants.get(entry.participant_id);
    box.append(
      el("span", "popup-title", entry.place_name || (person ? person.name : "Trip")),
      el("span", null, `${person ? person.name + ", " : ""}${fmt(entry.meters)} m on ${shortDay(entry.climbed_on)}`)
    );
    return box;
  }

  // Everyone who logged a climb at this exact spot, with the top climbers.
  function popupForPlace(entries) {
    const box = el("div");
    const named = entries.find((e) => e.place_name);
    const total = entries.reduce((sum, e) => sum + e.meters, 0);
    box.append(
      el("span", "popup-title", named ? named.place_name : "Trip"),
      el("span", "popup-line", `${entries.length} ${entries.length === 1 ? "climb" : "climbs"}, ${fmt(total)} m`)
    );
    const byPerson = new Map();
    entries.forEach((e) => byPerson.set(e.participant_id, (byPerson.get(e.participant_id) || 0) + e.meters));
    [...byPerson.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).forEach(([id, meters]) => {
      const person = state.participants.get(id);
      box.append(el("span", "popup-line", `${person ? person.name : "Someone"}: ${fmt(meters)} m`));
    });
    return box;
  }

  const placeKey = (entry) => `${entry.lat},${entry.lng}`;

  function placeIcon(count) {
    // Numbers only, so nothing a person typed can end up in this HTML.
    return count > 1
      ? L.divIcon({ className: "map-pin has-count", html: String(count), iconSize: [26, 26], iconAnchor: [13, 13] })
      : pinIcon();
  }

  function renderMapData() {
    if (!tripMap.ready) return;
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
    const seenTracks = new Set();
    const places = new Map(); // location -> the climbs logged there

    state.entries.forEach((entry) => {
      const points = tripMap.tracks.get(entry.id);
      if (points) {
        seenTracks.add(entry.id);
        if (!tripMap.layers.has(entry.id)) {
          const line = L.polyline(points, { color: accent, weight: 4, opacity: 0.85 });
          line.bindPopup(popupForTrack(entry)).addTo(tripMap.map);
          tripMap.layers.set(entry.id, line);
        }
      } else if (entry.lat != null) {
        const key = placeKey(entry);
        if (!places.has(key)) places.set(key, []);
        places.get(key).push(entry);
      }
    });

    // Popular stairs get many climbs, so each location gets one pin with a count.
    // Separate pins would stack up, and only the top one could be clicked.
    places.forEach((entries, key) => {
      let marker = tripMap.pins.get(key);
      if (!marker) {
        marker = L.marker([entries[0].lat, entries[0].lng]).bindPopup("").addTo(tripMap.map);
        tripMap.pins.set(key, marker);
      }
      marker.setIcon(placeIcon(entries.length));
      marker.setPopupContent(popupForPlace(entries));
    });

    // Remove anything whose climbs were all deleted.
    tripMap.layers.forEach((layer, id) => {
      if (!seenTracks.has(id)) { layer.remove(); tripMap.layers.delete(id); }
    });
    tripMap.pins.forEach((marker, key) => {
      if (!places.has(key)) { marker.remove(); tripMap.pins.delete(key); }
    });

    // Frame all the trips once, then leave the view to whoever is using the map.
    const all = [...tripMap.layers.values(), ...tripMap.pins.values()];
    if (!tripMap.fitted && all.length) {
      tripMap.map.fitBounds(L.featureGroup(all).getBounds().pad(0.15), { maxZoom: 16 });
      tripMap.fitted = true;
    } else if (!tripMap.fitted) {
      tripMap.map.setView([config.mapStart.lat, config.mapStart.lng], config.mapStart.zoom);
    }
  }

  async function focusOnMap(id) {
    await initTripMap();
    $("map-section").scrollIntoView({ behavior: "smooth", block: "center" });
    const entry = state.entries.get(id);
    const layer = tripMap.layers.get(id) || (entry && tripMap.pins.get(placeKey(entry)));
    if (!layer) return;
    if (layer.getBounds) tripMap.map.fitBounds(layer.getBounds().pad(0.2), { maxZoom: 15 });
    else tripMap.map.setView(layer.getLatLng(), 16); // close enough to separate neighbouring stairs
    layer.openPopup();
  }

  function watchForMap() {
    if (!("IntersectionObserver" in window)) { initTripMap(); return; }
    const observer = new IntersectionObserver((seen) => {
      if (seen.some((s) => s.isIntersecting)) { observer.disconnect(); initTripMap(); }
    }, { rootMargin: "300px" });
    observer.observe($("map-section"));
  }


  // ---------- The log form ----------
  const form = {
    track: null,     // simplified GPX line, once a file is read
    gain: null,      // meters climbed according to the GPX file
    pin: null,       // { lat, lng } once a place is picked
    pinMap: null,
    pinMarker: null,
    busy: false,
  };

  function fillWhoList() {
    const select = $("who");
    const current = String(saved.get("participant") || "");
    select.replaceChildren(el("option", null, "Choose your name"));
    select.firstChild.value = "";
    [...state.participants.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((person) => {
        const option = el("option", null, person.name);
        option.value = String(person.id);
        select.append(option);
      });
    const add = el("option", null, "I'm not on the list yet");
    add.value = "new";
    select.append(add);
    select.value = [...select.options].some((o) => o.value === current) ? current : "";
    updateNewNameField();
  }

  function updateNewNameField() {
    $("new-name-field").hidden = $("who").value !== "new";
  }

  function fillDays() {
    const container = $("days");
    container.replaceChildren();
    const today = eventToday();
    const days = eventDays();
    const allowed = days.filter((d) => d <= today);
    // Default to the latest allowed day, which is today during the challenge.
    const chosen = allowed[allowed.length - 1];
    days.forEach((iso) => {
      const label = el("label");
      const input = el("input");
      input.type = "radio";
      input.name = "day";
      input.value = iso;
      input.disabled = iso > today;
      input.checked = iso === chosen;
      label.append(input, el("span", null, dayOnly(iso)));
      container.append(label);
    });
    return allowed.length > 0 && (phase() === "live" || phase() === "late");
  }

  function fillPlaceChoices() {
    const select = $("place-choice");
    const places = config.places || [];
    const blank = el("option", null, "Choose a place");
    blank.value = "";
    select.replaceChildren(blank);
    places.forEach((place, i) => {
      const option = el("option", null, place.name);
      option.value = String(i);
      select.append(option);
    });
    const other = el("option", null, "Another place (tap the map)");
    other.value = "other";
    select.append(other);
    select.value = places.length ? "" : "other";
  }

  function showError(message) {
    const node = $("form-error");
    node.textContent = message || "";
    node.hidden = !message;
    if (message) node.scrollIntoView({ block: "nearest" });
  }

  function resetForm() {
    $("meters").value = "";
    $("note").value = "";
    $("place").value = "";
    $("new-name").value = "";
    $("gpx-file").value = "";
    fillPlaceChoices();
    form.track = null;
    form.gain = null;
    form.pin = null;
    if (form.pinMarker) { form.pinMarker.remove(); form.pinMarker = null; }
    document.querySelector('input[name="map-mode"][value="none"]').checked = true;
    updateMapMode();
    $("gpx-use").hidden = true;
    $("gpx-status").textContent = GPX_HELP;
    $("pin-status").textContent = PIN_HELP;
    showError("");
  }
  const GPX_HELP = $("gpx-status").textContent;
  const PIN_HELP = $("pin-status").textContent;

  function openForm() {
    resetForm();
    fillWhoList();
    const canLog = fillDays();
    $("save-button").disabled = !canLog;
    if (!canLog) {
      showError({
        unset: "The organizer still needs to set the times for this challenge.",
        before: state.event && `Logging opens ${when(eventTimes().start)}.`,
        over: "The challenge is over, so logging is closed.",
      }[phase()] || "Logging isn't open right now.");
    }
    $("log-dialog").showModal();
    if ($("who").value) $("meters").focus();
  }

  function mapMode() {
    return document.querySelector('input[name="map-mode"]:checked').value;
  }

  function updateMapMode() {
    const mode = mapMode();
    const ownPlace = mode === "pin" && $("place-choice").value === "other";
    $("gpx-field").hidden = mode !== "gpx";
    $("place-choice-field").hidden = mode !== "pin";
    $("pin-field").hidden = !ownPlace;
    // A ready-made location already has a name, so only ask for one otherwise.
    $("place-field").hidden = !(mode === "gpx" || ownPlace);
    if (ownPlace) initPinMap();
  }

  function initPinMap() {
    if (form.pinMap) {
      // Leaflet measures its box when created, so re-measure now that it's visible.
      setTimeout(() => form.pinMap.invalidateSize(), 0);
      return;
    }
    const start = config.mapStart;
    form.pinMap = L.map("pin-map").setView([start.lat, start.lng], start.zoom);
    tileLayer().addTo(form.pinMap);
    form.pinMap.on("click", (event) => {
      const { lat, lng } = event.latlng.wrap();
      form.pin = { lat: +lat.toFixed(5), lng: +lng.toFixed(5) };
      if (form.pinMarker) form.pinMarker.setLatLng(event.latlng);
      else form.pinMarker = L.marker(event.latlng, { icon: pinIcon() }).addTo(form.pinMap);
      $("pin-status").textContent = "Pin placed. Tap somewhere else to move it.";
    });
  }

  async function readGpxFile(file) {
    form.track = null;
    form.gain = null;
    $("gpx-use").hidden = true;
    if (!file) { $("gpx-status").textContent = GPX_HELP; return; }
    if (file.size > 30 * 1024 * 1024) {
      $("gpx-status").textContent = "This file is over 30 MB. Choose a shorter activity.";
      return;
    }
    try {
      const result = window.PeaksGpx.process(await file.text());
      form.track = result.line;
      form.gain = result.gain;
      $("gpx-status").textContent = `Track ready: ${fmt(result.originalPoints)} points reduced to ${result.line.length}.`;
      if (result.gain > 0) {
        $("gpx-use").textContent = `Use ${fmt(result.gain)} m from this file (GPS estimate)`;
        $("gpx-use").hidden = false;
      }
      if (!$("place").value) {
        $("place").value = file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").slice(0, 80);
      }
    } catch (error) {
      $("gpx-status").textContent = error.message;
    }
  }

  async function submitForm(event) {
    event.preventDefault();
    if (form.busy) return;
    showError("");

    const who = $("who").value;
    const meters = Number($("meters").value);
    const day = document.querySelector('input[name="day"]:checked');
    const mode = mapMode();

    // Friendly checks for quick feedback. The database repeats them for real,
    // because anything in the browser can be bypassed.
    if (!who) return showError("Choose your name from the list.");
    if (who === "new" && !$("new-name").value.trim()) return showError("Enter your name.");
    if (!Number.isInteger(meters) || meters < 1) return showError("Enter the meters you climbed as a whole number.");
    if (!day) return showError("Choose the day you climbed.");
    if (mode === "gpx" && !form.track) return showError("Choose a GPX file, or set the map option to Skip.");
    const choice = $("place-choice").value;
    const preset = mode === "pin" && choice !== "" && choice !== "other" ? config.places[Number(choice)] : null;
    if (mode === "pin" && choice === "") return showError("Choose a place from the list, or set the map option to Skip.");
    if (mode === "pin" && choice === "other" && !form.pin) return showError("Tap the map to place your pin, or set the map option to Skip.");

    form.busy = true;
    $("save-button").disabled = true;
    $("save-button").textContent = "Saving";
    try {
      let participantId = Number(who);
      if (who === "new") {
        const person = await store.join($("new-name").value);
        state.participants.set(person.id, person);
        participantId = person.id;
      }
      const result = await store.addEntry({
        event_id: state.challenge.id, // the challenge on screen
        participant_id: participantId,
        meters,
        climbed_on: day.value,
        note: $("note").value.trim() || null,
        place_name: preset ? preset.name : mode === "none" ? null : $("place").value.trim() || null,
        lat: preset ? preset.lat : mode === "pin" ? form.pin.lat : null,
        lng: preset ? preset.lng : mode === "pin" ? form.pin.lng : null,
        track: mode === "gpx" ? form.track : null,
      });

      saved.set("participant", participantId);
      const tokens = saved.get("tokens") || {};
      tokens[result.entry.id] = result.delete_token;
      saved.set("tokens", tokens);

      if (form.track && mode === "gpx") tripMap.tracks.set(result.entry.id, form.track);
      upsertEntry(result.entry);
      $("log-dialog").close();
      toast(`Saved ${fmt(meters)} m`);
      render(); // if this climb reached a summit, that message replaces the one above
    } catch (error) {
      if (!handleSessionEnded(error)) showError(error.message);
    } finally {
      form.busy = false;
      $("save-button").disabled = false;
      $("save-button").textContent = "Save climb";
    }
  }


  // ---------- Loading and live updates ----------
  // Every climb goes into allEntries. Climbs of the challenge on screen also go
  // into entries, which is what the page draws.
  const onScreen = (entry) => state.challenge && entry.event_id === state.challenge.id;
  const upsertEntry = (entry) => {
    state.allEntries.set(entry.id, entry);
    if (onScreen(entry)) state.entries.set(entry.id, entry);
    else state.entries.delete(entry.id);
  };
  const removeEntry = (id) => {
    state.allEntries.delete(id);
    state.entries.delete(id);
    tripMap.tracks.delete(id);
  };
  const pickEntries = () => {
    state.entries = new Map([...state.allEntries].filter(([, entry]) => onScreen(entry)));
  };

  async function loadEverything() {
    const data = await store.load();
    state.isMember = data.isMember;
    state.events = new Map(data.events.map((event) => [event.id, event]));
    state.event = state.challenge ? state.events.get(state.challenge.id) || null : null;
    state.participants = new Map(data.participants.map((p) => [p.id, p]));
    state.allEntries = new Map(data.entries.map((e) => [e.id, e]));
    pickEntries();
    state.lastLoaded = Date.now();
  }

  // A change from anyone arrives here. We apply just that one row, so a live
  // update costs almost no data compared with downloading everything again.
  async function onLiveChange(table, type, row) {
    if (table === "participants") {
      if (type === "DELETE") state.participants.delete(row.id);
      else state.participants.set(row.id, row);
    } else {
      if (type === "DELETE") removeEntry(row.id);
      else {
        upsertEntry(row);
        if (row.has_track && tripMap.ready && !tripMap.tracks.has(row.id)) {
          try {
            const track = await store.loadTrack(row.id);
            if (track) tripMap.tracks.set(row.id, track.points);
          } catch { /* the track appears on the next reload */ }
        }
      }
    }
    render();
  }

  // Phones pause background pages and can miss updates, so catch up when someone
  // comes back after a while.
  function refreshOnReturn() {
    document.addEventListener("visibilitychange", async () => {
      if (document.visibilityState !== "visible" || store.isDemo || !state.appShown) return;
      if (Date.now() - state.lastLoaded < 5 * 60 * 1000) return;
      try {
        await loadEverything();
        if (state.isMember) render();
      } catch (error) {
        handleSessionEnded(error); // for other errors, keep showing what we have
      }
    });
  }

  function bindEvents() {
    $("log-button").addEventListener("click", openForm);
    $("log-close").addEventListener("click", () => $("log-dialog").close());
    $("log-form").addEventListener("submit", submitForm);
    $("who").addEventListener("change", updateNewNameField);
    $("place-choice").addEventListener("change", updateMapMode);
    document.querySelectorAll('input[name="map-mode"]').forEach((input) =>
      input.addEventListener("change", updateMapMode));
    $("gpx-file").addEventListener("change", (event) => readGpxFile(event.target.files[0]));
    $("gpx-use").addEventListener("click", () => {
      $("meters").value = form.gain;
      $("gpx-use").hidden = true;
    });
    $("board-more").addEventListener("click", () => {
      state.boardExpanded = !state.boardExpanded;
      renderBoard();
    });
    $("feed-more").addEventListener("click", () => {
      state.feedLimit += 20;
      renderFeed();
    });
    $("gate-form").addEventListener("submit", submitPassword);
    window.addEventListener("hashchange", () => {
      if (state.appShown && state.isMember) showChallenge(challengeFromLink() || defaultChallenge());
    });
    $("sign-out").addEventListener("click", signOutHere);
  }

  // ---------- The password screen ----------
  // Hiding the page here is only for looks. The real lock is in the database,
  // which sends nothing to a browser that hasn't signed in.
  function showGate(message) {
    if ($("log-dialog").open) $("log-dialog").close();
    $("app").hidden = true;
    $("gate").hidden = false;
    $("gate-error").textContent = message || "";
    $("gate-error").hidden = !message;
    $("gate-password").value = store.isDemo ? "demo" : "";
    $("gate-password").focus();
  }

  async function submitPassword(event) {
    event.preventDefault();
    const password = $("gate-password").value;
    const button = $("gate-button");
    if (!password) return showGateError("Enter the group password.");
    button.disabled = true;
    try {
      await store.signIn(password);
      // Reloading after an ended session guarantees nothing old is left behind.
      if (state.appShown) location.reload();
      else await enterApp();
    } catch (error) {
      showGateError(error.message);
      $("gate-password").select();
    } finally {
      button.disabled = false;
    }
  }

  function showGateError(message) {
    $("gate-error").textContent = message;
    $("gate-error").hidden = false;
  }

  // Clears this device's session and returns to the password screen.
  async function endSession(message) {
    state.endingSession = true;
    try { await store.signOut(); } catch { /* the password screen still appears */ }
    showGate(message);
    state.endingSession = false;
  }

  // Returns true if the error means the sign-in is no longer valid.
  function handleSessionEnded(error) {
    if (!error.signedOut) return false;
    endSession(error.message);
    return true;
  }

  async function signOutHere() {
    state.endingSession = true;
    try {
      await store.signOut();
      location.reload();
    } catch (error) {
      state.endingSession = false;
      toast(error.message);
    }
  }

  async function enterApp() {
    $("gate").hidden = true;
    $("app").hidden = false;
    state.appShown = true;
    watchForMap();

    try {
      await loadEverything();
    } catch (error) {
      if (handleSessionEnded(error)) return;
      $("event-status").textContent = `Couldn't load the climb: ${error.message} Reload the page to try again.`;
      return;
    }

    // Signed in, but not to the account named in settings.sql.
    if (!state.isMember) {
      endSession("Signed in, but this account has no access. Organizer: check that the email in settings.sql matches config.js.");
      return;
    }

    showChallenge(challengeFromLink() || defaultChallenge());
    store.subscribe(onLiveChange);

    // The countdown, the day number and the phase change with the clock, not
    // only with new climbs, so redraw the top of the page every 30 seconds.
    setInterval(() => {
      renderStatus(totalMeters());
      renderMenu();
    }, 30000);
  }


  // ---------- Switching challenges ----------
  // The challenge in the link (#solar-system), if there is one.
  function challengeFromLink() {
    const slug = decodeURIComponent(location.hash.slice(1));
    return config.challenges.find((c) => c.slug === slug) || null;
  }

  // The one that's running, or else the next to start, or else the latest to finish.
  function defaultChallenge() {
    const timed = config.challenges.filter((c) => state.events.has(c.id));
    const times = (c) => eventTimes(state.events.get(c.id));
    const inPhase = (...names) => timed.filter((c) => names.includes(phase(state.events.get(c.id))));
    return inPhase("live", "late")[0]
      || inPhase("before").sort((a, b) => times(a).start - times(b).start)[0]
      || timed.sort((a, b) => times(b).end - times(a).end)[0]
      || config.challenges[0];
  }

  const STATUS = { live: "now", late: "now", before: "upcoming", over: "finished", unset: "times not set" };

  function renderMenu() {
    const nav = $("challenge-nav");
    nav.hidden = config.challenges.length < 2;
    nav.replaceChildren(...config.challenges.map((challenge) => {
      const link = el("a", null, challenge.name);
      link.href = `#${challenge.slug}`;
      if (challenge === state.challenge) link.setAttribute("aria-current", "page");
      link.append(el("span", "nav-status", STATUS[phase(state.events.get(challenge.id) || null)]));
      return link;
    }));
  }

  // Draws a challenge from scratch: its ridge, its climbs, its leaderboard.
  function showChallenge(challenge) {
    let running = 0;
    peaks = challenge.peaks.map((peak) => ({ ...peak, cumulative: (running += peak.height) }));
    GOAL = running;
    state.challenge = challenge;
    state.event = state.events.get(challenge.id) || null;
    pickEntries();
    state.boardExpanded = false;
    state.feedLimit = 12;
    tripMap.fitted = false;
    document.title = `${challenge.name}, ${config.siteName}`;
    $("event-name").textContent = challenge.name;

    // Swap the drawing without the finished look fading out or the route undrawing.
    const hero = $("hero");
    hero.classList.add("no-motion");
    cancelAnimationFrame(climbMotion.frame);
    climbMotion.shown = 0;
    climbMotion.first = true; // the marker climbs from the bottom again
    buildClimb();
    hero.getBoundingClientRect(); // makes the browser apply the change before motion returns
    hero.classList.remove("no-motion");

    state.previousTotal = totalMeters(); // no summit messages for switching
    renderMenu();
    render();
  }

  async function start() {
    document.title = config.siteName;
    $("gate-name").textContent = config.siteName;
    $("gate-username").value = store.username;
    $("demo-note").hidden = !store.isDemo;
    if (store.isDemo) $("gate-hint").textContent = "Demo mode: any password works.";
    // Draw something for the password screen before any data has loaded.
    state.challenge = challengeFromLink() || config.challenges[0];
    let running = 0;
    peaks = state.challenge.peaks.map((peak) => ({ ...peak, cumulative: (running += peak.height) }));
    GOAL = running;
    buildClimb();
    bindEvents();
    refreshOnReturn();

    // For example, the organizer changed the password and this session expired.
    store.onSignedOut(() => {
      if (!state.endingSession) showGate("Your sign-in has ended. Enter the group password again.");
    });

    if (await store.hasSession()) await enterApp();
    else showGate();
  }

  start().catch((error) => {
    console.error(error);
    $("gate").hidden = true;
    $("app").hidden = false;
    $("event-status").textContent = "Something went wrong while drawing the page. Reload to try again.";
  });
})();
