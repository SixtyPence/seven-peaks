// What the site shows: the challenges, their peaks, and the ready-made places.
// Connection details live separately in config.js, so you can upload a new
// version of this file without touching them.
//
// Each challenge's "id" must match the number in supabase/settings.sql, and
// climbs are stored with it. "slug" is the challenge's own link, for example
// https://your-name.github.io/seven-peaks/#solar-system
//
// The page opens on the challenge that's running, or else the next one to
// start, or else the one that finished last. The menu lists them in this order.

window.PEAKS_CONTENT = {
  siteName: "Seven Peaks Challenge",

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

  // Each challenge's route, in climbing order. The total of the heights is the
  // goal. Lowest first, so that the tallest peak is the finale. "region" is
  // shown under each peak. An optional "short" name is used on the ridge when
  // the screen is too narrow for the full one.
  challenges: [
    {
      id: 2,
      slug: "solar-system",
      name: "Solar System Peaks",
      // The seven tallest mountains on the rocky planets, measured from base to
      // peak, as ranked by Wikipedia's "List of tallest mountains in the Solar
      // System". Mauna Kea is measured from the ocean floor. Everest uses its
      // height above sea level, as on the other challenges.
      peaks: [
        { name: "Everest",        region: "Earth", height: 8849 },
        { name: "Mauna Kea",      region: "Earth", height: 10200 },
        { name: "Maxwell Montes", region: "Venus", height: 10700, short: "Maxwell" },
        { name: "Arsia Mons",     region: "Mars",  height: 11700, short: "Arsia" },
        { name: "Elysium Mons",   region: "Mars",  height: 12600, short: "Elysium" },
        { name: "Ascraeus Mons",  region: "Mars",  height: 15000, short: "Ascraeus" },
        { name: "Olympus Mons",   region: "Mars",  height: 22000, short: "Olympus" },
      ],
    },
    {
      id: 1,
      slug: "seven-summits",
      name: "Seven Summits",
      // For Oceania this uses Puncak Jaya, the mountaineers' usual choice.
      peaks: [
        { name: "Puncak Jaya", region: "Oceania",       height: 4884 },
        { name: "Vinson",      region: "Antarctica",    height: 4892 },
        { name: "Elbrus",      region: "Europe",        height: 5642 },
        { name: "Kilimanjaro", region: "Africa",        height: 5895 },
        { name: "Denali",      region: "North America", height: 6190 },
        { name: "Aconcagua",   region: "South America", height: 6961 },
        { name: "Everest",     region: "Asia",          height: 8849 },
      ],
    },
  ],
};
