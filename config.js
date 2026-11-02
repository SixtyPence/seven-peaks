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

  // Where the "another place" map opens before anyone has added a trip.
  mapStart: { lat: 63.722, lng: 23.043, zoom: 14 },

  // The ready-made locations in the log form. Add, remove or rename freely.
  // People can always choose "Another place" and tap the map instead.
  places: [
    { name: "Kronoby stairs",      lat: 63.717994, lng: 23.046666 },
    { name: "Internat B stairs",   lat: 63.724055, lng: 23.040798 },
    { name: "Internat A stairs",   lat: 63.724248, lng: 23.041004 },
    { name: "New Mannheim Stairs", lat: 63.724489, lng: 23.041940 },
    { name: "Gripen Stairs",       lat: 63.723903, lng: 23.041726 },
  ],

  // The route, in climbing order. The total of these heights is the goal.
  // Lowest first, so that Everest is the finale.
  // For Oceania this uses Puncak Jaya, the mountaineers' usual choice. Some lists
  // use Mount Kosciuszko (2,228 m) instead, which would make the goal 40,657 m.
  peaks: [
    { name: "Puncak Jaya", continent: "Oceania",       height: 4884 },
    { name: "Vinson",      continent: "Antarctica",    height: 4892 },
    { name: "Elbrus",      continent: "Europe",        height: 5642 },
    { name: "Kilimanjaro", continent: "Africa",        height: 5895 },
    { name: "Denali",      continent: "North America", height: 6190 },
    { name: "Aconcagua",   continent: "South America", height: 6961 },
    { name: "Everest",     continent: "Asia",          height: 8849 },
  ],
};
