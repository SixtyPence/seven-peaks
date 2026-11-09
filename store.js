// The data layer. The rest of the page only knows these functions:
//   hasSession()  signIn()  signOut()  onSignedOut()
//   load()  join()  addEntry()  deleteEntry()  loadTracks()  loadTrack()  subscribe()
// Two versions exist with the same functions: one talks to Supabase, one keeps
// sample data in memory. Swapping them changes nothing else on the page.

window.PeaksStore = (function () {
  function createSupabaseStore(config) {
    // After a sign-in, the library keeps the session in this browser, renews it
    // in the background, and attaches it to every request and to live updates.
    const client = window.supabase.createClient(config.supabaseUrl, config.supabaseKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });

    // Errors the database gives when a request isn't signed in, or no longer is.
    const SIGNED_OUT_CODES = new Set(["42501", "PGRST301", "PGRST302", "PGRST303"]);

    // Turns Supabase's { data, error } result into a value or a thrown error.
    function unwrap({ data, error }) {
      if (!error) return data;
      if (SIGNED_OUT_CODES.has(error.code) || /jwt/i.test(error.message || "")) {
        const ended = new Error("Your sign-in has ended. Enter the group password again.");
        ended.signedOut = true;
        throw ended;
      }
      throw new Error(error.message || "The database didn't respond. Check your connection and try again.");
    }

    // The API returns at most 1000 rows per request, so ask page by page.
    async function loadAll(table, order) {
      const rows = [];
      const pageSize = 1000;
      for (let from = 0; ; from += pageSize) {
        const page = unwrap(
          await client.from(table).select("*").order(order).range(from, from + pageSize - 1)
        );
        rows.push(...page);
        if (page.length < pageSize) return rows;
      }
    }

    return {
      isDemo: false,
      username: config.sharedEmail,

      async hasSession() {
        const { data } = await client.auth.getSession();
        return !!data.session;
      },

      async signIn(password) {
        if (!config.sharedEmail) {
          throw new Error("The organizer still needs to add sharedEmail to config.js.");
        }
        // Visitors only type the password. The page supplies the shared email.
        const { error } = await client.auth.signInWithPassword({ email: config.sharedEmail, password });
        if (!error) return;
        if (error.code === "email_not_confirmed") {
          throw new Error("The organizer needs to confirm the shared account in Supabase.");
        }
        if (error.code === "invalid_credentials" || error.status === 400) {
          throw new Error("That password isn't right. Check it and try again.");
        }
        if (error.status === 429) {
          throw new Error("Too many attempts. Wait a few minutes and try again.");
        }
        throw new Error("The sign-in service didn't respond. Check your connection and try again.");
      },

      async signOut() {
        // "local" matters here! Everyone shares one account, and the default
        // ("global") would sign out all 36 people instead of just this device.
        const { error } = await client.auth.signOut({ scope: "local" });
        if (error) throw new Error("Couldn't sign out. Check your connection and try again.");
      },

      // Runs if the session ends by itself, such as after a password change.
      onSignedOut(callback) {
        client.auth.onAuthStateChange((event) => {
          // The callback must not call Supabase itself, because the library is
          // still busy at this point. Ours only changes what's on screen.
          if (event === "SIGNED_OUT") callback();
        });
      },

      async load() {
        // Every challenge's times and every climb. The page picks out the
        // challenge on screen, so switching needs no new download.
        const [isMember, events, participants, entries] = await Promise.all([
          client.rpc("is_member").then(unwrap),
          client.from("event").select("*").order("id").then(unwrap),
          loadAll("participants", "id"),
          loadAll("entries", "id"),
        ]);
        return { isMember, events, participants, entries };
      },

      async join(name) {
        return unwrap(await client.rpc("join_event", { p_name: name }));
      },

      async addEntry(e) {
        return unwrap(await client.rpc("add_entry", {
          p_event_id: e.event_id,
          p_participant_id: e.participant_id,
          p_meters: e.meters,
          p_climbed_on: e.climbed_on,
          p_note: e.note,
          p_place_name: e.place_name,
          p_lat: e.lat,
          p_lng: e.lng,
          p_track: e.track,
        }));
      },

      async deleteEntry(id, token) {
        return unwrap(await client.rpc("delete_entry", { p_entry_id: id, p_delete_token: token }));
      },

      loadTracks() { return loadAll("tracks", "entry_id"); },

      async loadTrack(entryId) {
        const rows = unwrap(await client.from("tracks").select("*").eq("entry_id", entryId));
        return rows[0] || null;
      },

      // Live updates: the database pushes each change over a WebSocket, so the
      // page never has to keep asking whether anything is new.
      subscribe(onChange) {
        client
          .channel("challenge")
          .on("postgres_changes", { event: "*", schema: "public", table: "entries" }, (p) =>
            onChange("entries", p.eventType, p.eventType === "DELETE" ? p.old : p.new))
          .on("postgres_changes", { event: "*", schema: "public", table: "participants" }, (p) =>
            onChange("participants", p.eventType, p.eventType === "DELETE" ? p.old : p.new))
          .subscribe();
      },
    };
  }

  function createDemoStore(config) {
    const iso = (date) => date.toISOString().slice(0, 10);
    // Days on the demo's clock (Helsinki), so they match the challenge days.
    const zoneDay = (moment) => {
      const parts = {};
      new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Helsinki", year: "numeric", month: "2-digit", day: "2-digit" })
        .formatToParts(moment).forEach((part) => { parts[part.type] = part.value; });
      return `${parts.year}-${parts.month}-${parts.day}`;
    };
    const zoneToday = new Date(`${zoneDay(new Date())}T00:00:00Z`);
    const day = (offset) => iso(new Date(zoneToday.getTime() + offset * 86400000));

    // Sample data: invented people and trips. The first challenge in
    // challenges.js is in its third day, about 40% of the way. Each older one
    // finished a week earlier than the one before it, with the goal reached.
    const names = ["Mara", "Jonas", "Ida", "Felix", "Noor", "Tomás", "Lena", "Oskar", "Priya", "Emil", "Sofia", "Ben",
      "Hanna", "Yusuf", "Clara", "Mats", "Elif", "Paul", "Greta", "Luca", "Nina", "Anton", "Maya", "Theo",
      "Rosa", "Henrik", "Amira", "Karl", "Julia", "Sam", "Alma", "Nils", "Vera", "Omar", "Tessa", "Finn"];
    const participants = names.map((name, i) => ({ id: i + 1, name }));
    const notes = ["Stairs at work, all of them", "Morning hill repeats", "Bike commute the long way", "Windy ridge walk",
      "Fresh snow up top", "Lunch break climb", "With the dog", "Tired legs, good views"];

    // A small repeatable random generator, so the demo looks the same on every load.
    let seed = 42;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

    // 08:00 to 16:00 Helsinki is 06:00 to 14:00 UTC in winter.
    const events = config.challenges.map((challenge, i) => {
      const startDay = i === 0 ? -2 : -7 * i - 4;
      return {
        id: challenge.id, starts_at: `${day(startDay)}T06:00:00Z`, ends_at: `${day(startDay + 4)}T14:00:00Z`,
        time_zone: "Europe/Helsinki", late_minutes: 60, max_meters_per_entry: 5000,
      };
    });

    let nextId = 1;
    const entries = [];
    const tracks = [];

    function trackNear(lat, lng, size) {
      const points = [];
      for (let i = 0; i <= 60; i++) {
        const t = i / 60;
        points.push([
          +(lat + t * size + Math.sin(t * 13) * size * 0.12).toFixed(5),
          +(lng + Math.sin(t * Math.PI) * size * 0.8 + Math.cos(t * 9) * size * 0.1).toFixed(5),
        ]);
      }
      return points;
    }

    // Oldest challenge first, so climb numbers rise with time as they do for real.
    [...config.challenges].reverse().forEach((challenge) => {
      const index = config.challenges.indexOf(challenge);
      const event = events[index];
      const goal = challenge.peaks.reduce((sum, peak) => sum + peak.height, 0);
      const target = index === 0 ? goal * 0.4 : goal + 2400;
      const own = [];
      for (let total = 0; total < target; ) {
        const meters = 120 + Math.round(random() * 60) * 10;
        const entry = {
          id: nextId++, event_id: challenge.id,
          participant_id: 1 + Math.floor(random() * participants.length), meters,
          note: random() < 0.3 ? notes[Math.floor(random() * notes.length)] : null,
          place_name: null, lat: null, lng: null, has_track: false,
        };
        // Some climbs at the ready-made locations, as there will be in real use.
        const place = random() < 0.25 && config.places && config.places[Math.floor(random() * config.places.length)];
        if (place) Object.assign(entry, { place_name: place.name, lat: place.lat, lng: place.lng });
        own.push(entry);
        total += meters;
      }
      // Two longer trips with GPX tracks.
      [["Forest loop", 63.700, 23.000, 0.02, 1150], ["Ridge walk", 63.735, 23.070, 0.018, 980]].forEach(([name, lat, lng, size, meters], t) => {
        const entry = own[Math.floor(own.length * (0.3 + t * 0.3))];
        Object.assign(entry, { place_name: name, meters, has_track: true });
        tracks.push({ entry_id: entry.id, points: trackNear(lat + index * 0.01, lng, size) });
      });

      // Spread the climbs over the challenge's daytime hours, 08:00 to 20:00
      // Helsinki, in the order they were logged, so summit times look real.
      const windows = [];
      const start = Date.parse(event.starts_at), end = Math.min(Date.parse(event.ends_at), Date.now() - 60000);
      for (let t = Date.parse(`${zoneDay(new Date(start))}T06:00:00Z`); t < end; t += 86400000) {
        const from = Math.max(t, start), to = Math.min(t + 12 * 3600000, end);
        if (to > from) windows.push([from, to]);
      }
      const daytime = windows.reduce((sum, [from, to]) => sum + to - from, 0);
      own.forEach((entry, i) => {
        let left = (daytime * (i + 1)) / (own.length + 1);
        let moment = new Date(end);
        for (const [from, to] of windows) {
          if (left <= to - from) { moment = new Date(from + left); break; }
          left -= to - from;
        }
        entry.created_at = moment.toISOString();
        entry.climbed_on = zoneDay(moment);
      });
      entries.push(...own);
    });

    const ownTokens = new Set();

    return {
      isDemo: true,
      username: "",
      async hasSession() { return false; },
      async signIn(password) {
        if (!password) throw new Error("Enter the group password.");
      },
      async signOut() {},
      onSignedOut() {},
      async load() {
        return {
          isMember: true,
          events: events.map((e) => ({ ...e })),
          participants: participants.map((p) => ({ ...p })),
          entries: entries.map((e) => ({ ...e })),
        };
      },
      async join(name) {
        const clean = (name || "").trim().replace(/\s+/g, " ");
        if (!clean || clean.length > 40) throw new Error("Enter a name between 1 and 40 characters.");
        const found = participants.find((p) => p.name.toLowerCase() === clean.toLowerCase());
        if (found) return { ...found };
        const person = { id: participants.length + 1, name: clean };
        participants.push(person);
        return { ...person };
      },
      async addEntry(e) {
        const event = events.find((ev) => ev.id === e.event_id);
        if (!event) throw new Error("The organizer has not set the times for this challenge yet.");
        if (Date.now() > Date.parse(event.ends_at) + event.late_minutes * 60000) {
          throw new Error("The challenge is over, so no more climbs can be logged.");
        }
        if (!(e.meters >= 1 && e.meters <= 5000)) throw new Error("Enter between 1 and 5000 meters for one entry.");
        if (e.climbed_on > day(0)) throw new Error("That day is still in the future.");
        const entry = {
          id: nextId++, event_id: e.event_id, participant_id: e.participant_id, meters: e.meters, climbed_on: e.climbed_on,
          note: e.note || null, place_name: e.place_name || null, lat: e.lat, lng: e.lng,
          has_track: !!e.track, created_at: new Date().toISOString(),
        };
        entries.push(entry);
        if (e.track) tracks.push({ entry_id: entry.id, points: e.track });
        const token = "demo-" + entry.id;
        ownTokens.add(token);
        return { entry: { ...entry }, delete_token: token };
      },
      async deleteEntry(id, token) {
        if (!ownTokens.has(token)) throw new Error("This entry can only be deleted from the device that logged it.");
        const i = entries.findIndex((e) => e.id === id);
        if (i >= 0) entries.splice(i, 1);
        return true;
      },
      async loadTracks() { return tracks.map((t) => ({ ...t })); },
      async loadTrack(id) { return tracks.find((t) => t.entry_id === id) || null; },
      subscribe() {},
    };
  }

  return {
    create(config) {
      return config.supabaseUrl && config.supabaseKey
        ? createSupabaseStore(config)
        : createDemoStore(config);
    },
  };
})();
