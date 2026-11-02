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
        const [isMember, events, participants, entries] = await Promise.all([
          client.rpc("is_member").then(unwrap),
          client.from("event").select("*").eq("id", 1).then(unwrap),
          loadAll("participants", "id"),
          loadAll("entries", "id"),
        ]);
        return { isMember, event: events[0] || null, participants, entries };
      },

      async join(name) {
        return unwrap(await client.rpc("join_event", { p_name: name }));
      },

      async addEntry(e) {
        return unwrap(await client.rpc("add_entry", {
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
    const now = new Date();
    const utcToday = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    const day = (offset) => iso(new Date(utcToday.getTime() + offset * 86400000));

    // Sample data: invented people and trips, always in the middle of the challenge.
    const names = ["Mara", "Jonas", "Ida", "Felix", "Noor", "Tomás", "Lena", "Oskar", "Priya", "Emil", "Sofia", "Ben",
      "Hanna", "Yusuf", "Clara", "Mats", "Elif", "Paul", "Greta", "Luca", "Nina", "Anton", "Maya", "Theo",
      "Rosa", "Henrik", "Amira", "Karl", "Julia", "Sam", "Alma", "Nils", "Vera", "Omar", "Tessa", "Finn"];
    const participants = names.map((name, i) => ({ id: i + 1, name }));
    const notes = ["Stairs at work, all of them", "Morning hill repeats", "Bike commute the long way", "Windy ridge walk",
      "Fresh snow up top", "Lunch break climb", "With the dog", "Tired legs, good views"];

    // A small repeatable random generator, so the demo looks the same on every load.
    let seed = 42;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

    let nextId = 1;
    const entries = [];
    const tracks = [];
    participants.forEach((person) => {
      const count = 1 + Math.floor(random() * 1.8);
      for (let i = 0; i < count; i++) {
        entries.push({
          id: nextId++, participant_id: person.id,
          meters: 120 + Math.round(random() * 60) * 10,
          climbed_on: day(-Math.floor(random() * 3)),
          note: random() < 0.4 ? notes[Math.floor(random() * notes.length)] : null,
          place_name: null, lat: null, lng: null, has_track: false,
          created_at: new Date().toISOString(),
        });
      }
    });

    function addTrip(personIndex, meters, offset, place, lat, lng, wiggle) {
      const entry = {
        id: nextId++, participant_id: personIndex + 1, meters, climbed_on: day(offset),
        note: null, place_name: place, lat: wiggle ? null : lat, lng: wiggle ? null : lng,
        has_track: !!wiggle, created_at: new Date().toISOString(),
      };
      entries.push(entry);
      if (wiggle) {
        const points = [];
        for (let i = 0; i <= 60; i++) {
          const t = i / 60;
          points.push([
            +(lat + t * wiggle + Math.sin(t * 13) * wiggle * 0.12).toFixed(5),
            +(lng + Math.sin(t * Math.PI) * wiggle * 0.8 + Math.cos(t * 9) * wiggle * 0.1).toFixed(5),
          ]);
        }
        tracks.push({ entry_id: entry.id, points });
      }
    }
    addTrip(0, 1150, -2, "Forest loop", 63.700, 23.000, 0.02);
    addTrip(3, 980, -1, "Ridge walk", 63.735, 23.070, 0.018);
    addTrip(20, 640, -2, "Cabin hill", 63.710, 23.020, null);
    // Several climbs at each ready-made location, as there will be in real use.
    (config.places || []).forEach((place, p) => {
      for (let n = 0; n < 5 - p; n++) {
        addTrip((p * 7 + n * 5) % 36, 180 + Math.round(random() * 12) * 10, -Math.floor(random() * 3),
          place.name, place.lat, place.lng, null);
      }
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
          event: { id: 1, start_date: day(-2), end_date: day(2), max_meters_per_entry: 5000 },
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
        if (!(e.meters >= 1 && e.meters <= 5000)) throw new Error("Enter between 1 and 5000 meters for one entry.");
        if (e.climbed_on > day(0)) throw new Error("That date is still in the future.");
        const entry = {
          id: nextId++, participant_id: e.participant_id, meters: e.meters, climbed_on: e.climbed_on,
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
