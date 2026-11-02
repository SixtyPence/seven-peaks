// Turns a GPX file into a small, privacy-friendly line for the map.
// All of this runs in the participant's browser. The original file never leaves
// their device, so times, heart rate and other details are never uploaded.

window.PeaksGpx = (function () {
  const MAX_POINTS = 300;       // plenty for a map line, and only about 6 KB
  const CLIMB_STEP_METERS = 5;  // height changes smaller than this count as GPS noise

  // A GPX file is XML: <trkpt lat="47.4" lon="10.9"><ele>2962</ele></trkpt>
  // We use the browser's XML parser, which reads data and never runs code.
  function parse(text) {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.querySelector("parsererror")) {
      throw new Error("This file isn't a valid GPX file. Export the activity as GPX and try again.");
    }
    let nodes = [...doc.getElementsByTagName("trkpt")];
    if (nodes.length === 0) nodes = [...doc.getElementsByTagName("rtept")]; // planned routes
    const points = nodes
      .map((node) => {
        const ele = node.getElementsByTagName("ele")[0];
        return {
          lat: parseFloat(node.getAttribute("lat")),
          lng: parseFloat(node.getAttribute("lon")),
          ele: ele ? parseFloat(ele.textContent) : null,
        };
      })
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    if (points.length < 2) {
      throw new Error("This file has no track points. Export the activity as GPX and try again.");
    }
    return points;
  }

  // GPS height wobbles constantly, so adding up every tiny rise overstates the
  // climb. Instead we only count a rise once it clears a threshold ("hysteresis").
  function elevationGain(points) {
    let gain = 0;
    let reference = null;
    for (const p of points) {
      if (p.ele === null || !Number.isFinite(p.ele)) continue;
      if (reference === null) { reference = p.ele; continue; }
      const change = p.ele - reference;
      if (change >= CLIMB_STEP_METERS) { gain += change; reference = p.ele; }
      else if (change <= -CLIMB_STEP_METERS) { reference = p.ele; }
    }
    return Math.round(gain);
  }

  // Ramer-Douglas-Peucker: keep the two ends, find the point furthest from the
  // straight line between them, keep it if it's further than the tolerance, and
  // repeat on both halves. Corners survive and straight stretches disappear.
  function simplifyWithTolerance(points, tolerance) {
    const midLat = (points[0].lat * Math.PI) / 180;
    const x = (p) => p.lng * 111320 * Math.cos(midLat); // degrees to approximate meters
    const y = (p) => p.lat * 110540;

    const keep = new Uint8Array(points.length);
    keep[0] = keep[points.length - 1] = 1;
    const stack = [[0, points.length - 1]]; // a stack instead of recursion, so long tracks can't overflow

    while (stack.length) {
      const [first, last] = stack.pop();
      const ax = x(points[first]), ay = y(points[first]);
      const dx = x(points[last]) - ax, dy = y(points[last]) - ay;
      const lengthSquared = dx * dx + dy * dy;
      let furthest = -1, furthestDistance = tolerance;

      for (let i = first + 1; i < last; i++) {
        const px = x(points[i]) - ax, py = y(points[i]) - ay;
        const t = lengthSquared ? Math.max(0, Math.min(1, (px * dx + py * dy) / lengthSquared)) : 0;
        const d = Math.hypot(px - t * dx, py - t * dy);
        if (d > furthestDistance) { furthest = i; furthestDistance = d; }
      }
      if (furthest !== -1) {
        keep[furthest] = 1;
        stack.push([first, furthest], [furthest, last]);
      }
    }
    return points.filter((_, i) => keep[i]);
  }

  // Start with a fine tolerance and loosen it until the line is small enough.
  function simplify(points) {
    let tolerance = 3;
    let result = simplifyWithTolerance(points, tolerance);
    while (result.length > MAX_POINTS) {
      tolerance *= 1.5;
      result = simplifyWithTolerance(points, tolerance);
    }
    return result;
  }

  // The one function the page calls.
  function process(text) {
    const points = parse(text);
    const gain = elevationGain(points);
    const line = simplify(points).map((p) => [
      Math.round(p.lat * 1e5) / 1e5, // 5 decimals is about 1 meter, and keeps the data small
      Math.round(p.lng * 1e5) / 1e5,
    ]);
    return { line, gain, originalPoints: points.length };
  }

  return { process, parse, elevationGain, simplify };
})();
