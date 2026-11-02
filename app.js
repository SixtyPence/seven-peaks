// Draws the page from the data and handles what people click.
// The pattern: `state` holds the data, and render() draws the page from `state`.
// When anything changes we update `state` and call render() again, so what's on
// screen can't drift away from the data.

(function () {
  const config = window.PEAKS_CONFIG;
  const store = window.PeaksStore.create(config);
  const $ = (id) => document.getElementById(id);

  const state = {
    event: null,
    participants: new Map(), // id -> person
    entries: new Map(),      // id -> climb. A Map means a repeated update can't double-count.
    boardExpanded: false,
    feedLimit: 12,
    lastLoaded: 0,
    previousTotal: null,
    appShown: false,
    isMember: false,
    endingSession: false,
  };

  // Work out where each summit sits on the way to the goal.
  let running = 0;
  const peaks = config.peaks.map((peak) => {
    running += peak.height;
    return { ...peak, cumulative: running };
  });
  const GOAL = running;


  // ---------- Small helpers ----------
  const number = new Intl.NumberFormat("en-GB");
  const fmt = (n) => number.format(Math.round(n));
  const pad = (n) => String(n).padStart(2, "0");
  const localToday = () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  // Dates are stored as plain YYYY-MM-DD. Reading them as UTC and formatting them
  // as UTC means a time zone can never push a date onto the wrong day.
  const asDate = (iso) => new Date(iso + "T00:00:00Z");
  const formatDate = (iso, options) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...options }).format(asDate(iso));
  const shortDay = (iso) => formatDate(iso, { weekday: "short", day: "numeric", month: "short" });
  const dayOnly = (iso) => formatDate(iso, { weekday: "short" });

  function eventDays() {
    if (!state.event) return [];
    const days = [];
    for (let t = asDate(state.event.start_date).getTime(); t <= asDate(state.event.end_date).getTime(); t += 86400000) {
      days.push(new Date(t).toISOString().slice(0, 10));
    }
    return days;
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
  // Every summit sits exactly where its cumulative total falls on the bar below.
  // The small bumps are fixed offsets, so the shape is the same on every load.
  function ridgePath() {
    const H = 200;
    const scaleY = (height) => H - (height / 8849) * (H - 10);
    const toX = (meters) => (meters / GOAL) * 1000;
    const bumps = [[0.3, 0.42], [0.52, 0.66], [0.72, 0.74], [0.86, 0.9]];
    let d = `M0 ${H} L0 ${H * 0.82}`;
    let previous = 0;
    peaks.forEach((peak, i) => {
      const x0 = toX(previous);
      const x1 = toX(peak.cumulative);
      const w = x1 - x0;
      const top = scaleY(peak.height);
      const col = H * (0.62 + ((i * 3) % 5) * 0.035);
      if (i > 0) d += ` L${(x0 + w * 0.12).toFixed(1)} ${col.toFixed(1)}`;
      bumps.forEach(([along, up], b) => {
        const wobble = ((i + b) % 2 === 0 ? 1 : -1) * 5;
        const y = col + (top - col) * up + wobble;
        d += ` L${(x0 + w * along).toFixed(1)} ${y.toFixed(1)}`;
      });
      d += ` L${x1.toFixed(1)} ${top.toFixed(1)}`;
      previous = peak.cumulative;
    });
    return d + ` L1000 ${H} Z`;
  }

  function buildClimb() {
    const d = ridgePath();
    $("ridge-base-path").setAttribute("d", d);
    $("ridge-fill-path").setAttribute("d", d);
    $("gate-ridge-path").setAttribute("d", d);
    $("bar").setAttribute("aria-valuemax", GOAL);

    const ticks = $("summit-ticks");
    peaks.slice(0, -1).forEach((peak) => {
      const tick = el("i");
      tick.style.left = `${(peak.cumulative / GOAL) * 100}%`;
      ticks.append(tick);
    });

    // Using each height as a column width keeps the labels on the same scale.
    $("peak-labels").style.gridTemplateColumns = peaks.map((p) => `${p.height}fr`).join(" ");
    peaks.forEach((peak, i) => {
      const label = el("li");
      label.dataset.peak = i;
      label.title = `${peak.name} is ${fmt(peak.height)} m high. The group reaches it at ${fmt(peak.cumulative)} m.`;
      label.append(el("span", "peak-name", peak.name), el("span", "peak-meta", `${fmt(peak.cumulative)} m`));
      $("peak-labels").append(label);

      const row = el("li");
      row.dataset.peak = i;
      row.append(el("span", "route-name", peak.name), el("span", "route-meta", `${fmt(peak.cumulative)} m`));
      $("route-list").append(row);
    });
  }


  // ---------- Rendering ----------
  const totalMeters = () => {
    let total = 0;
    state.entries.forEach((e) => { total += e.meters; });
    return total;
  };

  function renderHero() {
    const total = totalMeters();
    const share = Math.min(total / GOAL, 1);
    const percent = share * 100;

    $("total-climbed").textContent = fmt(total);
    // Math.floor, so the page only ever says 100% once the goal is truly reached.
    $("goal-caption").textContent = total >= GOAL
      ? `Goal of ${fmt(GOAL)} m reached`
      : `of ${fmt(GOAL)} m, ${percent >= 10 ? Math.floor(percent) : percent.toFixed(1)}% of the way`;
    $("ridge-fill").style.clipPath = `inset(0 ${100 - percent}% 0 0)`;
    $("bar-fill").style.width = `${percent}%`;
    $("bar").setAttribute("aria-valuenow", Math.min(total, GOAL));
    $("bar").setAttribute("aria-valuetext", `${fmt(total)} of ${fmt(GOAL)} meters`);

    const nextIndex = peaks.findIndex((p) => total < p.cumulative);
    document.querySelectorAll("[data-peak]").forEach((node) => {
      const i = Number(node.dataset.peak);
      node.classList.toggle("reached", total >= peaks[i].cumulative);
      node.classList.toggle("current", i === nextIndex);
    });

    if (nextIndex === -1) {
      $("next-label").textContent = "Summits";
      $("next-summit").textContent = "All seven climbed";
      $("next-detail").textContent = total > GOAL ? `${fmt(total - GOAL)} m beyond the goal` : "Goal reached";
    } else {
      $("next-label").textContent = "Next summit";
      $("next-summit").textContent = peaks[nextIndex].name;
      $("next-detail").textContent = `${fmt(peaks[nextIndex].cumulative - total)} m to go`;
    }

    renderStatus(total);

    // Celebrate summits that were reached while the page was open.
    if (state.previousTotal !== null) {
      const crossed = peaks.filter((p) => state.previousTotal < p.cumulative && total >= p.cumulative).pop();
      if (crossed) toast(`${crossed.name} summited! Peak ${peaks.indexOf(crossed) + 1} of ${peaks.length}.`, 6000);
    }
    state.previousTotal = total;
  }

  function renderStatus(total) {
    const event = state.event;
    if (!event) {
      $("event-status").textContent = store.isDemo ? "" : "The organizer still needs to set the dates.";
      return;
    }
    const days = eventDays();
    const today = localToday();
    const range = `${shortDay(event.start_date)} to ${shortDay(event.end_date)}`;
    const dayIndex = days.indexOf(today);

    if (today < event.start_date) {
      $("event-status").textContent = `Starts ${shortDay(event.start_date)}, ends ${shortDay(event.end_date)}`;
    } else if (today > event.end_date) {
      $("event-status").textContent = `Finished. Ran ${range}`;
    } else {
      $("event-status").textContent = `Day ${dayIndex + 1} of ${days.length}, ${range}`;
    }

    // Pace: the group's target by the end of today, assuming equal days.
    const live = dayIndex !== -1;
    $("pace-block").hidden = !live;
    $("bar-pace").hidden = !live;
    if (live) {
      const target = (GOAL * (dayIndex + 1)) / days.length;
      $("bar-pace").style.left = `${(target / GOAL) * 100}%`;
      const gap = total - target;
      $("pace-main").textContent = gap >= 0 ? `${fmt(gap)} m ahead` : `${fmt(-gap)} m behind`;
      $("pace-detail").textContent = `Tonight's target: ${fmt(target)} m (white mark)`;
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
  const tripMap = { map: null, layers: new Map(), tracks: new Map(), fitted: false, ready: false };

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

  function popupFor(entry) {
    const box = el("div");
    const person = state.participants.get(entry.participant_id);
    box.append(
      el("span", "popup-title", entry.place_name || (person ? person.name : "Trip")),
      el("span", null, `${person ? person.name + ", " : ""}${fmt(entry.meters)} m on ${shortDay(entry.climbed_on)}`)
    );
    return box;
  }

  function renderMapData() {
    if (!tripMap.ready) return;
    const seen = new Set();
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();

    state.entries.forEach((entry) => {
      const points = tripMap.tracks.get(entry.id);
      const hasPin = entry.lat != null;
      if (!points && !hasPin) return;
      seen.add(entry.id);
      if (tripMap.layers.has(entry.id)) return;

      const layer = points
        ? L.polyline(points, { color: accent, weight: 4, opacity: 0.85 })
        : L.marker([entry.lat, entry.lng], { icon: pinIcon(), title: entry.place_name || "" });
      layer.bindPopup(popupFor(entry)).addTo(tripMap.map);
      tripMap.layers.set(entry.id, layer);
    });

    // Remove anything whose climb was deleted.
    tripMap.layers.forEach((layer, id) => {
      if (!seen.has(id)) { layer.remove(); tripMap.layers.delete(id); }
    });

    // Frame all the trips once, then leave the view to whoever is using the map.
    if (!tripMap.fitted && tripMap.layers.size) {
      const group = L.featureGroup([...tripMap.layers.values()]);
      tripMap.map.fitBounds(group.getBounds().pad(0.15), { maxZoom: 12 });
      tripMap.fitted = true;
    }
  }

  async function focusOnMap(id) {
    await initTripMap();
    $("map-section").scrollIntoView({ behavior: "smooth", block: "center" });
    const layer = tripMap.layers.get(id);
    if (!layer) return;
    if (layer.getBounds) tripMap.map.fitBounds(layer.getBounds().pad(0.2), { maxZoom: 14 });
    else tripMap.map.setView(layer.getLatLng(), 11);
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
    const today = localToday();
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
    return allowed.length > 0;
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
      showError(state.event
        ? `Logging opens on ${shortDay(state.event.start_date)}.`
        : "The organizer still needs to set the dates.");
    }
    $("log-dialog").showModal();
    if ($("who").value) $("meters").focus();
  }

  function mapMode() {
    return document.querySelector('input[name="map-mode"]:checked').value;
  }

  function updateMapMode() {
    const mode = mapMode();
    $("gpx-field").hidden = mode !== "gpx";
    $("pin-field").hidden = mode !== "pin";
    $("place-field").hidden = mode === "none";
    if (mode === "pin") initPinMap();
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
    if (mode === "pin" && !form.pin) return showError("Tap the map to place your pin, or set the map option to Skip.");

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
        participant_id: participantId,
        meters,
        climbed_on: day.value,
        note: $("note").value.trim() || null,
        place_name: mode === "none" ? null : $("place").value.trim() || null,
        lat: mode === "pin" ? form.pin.lat : null,
        lng: mode === "pin" ? form.pin.lng : null,
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
  const upsertEntry = (entry) => state.entries.set(entry.id, entry);
  const removeEntry = (id) => {
    state.entries.delete(id);
    tripMap.tracks.delete(id);
  };

  async function loadEverything() {
    const data = await store.load();
    state.isMember = data.isMember;
    state.event = data.event;
    state.participants = new Map(data.participants.map((p) => [p.id, p]));
    state.entries = new Map(data.entries.map((e) => [e.id, e]));
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

    // Draw the bar empty first, so the climb animates up to the real total once.
    state.previousTotal = totalMeters(); // no summit message for the initial load
    renderBoard();
    renderFeed();
    renderStatus(totalMeters());
    document.documentElement.classList.add("has-motion");
    requestAnimationFrame(() => requestAnimationFrame(renderHero));

    store.subscribe(onLiveChange);
  }

  async function start() {
    document.title = config.eventName;
    $("event-name").textContent = config.eventName;
    $("gate-name").textContent = config.eventName;
    $("gate-username").value = store.username;
    $("demo-note").hidden = !store.isDemo;
    if (store.isDemo) $("gate-hint").textContent = "Demo mode: any password works.";
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
