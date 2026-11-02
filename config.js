// The only file you need to edit to connect the page to your database.
//
// While supabaseUrl is empty, the page runs in demo mode with sample data.
// The three connection values below are public: every visitor's browser needs
// them, and anyone can read this file. What protects your data is the group
// password and the rules in supabase/schema.sql. Never put the password here,
// or a key marked "secret" or "service_role".

window.PEAKS_CONFIG = {
  eventName: "Seven Peaks Challenge",

  // Supabase > your project > Connect (or Settings > API Keys)
  supabaseUrl: "https://zdhbiynvtrsoiljwlmpn.supabase.co",   // looks like https://abcdefgh.supabase.co
  supabaseKey: "sb_publishable_M3RloT4ZoeoD5F1Rkpo08w_hEaqZiAs",   // the publishable key, starts with sb_publishable_ (older projects: the anon key)

  // The shared account's email. People only type the password, so the page
  // supplies this for them. It must match supabase/settings.sql.
  sharedEmail: "thoreau8@protonmail.ch",

  // Used to work out each person's fair share of the climb.
  expectedParticipants: 36,

  // Where the "pick a place" map opens before anyone has added a trip.
  mapStart: { lat: 47.5, lng: 11.5, zoom: 6 },

  // The route, in climbing order. The total of these heights is the goal.
  // Lowest first, so that Everest is the finale.
  peaks: [
    { name: "Dhaulagiri",    height: 8167 },
    { name: "Cho Oyu",       height: 8188 },
    { name: "Makalu",        height: 8485 },
    { name: "Lhotse",        height: 8516 },
    { name: "Kangchenjunga", height: 8586 },
    { name: "K2",            height: 8611 },
    { name: "Everest",       height: 8849 },
  ],
};
