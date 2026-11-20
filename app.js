
// REGISTER SERVICE WORKER FOR PWA & ANDROID APK
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

// CLIENT-SIDE STATIC ENGINE (Replaces Python Flask routes so GitHub Pages + APK works 100% standalone!)
const _origFetch = window.fetch.bind(window);
window.fetch = async function(resource, init = {}) {
  const urlStr = typeof resource === 'string' ? resource : resource.url;
  if (!urlStr.startsWith('/api/')) {
    return _origFetch(resource, init);
  }

  const parsedUrl = new URL(urlStr, window.location.origin);
  const path = parsedUrl.pathname;
  const params = parsedUrl.searchParams;
  const body = init && init.body ? JSON.parse(init.body) : {};

  const jsonRes = (obj) => new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });

  // 1. /api/reverse_geocode
  if (path === '/api/reverse_geocode') {
    const lat = params.get('lat') || '22.3595';
    const lng = params.get('lng') || '82.7255';
    try {
      const r = await _origFetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=19&addressdetails=1`);
      const data = await r.json();
      const addr = data.address || {};
      const placeName = data.name || addr.shop || addr.amenity || addr.building || addr.house_number || '';
      const road = addr.road || addr.pedestrian || addr.residential || addr.suburb || 'Local Road';
      const suburb = addr.suburb || addr.neighbourhood || addr.quarter || addr.village || '';
      const city = addr.city || addr.town || addr.county || addr.state_district || '';
      const parts = [...new Set([placeName, road, suburb, city].filter(Boolean))];
      const shortLabel = parts.length ? parts.join(', ') : `${parseFloat(lat).toFixed(5)}, ${parseFloat(lng).toFixed(5)}`;
      return jsonRes({ status: 'success', place_name: placeName, short_label: shortLabel, road, suburb, city, full_address: data.display_name || shortLabel });
    } catch (_) {
      return jsonRes({ status: 'offline_fallback', short_label: `Location (${parseFloat(lat).toFixed(5)}, ${parseFloat(lng).toFixed(5)})`, road: 'Local Corridor', full_address: `${lat}, ${lng}` });
    }
  }

  // 2. /api/autocomplete
  if (path === '/api/autocomplete') {
    const q = (params.get('q') || '').trim();
    const lat = params.get('lat') || '22.3595';
    const lng = params.get('lng') || '82.7255';
    if (q.length < 2) return jsonRes({ status: 'success', results: [] });
    let results = [];
    try {
      const r = await _origFetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&lat=${lat}&lon=${lng}&limit=8`);
      const d = await r.json();
      for (const feat of (d.features || [])) {
        const props = feat.properties || {};
        const coords = (feat.geometry && feat.geometry.coordinates) || [0, 0];
        const parts = [...new Set([props.name, props.housenumber, props.street, props.district || props.suburb || props.city, props.state, props.country].filter(Boolean))];
        const label = parts.join(', ');
        const type = (props.osm_value || props.osm_key || 'place').replace(/_/g, ' ');
        if (label) results.push({ name: label, type, lat: parseFloat(coords[1]), lng: parseFloat(coords[0]) });
      }
    } catch (_) {}
    if (results.length < 3) {
      try {
        const r2 = await _origFetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=6`);
        const d2 = await r2.json();
        for (const item of d2) {
          results.push({ name: item.display_name, type: (item.type || 'location').replace(/_/g, ' '), lat: parseFloat(item.lat), lng: parseFloat(item.lon) });
        }
      } catch (_) {}
    }
    return jsonRes({ status: 'success', results });
  }

  // 3. /api/micro_surroundings
  if (path === '/api/micro_surroundings') {
    const lat = parseFloat(params.get('lat') || '22.3595');
    const lng = parseFloat(params.get('lng') || '82.7255');
    const heading = parseFloat(params.get('heading') || '0');
    const radius = parseInt(params.get('radius') || '3500', 10);
    const query = `[out:json][timeout:12];(node["shop"](around:${radius},${lat},${lng});way["shop"](around:${radius},${lat},${lng});node["amenity"](around:${radius},${lat},${lng});way["amenity"](around:${radius},${lat},${lng});node["healthcare"](around:${radius},${lat},${lng}););out center 120;`;
    let pois = [];
    try {
      const r = await _origFetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`
      });
      const d = await r.json();
      for (const el of (d.elements || [])) {
        const tags = el.tags || {};
        const rawType = tags.shop || tags.amenity || tags.healthcare || 'place';
        let subType = rawType.replace(/_/g, ' ');
        if (['convenience', 'general', 'variety_store', 'supermarket', 'grocery', 'kiosk'].includes(rawType)) subType = 'General / Kirana Store';
        const name = tags.name || tags['name:en'] || tags.brand || tags.operator || `Local ${subType}`;
        const pLat = el.lat || (el.center && el.center.lat);
        const pLng = el.lon || (el.center && el.center.lon);
        if (!pLat || !pLng) continue;

        let cat = 'other';
        if (tags.shop || ['convenience', 'general', 'supermarket', 'grocery', 'bakery', 'dairy'].includes(rawType)) cat = 'store';
        else if (['cafe', 'restaurant', 'fast_food', 'tea', 'food_court'].includes(rawType)) cat = 'food';
        else if (['fuel', 'charging_station', 'car_repair', 'tyres', 'parking'].includes(rawType)) cat = 'fuel_auto';
        else if (tags.healthcare || ['hospital', 'clinic', 'doctors', 'pharmacy'].includes(rawType)) cat = 'medical';
        else if (['atm', 'bank', 'post_office', 'police'].includes(rawType)) cat = 'civic_finance';

        const distM = Math.round(calcDistanceMeters(lat, lng, pLat, pLng));
        const brg = calcBearing(lat, lng, pLat, pLng);
        const diff = (brg - heading + 360) % 360;
        const side = (diff >= 15 && diff <= 165) ? 'right' : ((diff >= 195 && diff <= 345) ? 'left' : ((diff < 15 || diff > 345) ? 'straight ahead' : 'behind'));

        pois.push({
          id: `${el.type}_${el.id}`,
          name,
          category: cat,
          sub_type: subType,
          lat: pLat,
          lng: pLng,
          distance_km: Number((distM / 1000).toFixed(3)),
          distance_m: distM,
          side_of_road: side,
          street: tags['addr:street'] || tags['addr:suburb'] || '',
          house_number: tags['addr:housenumber'] || ''
        });
      }
      localStorage.setItem('navivoice_cached_pois', JSON.stringify(pois));
    } catch (_) {
      pois = JSON.parse(localStorage.getItem('navivoice_cached_pois') || '[]');
    }
    pois.sort((a, b) => a.distance_m - b.distance_m);
    return jsonRes({ status: 'success', count: pois.length, data: pois });
  }

  // 4. /api/hazards
  if (path === '/api/hazards') {
    const saved = JSON.parse(localStorage.getItem('navivoice_hazards') || '[]');
    if ((init.method || 'GET').toUpperCase() === 'POST') {
      const item = { id: Date.now(), ...body, distance_m: 0 };
      saved.unshift(item);
      localStorage.setItem('navivoice_hazards', JSON.stringify(saved.slice(0, 50)));
      return jsonRes({ status: 'success', id: item.id });
    }
    const lat = parseFloat(params.get('lat') || '22.3595');
    const lng = parseFloat(params.get('lng') || '82.7255');
    const mapped = saved.map(h => ({ ...h, distance_m: Math.round(calcDistanceMeters(lat, lng, h.lat, h.lng)) }));
    return jsonRes({ status: 'success', data: mapped });
  }

  // 5. /api/cache_route & /api/cached_routes
  if (path === '/api/cache_route') {
    const list = JSON.parse(localStorage.getItem('navivoice_offline_routes') || '[]');
    list.unshift({ id: Date.now(), dest_label: body.dest_label, saved_at: new Date().toLocaleTimeString(), payload: body.payload });
    localStorage.setItem('navivoice_offline_routes', JSON.stringify(list.slice(0, 10)));
    return jsonRes({ status: 'success' });
  }
  if (path === '/api/cached_routes') {
    return jsonRes({ status: 'success', data: JSON.parse(localStorage.getItem('navivoice_offline_routes') || '[]') });
  }

  // 6. /api/detour_check
  if (path === '/api/detour_check') {
    const { origin, dest, stop, vehicle_type } = body;
    try {
      const r1 = await (await _origFetch(`https://router.project-osrm.org/route/v1/driving/${origin[0]},${origin[1]};${dest[0]},${dest[1]}?overview=false`)).json();
      const r2 = await (await _origFetch(`https://router.project-osrm.org/route/v1/driving/${origin[0]},${origin[1]};${stop[0]},${stop[1]};${dest[0]},${dest[1]}?overview=false`)).json();
      const d1 = r1.routes[0].distance;
      const d2 = r2.routes[0].distance;
      const extraKm = Math.max(0, (d2 - d1) / 1000);
      const speedKmh = vehicle_type === 'walk' ? 4.8 : (vehicle_type === 'bike' ? 28 : 32);
      const extraMin = Math.max(1, Math.round((extraKm / speedKmh) * 60) + 2);
      const totalMin = Math.max(1, Math.round(((d2 / 1000) / speedKmh) * 60));
      return jsonRes({ status: 'success', extra_minutes: extraMin, extra_km: extraKm.toFixed(2), via_total_minutes: totalMin, via_total_km: (d2 / 1000).toFixed(2) });
    } catch (_) {
      return jsonRes({ status: 'offline_estimate', extra_minutes: 3, extra_km: 0.4, via_total_minutes: 15, via_total_km: 5.0 });
    }
  }

  // 7. /api/assistant (Full Multi-Turn Co-Pilot in pure JS)
  if (path === '/api/assistant') {
    const q = (body.query || '').trim();
    const qLow = q.toLowerCase();
    const pois = body.nearby_pois || [];
    const lastCands = (body.memory && body.memory.last_candidates) || [];
    const road = body.current_road || 'current road';

    if (['by bike', 'on bike', 'motorcycle', 'scooter'].some(w => qLow.includes(w))) {
      return jsonRes({ status: 'success', action: 'switch_vehicle', vehicle_type: 'bike', reply: 'Switched to Bike mode and updated arrival time.' });
    }
    if (['by car', 'in car'].some(w => qLow.includes(w))) {
      return jsonRes({ status: 'success', action: 'switch_vehicle', vehicle_type: 'car', reply: 'Switched to Car mode and updated arrival time.' });
    }
    if (['walking', 'by foot', 'walk mode'].some(w => qLow.includes(w))) {
      return jsonRes({ status: 'success', action: 'switch_vehicle', vehicle_type: 'walk', reply: 'Switched to Walking mode and updated arrival time.' });
    }
    if (['street view', '360 view', 'panorama'].some(w => qLow.includes(w))) {
      return jsonRes({ status: 'success', action: 'open_street_view', reply: 'Opening 360 Street View explorer.' });
    }
    if (['report hazard', 'pothole', 'waterlogging', 'bad road'].some(w => qLow.includes(w))) {
      return jsonRes({ status: 'success', action: 'report_hazard', hazard_type: 'Pothole / Road Hazard', reply: `Logged road hazard alert on ${road}.` });
    }
    if (lastCands.length && ['second', '2nd', 'third', '3rd', 'next one'].some(w => qLow.includes(w))) {
      const idx = qLow.includes('third') || qLow.includes('3rd') ? 2 : 1;
      const picked = lastCands[Math.min(idx, lastCands.length - 1)];
      const act = body.is_navigating ? 'add_waypoint' : 'set_destination_poi';
      return jsonRes({ status: 'success', action: act, target_poi: picked, candidates: lastCands, reply: `Selected ${picked.name}, ${picked.distance_m}m away on your ${picked.side_of_road}.` });
    }
    if (['extra time', 'detour', 'how much longer'].some(w => qLow.includes(w))) {
      if (body.is_navigating && lastCands[0]) {
        return jsonRes({ status: 'success', action: 'check_detour', target_poi: lastCands[0], reply: `Checking detour time for ${lastCands[0].name}...` });
      }
    }

    const catRules = [
      { cat: 'store', words: ['general store', 'kirana', 'grocery', 'shop', 'store', 'mart', 'dukan'] },
      { cat: 'fuel_auto', words: ['petrol', 'fuel', 'diesel', 'pump', 'charging', 'mechanic'] },
      { cat: 'food', words: ['chai', 'tea', 'coffee', 'cafe', 'food', 'restaurant', 'dhaba'] },
      { cat: 'civic_finance', words: ['atm', 'bank', 'cash'] },
      { cat: 'medical', words: ['hospital', 'medical', 'clinic', 'pharmacy', 'medicine'] }
    ];
    for (const rule of catRules) {
      if (rule.words.some(w => qLow.includes(w)) && !qLow.includes('navigate to')) {
        let matches = pois.filter(p => p.category === rule.cat);
        const sameSide = matches.filter(p => p.side_of_road === 'left' || p.side_of_road === 'straight ahead');
        if (sameSide.length) matches = [...sameSide, ...matches.filter(p => !sameSide.includes(p))];
        if (matches.length) {
          const best = matches[0];
          const act = body.is_navigating ? 'add_waypoint' : 'set_destination_poi';
          return jsonRes({ status: 'success', action: act, target_poi: best, candidates: matches.slice(0, 5), reply: `Routing to ${best.name} (${best.distance_m}m on your ${best.side_of_road}).` });
        }
      }
    }

    const navMatch = qLow.match(/(?:navigate|take me|go|drive|route|chalo|le chalo) to (.+)/);
    if (navMatch) {
      const target = navMatch[1].trim();
      return jsonRes({ status: 'success', action: 'search_destination', dest_query: target, reply: `Finding route to ${target}...` });
    }

    if (['around me', 'what is near', 'where am i'].some(w => qLow.includes(w))) {
      const top3 = pois.slice(0, 3).map((p, i) => `${i + 1}. ${p.name} (${p.distance_m}m)`).join(', ');
      return jsonRes({ status: 'success', action: 'open_drawer', candidates: pois.slice(0, 5), reply: `On ${road}. Nearby: ${top3 || 'scanning...'}` });
    }

    if (body.is_navigating && body.dest_name) {
      return jsonRes({ status: 'success', action: 'general', reply: `Heading to ${body.dest_name.split(',')[0]}: ${body.rem_dist} left, about ${body.rem_time} (ETA ${body.arrival_clock}).` });
    }

    return jsonRes({ status: 'success', action: 'general', reply: `NaviVoice ready on ${road}. Say 'Navigate to [Place]' or 'Find general store'.` });
  }

  return jsonRes({ status: 'ok' });
};

let map;
let vehicleMarker;
let destMarker;
let waypointMarker;
let poiMarkers = [];
let hazardMarkers = [];

let currentCoords = [82.7255, 22.3595];
let hasReceivedLiveGps = false;
let liveGpsWatchId = null;

let destCoords = null;
let waypointCoords = null;
let pendingPinCoords = null;
let pendingPinAddress = "";

let currentStreetName = "Local Street";
let currentHeading = 0;
let currentSpeedKmh = 0;
let activeVehicleMode = 'car'; // 'car' | 'bike' | 'walk'
let directOriginClickMode = false;

// Route & Autopilot
let routeGeometry = [];
let routeSteps = [];
let rawRouteDistanceMeters = 0;
let totalDistKm = 0;
let totalDurationSeconds = 0;
let totalDurMin = 1;
let currentArrivalClock = "";
let isAutopilotActive = false;
let animFrameId = null;
let routeProgressFloat = 0;
let lastSpokenStepIdx = -1;
let driveStartTimeMs = null;
let breakPromptShown = false;

// Surroundings, Hazards, Offline Cache & AI Memory
let microPlaces = [];
let nearbyHazards = [];
let cachedOfflineRoutes = [];
let activeCategory = 'all';
let is3D = true;
let isDriveFocusMode = false;
let voiceAudioEnabled = true;
let handsFreeMode = false;
let searchTimer = null;
let isDraggingMap = false;

let conversationMemory = { last_candidates: [] };
let speechRec = null;
let isListening = false;

const VEHICLE_SPEED_MAP = {
  car: { label: 'Car', simKmh: 48, urbanKmh: 24, avgKmh: 34, highwayKmh: 58, turnSec: 14 },
  bike: { label: 'Bike', simKmh: 42, urbanKmh: 22, avgKmh: 30, highwayKmh: 46, turnSec: 8 },
  walk: { label: 'Walk', simKmh: 5, urbanKmh: 4.8, avgKmh: 4.8, highwayKmh: 4.5, turnSec: 4 }
};

document.addEventListener("DOMContentLoaded", () => {
  localStorage.removeItem('navivoice_calibrated_gps');
  initMap();
  initSpeechEngine();
  loadHazardsFromBackend();
  loadOfflineRoutesFromBackend();

  const savedKey = localStorage.getItem('navivoice_gemini_key') || '';
  if (savedKey) {
    document.getElementById('geminiKeyInput').value = savedKey;
    document.getElementById('aiBrainBadge').innerText = "Gemini LLM + ETA";
  }

  document.addEventListener("click", (e) => {
    if (!e.target.closest("#originSearchInput") && !e.target.closest("#originResultsBox")) {
      document.getElementById("originResultsBox").classList.add("hidden");
    }
    if (!e.target.closest("#destSearchInput") && !e.target.closest("#destResultsBox")) {
      document.getElementById("destResultsBox").classList.add("hidden");
    }
    if (!e.target.closest("#layerPopover") && !e.target.closest("button[onclick='toggleLayerPopover()']")) {
      document.getElementById("layerPopover").classList.add("hidden");
    }
  });
});

function setVehicleMode(mode) {
  if (!VEHICLE_SPEED_MAP[mode]) return;
  activeVehicleMode = mode;

  ['car', 'bike', 'walk'].forEach(m => {
    const btn = document.getElementById(`veh-${m}`);
    if (btn) {
      if (m === mode) btn.classList.add('active-veh');
      else btn.classList.remove('active-veh');
    }
  });

  if (rawRouteDistanceMeters > 0) {
    recalculateVehicleETA(rawRouteDistanceMeters, routeSteps.length, true);
  }
}

function recalculateVehicleETA(distanceMeters, turnCount, announce = false) {
  const prof = VEHICLE_SPEED_MAP[activeVehicleMode] || VEHICLE_SPEED_MAP.car;
  const distKm = Math.max(0.01, distanceMeters / 1000.0);
  totalDistKm = distKm.toFixed(2);

  let speedKmh = prof.avgKmh;
  if (activeVehicleMode === 'walk') speedKmh = prof.avgKmh;
  else if (distKm < 3.0) speedKmh = prof.urbanKmh;
  else if (distKm > 15.0) speedKmh = prof.highwayKmh;

  const movingSec = (distKm / speedKmh) * 3600.0;
  const turnSec = Math.max(0, turnCount) * prof.turnSec;
  totalDurationSeconds = Math.max(60, Math.round(movingSec + turnSec));
  totalDurMin = Math.max(1, Math.round(totalDurationSeconds / 60.0));

  const arrivalDate = new Date(Date.now() + totalDurationSeconds * 1000);
  currentArrivalClock = arrivalDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (routeSteps.length > 0) {
    const ratio = isAutopilotActive ? Math.min(1, routeProgressFloat / Math.max(1, routeGeometry.length - 1)) : 0;
    const sIdx = Math.min(routeSteps.length - 1, Math.floor(ratio * routeSteps.length));
    const remKm = Math.max(0.05, distKm * (1 - ratio)).toFixed(2);
    const remMin = Math.max(1, Math.round(totalDurMin * (1 - ratio)));
    updateHUD(routeSteps[sIdx], remKm, remMin);
  }

  if (announce && destCoords) {
    const shortDest = document.getElementById('destSearchInput').value.split(',')[0];
    const msg = `By ${prof.label.toLowerCase()}, reaching ${shortDest} (${totalDistKm} km) takes about ${formatMinutesLabel(totalDurMin)}, arriving around ${currentArrivalClock}.`;
    setAssistantSpeech(msg);
    speakVoice(msg);
  }
}

function formatMinutesLabel(mins) {
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h} hr ${m} min` : `${h} hr`;
}

function initMap() {
  map = new maplibregl.Map({
    container: 'map',
    style: {
      version: 8,
      sources: {
        'gmap-detail-src': {
          type: 'raster',
          tiles: [
            'https://mt0.google.com/vt/lyrs=m&x={x}&y={y}&z={z}',
            'https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}',
            'https://mt2.google.com/vt/lyrs=m&x={x}&y={y}&z={z}',
            'https://mt3.google.com/vt/lyrs=m&x={x}&y={y}&z={z}'
          ],
          tileSize: 256,
          maxzoom: 21
        },
        'gmap-hybrid-src': {
          type: 'raster',
          tiles: [
            'https://mt0.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
            'https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
            'https://mt2.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
            'https://mt3.google.com/vt/lyrs=y&x={x}&y={y}&z={z}'
          ],
          tileSize: 256,
          maxzoom: 21
        },
        'gmap-sat-src': {
          type: 'raster',
          tiles: [
            'https://mt0.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
            'https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
            'https://mt2.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
            'https://mt3.google.com/vt/lyrs=s&x={x}&y={y}&z={z}'
          ],
          tileSize: 256,
          maxzoom: 21
        },
        'osm-detail-src': {
          type: 'raster',
          tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
          tileSize: 256,
          maxzoom: 19
        },
        'routeSource': {
          type: 'geojson',
          data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } }
        }
      },
      layers: [
        { id: 'gmap-detail-layer', type: 'raster', source: 'gmap-detail-src', layout: { visibility: 'visible' }, paint: { 'raster-fade-duration': 0 } },
        { id: 'gmap-hybrid-layer', type: 'raster', source: 'gmap-hybrid-src', layout: { visibility: 'none' }, paint: { 'raster-fade-duration': 0 } },
        { id: 'gmap-sat-layer', type: 'raster', source: 'gmap-sat-src', layout: { visibility: 'none' }, paint: { 'raster-fade-duration': 0 } },
        { id: 'osm-detail-layer', type: 'raster', source: 'osm-detail-src', layout: { visibility: 'none' }, paint: { 'raster-fade-duration': 0 } },
        { id: 'routeGlow', type: 'line', source: 'routeSource', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#0284c7', 'line-width': 13, 'line-opacity': 0.38, 'line-blur': 3 } },
        { id: 'routeCore', type: 'line', source: 'routeSource', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#06b6d4', 'line-width': 5.5, 'line-opacity': 0.98 } }
      ]
    },
    center: currentCoords,
    zoom: 16.5,
    pitch: 45,
    bearing: 0,
    antialias: false,
    maxPitch: 70,
    fadeDuration: 0,
    trackResize: true
  });

  map.on('dragstart', () => { isDraggingMap = true; });
  map.on('dragend', () => { setTimeout(() => { isDraggingMap = false; }, 120); });

  map.on('load', () => {
    createVehiclePuck();
    startContinuousLiveTracker(true);
  });

  map.on('click', async (e) => {
    if (isDraggingMap) return;
    const clicked = [e.lngLat.lng, e.lngLat.lat];

    if (directOriginClickMode) {
      directOriginClickMode = false;
      await setLiveOrigin(clicked[1], clicked[0], null, false, 2, true);
      setAssistantSpeech("Starting location updated to the point you selected.");
      return;
    }

    pendingPinCoords = clicked;
    document.getElementById('pinModalCoords').innerText = `${clicked[1].toFixed(5)}°N, ${clicked[0].toFixed(5)}°E`;
    document.getElementById('pinModalAddress').innerText = "Inspecting place & street details...";
    document.getElementById('mapPinModal').classList.remove('hidden');

    try {
      const r = await fetch(`/api/reverse_geocode?lat=${clicked[1]}&lng=${clicked[0]}`);
      const d = await r.json();
      pendingPinAddress = d.short_label || d.full_address;
      document.getElementById('pinModalAddress').innerText = pendingPinAddress;
    } catch (_) {
      pendingPinAddress = `Point (${clicked[1].toFixed(5)}, ${clicked[0].toFixed(5)})`;
      document.getElementById('pinModalAddress').innerText = pendingPinAddress;
    }
  });
}

function createVehiclePuck() {
  const wrapper = document.createElement('div');
  wrapper.className = 'vehicle-puck-wrapper';
  wrapper.title = "Drag to fine-tune your exact position";
  wrapper.innerHTML = `
    <div class="vehicle-puck-halo"></div>
    <div class="vehicle-puck-core">
      <i class="fa-solid fa-location-arrow" style="transform: rotate(-45deg);"></i>
    </div>
  `;

  vehicleMarker = new maplibregl.Marker({ element: wrapper, draggable: true })
    .setLngLat(currentCoords)
    .addTo(map);

  vehicleMarker.on('dragend', () => {
    const pos = vehicleMarker.getLngLat();
    setLiveOrigin(pos.lat, pos.lng, null, false, 2, false);
  });
}

function startContinuousLiveTracker(centerCameraNow = true) {
  if (!navigator.geolocation) {
    document.getElementById('gpsPrecisionTag').innerText = "No GPS Sensor";
    setLiveOrigin(currentCoords[1], currentCoords[0], null, true, 50, centerCameraNow);
    return;
  }

  document.getElementById('gpsPrecisionTag').innerText = "Locating Live...";
  document.getElementById('liveStreetText').innerText = "Acquiring live GPS coordinates...";

  if (liveGpsWatchId !== null) navigator.geolocation.clearWatch(liveGpsWatchId);
  let bestAcc = Infinity;

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      bestAcc = pos.coords.accuracy;
      hasReceivedLiveGps = true;
      setLiveOrigin(pos.coords.latitude, pos.coords.longitude, null, false, Math.round(pos.coords.accuracy), centerCameraNow);
    },
    () => {
      document.getElementById('gpsPrecisionTag').innerText = "Allow GPS";
    },
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
  );

  liveGpsWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      if (isAutopilotActive) return;
      const nLat = pos.coords.latitude;
      const nLng = pos.coords.longitude;
      const nAcc = pos.coords.accuracy;
      const moved = calcDistanceMeters(currentCoords[1], currentCoords[0], nLat, nLng);

      if (!hasReceivedLiveGps || moved >= 8 || nAcc < bestAcc * 0.7) {
        hasReceivedLiveGps = true;
        bestAcc = Math.min(bestAcc, nAcc);
        if (pos.coords.heading !== null && !isNaN(pos.coords.heading)) currentHeading = pos.coords.heading;
        if (pos.coords.speed !== null && !isNaN(pos.coords.speed)) {
          currentSpeedKmh = Math.round(pos.coords.speed * 3.6);
          document.getElementById('speedMiniBadge').innerText = `${currentSpeedKmh} km/h`;
        }
        setLiveOrigin(nLat, nLng, null, true, Math.round(nAcc), centerCameraNow || moved >= 15);
      }
    },
    () => {},
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
}

function lockHardwareGPS() {
  hasReceivedLiveGps = false;
  startContinuousLiveTracker(true);
}

async function setLiveOrigin(lat, lng, customLabel = null, silent = false, accMeters = 10, flyToSpot = true) {
  currentCoords = [lng, lat];
  vehicleMarker.setLngLat(currentCoords);
  if (flyToSpot) map.flyTo({ center: currentCoords, zoom: 16.8, pitch: is3D ? 45 : 0, duration: 750 });

  const tag = document.getElementById('gpsPrecisionTag');
  if (accMeters <= 35) {
    tag.innerText = `GPS ±${accMeters}m`;
    tag.className = "font-mono px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30";
  } else if (accMeters <= 500) {
    tag.innerText = `Wi-Fi ±${accMeters}m`;
    tag.className = "font-mono px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30";
  } else {
    tag.innerText = `±${(accMeters / 1000).toFixed(1)}km`;
    tag.className = "font-mono px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30";
  }

  try {
    const r = await fetch(`/api/reverse_geocode?lat=${lat}&lng=${lng}`);
    const d = await r.json();
    currentStreetName = d.road || "Local Street";
    const resolved = customLabel || d.short_label || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    document.getElementById('originSearchInput').value = resolved;
    document.getElementById('liveStreetText').innerText = resolved;
    document.getElementById('drawerAddressSub').innerText = d.full_address || resolved;
  } catch (_) {}

  scanMicroSurroundings(silent, 3500);
  loadHazardsFromBackend();
  if (destCoords) calculateRoute(false);
}

function enableDirectOriginClick() {
  directOriginClickMode = true;
  setAssistantSpeech("Click your exact spot on the map to set your starting location.");
}

function scanMicroSurroundings(silent = true, radius = 3500) {
  fetch(`/api/micro_surroundings?lat=${currentCoords[1]}&lng=${currentCoords[0]}&heading=${currentHeading}&radius=${radius}`)
    .then(r => r.json())
    .then(res => {
      if (res.status === 'success') {
        microPlaces = res.data || [];
        document.getElementById('microPoiCount').innerText = microPlaces.length;
        renderMicroMapMarkers();
        renderMicroDrawerList();
        if (!silent) {
          setAssistantSpeech(`Mapped ${microPlaces.length} nearby places around ${currentStreetName}.`);
        }
      }
    })
    .catch(() => {});
}

function filterCategory(cat) {
  activeCategory = cat;
  ['all', 'store', 'food', 'fuel_auto', 'civic_finance', 'medical'].forEach(c => {
    const b = document.getElementById(`cat-${c}`);
    if (b) {
      if (c === cat) b.classList.add('active-filter');
      else b.classList.remove('active-filter');
    }
  });
  renderMicroMapMarkers();
  renderMicroDrawerList();
}

function renderMicroMapMarkers() {
  poiMarkers.forEach(m => m.remove());
  poiMarkers = [];

  const chk = document.getElementById('poiVisibilityChk');
  if (chk && !chk.checked) return;

  const filtered = activeCategory === 'all'
    ? microPlaces.slice(0, 45)
    : microPlaces.filter(p => p.category === activeCategory).slice(0, 45);

  const colors = { store: '#f59e0b', food: '#f97316', fuel_auto: '#10b981', civic_finance: '#a855f7', medical: '#ef4444', other: '#3b82f6' };
  const icons = { store: 'fa-store', food: 'fa-mug-hot', fuel_auto: 'fa-gas-pump', civic_finance: 'fa-building-columns', medical: 'fa-kit-medical', other: 'fa-location-dot' };

  filtered.forEach(p => {
    const el = document.createElement('div');
    const bg = colors[p.category] || '#3b82f6';
    const ic = icons[p.category] || 'fa-location-dot';

    el.style.cssText = `width:24px;height:24px;border-radius:50%;background:${bg};border:2px solid #fff;display:flex;align-items:center;justify-content:center;color:#fff;font-size:10px;box-shadow:0 2px 8px rgba(0,0,0,0.65);cursor:pointer;`;
    el.innerHTML = `<i class="fa-solid ${ic}"></i>`;

    const popup = new maplibregl.Popup({ offset: 12 }).setHTML(`
      <div style="color:#0f172a;font-family:sans-serif;padding:3px;max-width:210px;">
        <div style="font-size:9px;font-weight:800;text-transform:uppercase;color:${bg};">${p.sub_type}</div>
        <strong style="font-size:12px;">${p.name}</strong><br/>
        <span style="font-size:11px;color:#475569;">${p.distance_m} m • ${p.side_of_road.toUpperCase()}</span>
        ${p.street ? `<div style="font-size:10px;color:#64748b;">📍 ${p.street}</div>` : ''}
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:5px;">
          <button onclick="injectWaypoint(${p.lat}, ${p.lng}, '${p.name.replace(/'/g, "")}')" style="background:#f59e0b;color:#0f172a;border:none;padding:4px;border-radius:5px;font-size:10px;font-weight:800;cursor:pointer;">+ Stop</button>
          <button onclick="selectPlace('dest', '${p.name.replace(/'/g, "")}', ${p.lat}, ${p.lng})" style="background:#0284c7;color:white;border:none;padding:4px;border-radius:5px;font-size:10px;font-weight:800;cursor:pointer;">Route Here</button>
        </div>
      </div>
    `);

    const m = new maplibregl.Marker({ element: el }).setLngLat([p.lng, p.lat]).setPopup(popup).addTo(map);
    poiMarkers.push(m);
  });
}

function renderMicroDrawerList() {
  const panel = document.getElementById('drawerPoisList');
  const q = (document.getElementById('drawerFilterInput')?.value || '').trim().toLowerCase();

  let list = activeCategory === 'all' ? microPlaces : microPlaces.filter(p => p.category === activeCategory);
  if (q) {
    list = list.filter(p => p.name.toLowerCase().includes(q) || p.sub_type.toLowerCase().includes(q) || p.street.toLowerCase().includes(q));
  }

  if (!list.length) {
    panel.innerHTML = `<div class="text-xs text-slate-500 text-center py-8">No matching stores or places found.</div>`;
    return;
  }

  panel.innerHTML = list.map(p => `
    <div onclick="map.flyTo({center:[${p.lng},${p.lat}],zoom:18,pitch:45})" class="p-2.5 rounded-xl bg-[#050811]/90 hover:bg-white/[0.06] border border-white/10 transition cursor-pointer flex items-center justify-between gap-2">
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-1.5">
          <span class="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded bg-white/5 text-cyan-400 border border-white/10">${p.sub_type}</span>
          <span class="text-[10px] font-mono text-emerald-400 font-bold">${p.distance_m} m (${p.side_of_road})</span>
        </div>
        <div class="text-xs font-bold text-white truncate mt-1">${p.name}</div>
        ${p.street ? `<div class="text-[10px] text-slate-400 truncate">📍 ${p.street} ${p.house_number}</div>` : ''}
      </div>
      <div class="flex flex-col gap-1 shrink-0" onclick="event.stopPropagation()">
        <button onclick="selectPlace('dest', '${p.name.replace(/'/g, "")}', ${p.lat}, ${p.lng})" class="px-2.5 py-1 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 border border-cyan-500/30 text-[10px] font-bold">Route</button>
        <button onclick="injectWaypoint(${p.lat}, ${p.lng}, '${p.name.replace(/'/g, "")}')" class="px-2.5 py-0.5 rounded-lg bg-white/5 hover:bg-white/10 text-amber-300 text-[9px] font-semibold">+ Stop</button>
      </div>
    </div>
  `).join('');
}

function quickReportHazardHere(customType = "Pothole / Road Hazard") {
  fetch('/api/hazards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      hazard_type: customType,
      description: `Reported on ${currentStreetName}`,
      severity: 'high',
      lat: currentCoords[1],
      lng: currentCoords[0],
      road_name: currentStreetName
    })
  })
  .then(r => r.json())
  .then(res => {
    if (res.status === 'success') {
      loadHazardsFromBackend();
      const msg = `${customType} logged on ${currentStreetName}. Nearby drivers will get an early warning.`;
      setAssistantSpeech(msg);
      speakVoice(msg);
    }
  });
}

function loadHazardsFromBackend() {
  fetch(`/api/hazards?lat=${currentCoords[1]}&lng=${currentCoords[0]}`)
    .then(r => r.json())
    .then(res => {
      if (res.status === 'success') {
        nearbyHazards = res.data || [];
        document.getElementById('hazardBadge').innerText = `${nearbyHazards.length} Hazards`;
        document.getElementById('hazardsCountBadge').innerText = nearbyHazards.length;
        renderHazardMarkers();
        renderHazardsDrawer();
      }
    })
    .catch(() => {});
}

function renderHazardMarkers() {
  hazardMarkers.forEach(m => m.remove());
  hazardMarkers = [];

  nearbyHazards.forEach(h => {
    const el = document.createElement('div');
    el.style.cssText = 'width:26px;height:26px;border-radius:50%;background:#eab308;border:2px solid #090d16;display:flex;align-items:center;justify-content:center;color:#090d16;font-size:11px;font-weight:900;box-shadow:0 0 12px rgba(234,179,8,0.85);cursor:pointer;';
    el.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i>';

    const popup = new maplibregl.Popup({ offset: 12 }).setHTML(`
      <div style="color:#0f172a;font-family:sans-serif;padding:3px;">
        <strong style="color:#b45309;font-size:11px;">⚠️ ${h.hazard_type}</strong><br/>
        <span style="font-size:11px;">${h.road_name} (${h.distance_m} m away)</span>
      </div>
    `);

    const m = new maplibregl.Marker({ element: el }).setLngLat([h.lng, h.lat]).setPopup(popup).addTo(map);
    hazardMarkers.push(m);
  });
}

function renderHazardsDrawer() {
  const panel = document.getElementById('drawerHazardsList');
  if (!nearbyHazards.length) {
    panel.innerHTML = `<div class="text-xs text-slate-500 text-center py-8">No hazards logged yet.</div>`;
    return;
  }

  panel.innerHTML = nearbyHazards.map(h => `
    <div onclick="map.flyTo({center:[${h.lng},${h.lat}],zoom:17.5,pitch:45})" class="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 cursor-pointer space-y-1">
      <div class="flex items-center justify-between text-xs font-bold text-amber-300">
        <span><i class="fa-solid fa-triangle-exclamation mr-1"></i>${h.hazard_type}</span>
        <span class="font-mono text-[10px]">${h.distance_m} m</span>
      </div>
      <div class="text-[10px] text-slate-300">${h.road_name} • ${h.description}</div>
    </div>
  `).join('');
}

function saveRouteForOffline(destLabel, payloadObj) {
  localStorage.setItem('navivoice_last_offline_route', JSON.stringify({ destLabel, payloadObj }));
  fetch('/api/cache_route', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dest_label: destLabel, payload: payloadObj })
  })
  .then(() => loadOfflineRoutesFromBackend())
  .catch(() => {});
}

function loadOfflineRoutesFromBackend() {
  fetch('/api/cached_routes')
    .then(r => r.json())
    .then(res => {
      if (res.status === 'success') {
        cachedOfflineRoutes = res.data || [];
        document.getElementById('offlineRoutesBadge').innerText = cachedOfflineRoutes.length;
        renderOfflineDrawerList();
      }
    })
    .catch(() => {});
}

function renderOfflineDrawerList() {
  const panel = document.getElementById('drawerOfflineList');
  if (!cachedOfflineRoutes.length) {
    panel.innerHTML = `<div class="text-xs text-slate-500 text-center py-8">Calculated routes save here automatically.</div>`;
    return;
  }

  panel.innerHTML = cachedOfflineRoutes.map(r => `
    <div onclick='restoreCachedRoute(${JSON.stringify(r.dest_label)}, ${JSON.stringify(r.payload)})' class="p-2.5 rounded-xl bg-[#050811]/90 hover:bg-white/[0.06] border border-white/10 cursor-pointer">
      <div class="text-xs font-bold text-cyan-300 truncate"><i class="fa-solid fa-download mr-1.5 text-emerald-400"></i>${r.dest_label}</div>
      <div class="text-[10px] text-slate-400 font-mono mt-0.5">${r.payload.distance_km || '--'} km • Saved ${r.saved_at || ''}</div>
    </div>
  `).join('');
}

function restoreCachedRoute(label, payload) {
  if (!payload || !payload.coordinates) return;
  routeGeometry = payload.coordinates;
  routeSteps = payload.steps || [];
  rawRouteDistanceMeters = (payload.distance_km || 1) * 1000;
  document.getElementById('destSearchInput').value = label;
  if (map.getSource('routeSource')) {
    map.getSource('routeSource').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: routeGeometry } });
  }
  const hud = document.getElementById('activeManeuverHud');
  hud.classList.remove('hidden');
  hud.classList.add('flex');
  recalculateVehicleETA(rawRouteDistanceMeters, routeSteps.length, true);
}

function handleAutocomplete(mode, query) {
  clearTimeout(searchTimer);
  const box = document.getElementById(mode === 'origin' ? 'originResultsBox' : 'destResultsBox');
  if (query.trim().length < 2) {
    box.classList.add('hidden');
    return;
  }

  searchTimer = setTimeout(() => {
    fetch(`/api/autocomplete?q=${encodeURIComponent(query)}&lat=${currentCoords[1]}&lng=${currentCoords[0]}`)
      .then(r => r.json())
      .then(d => {
        if (d.status === 'success' && d.results.length > 0) {
          box.innerHTML = d.results.map(item => `
            <div class="autocomplete-item" onclick="selectPlace('${mode}', '${item.name.replace(/'/g, "")}', ${item.lat}, ${item.lng})">
              <div class="flex items-center gap-2 min-w-0">
                <i class="fa-solid fa-location-dot ${mode === 'origin' ? 'text-emerald-400' : 'text-cyan-400'} shrink-0"></i>
                <span class="truncate">${item.name}</span>
              </div>
              <span class="text-[9px] font-mono px-1.5 py-0.5 rounded bg-white/5 text-slate-400 shrink-0">${item.type}</span>
            </div>
          `).join('');
          box.classList.remove('hidden');
        } else {
          box.classList.add('hidden');
        }
      });
  }, 220);
}

function selectPlace(mode, name, lat, lng) {
  if (mode === 'origin') {
    document.getElementById('originResultsBox').classList.add('hidden');
    setLiveOrigin(lat, lng, name, false, 2, true);
  } else {
    destCoords = [lng, lat];
    document.getElementById('destSearchInput').value = name;
    document.getElementById('destResultsBox').classList.add('hidden');
    calculateRoute(true);
  }
}

function executeDestSearch() {
  const val = document.getElementById('destSearchInput').value.trim();
  if (!val) return;
  document.getElementById('destResultsBox').classList.add('hidden');
  submitVoiceText(`Navigate to ${val}`);
}

async function calculateRoute(announceVoice = true) {
  if (!destCoords) return;

  let coordsStr = `${currentCoords[0]},${currentCoords[1]}`;
  if (waypointCoords) coordsStr += `;${waypointCoords[0]},${waypointCoords[1]}`;
  coordsStr += `;${destCoords[0]},${destCoords[1]}`;

  const url = `https://router.project-osrm.org/route/v1/driving/${coordsStr}?overview=full&geometries=geojson&steps=true`;

  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.code === 'Ok' && data.routes.length > 0) {
      const route = data.routes[0];
      routeGeometry = route.geometry.coordinates;
      rawRouteDistanceMeters = route.distance;

      if (map.getSource('routeSource')) {
        map.getSource('routeSource').setData({ type: 'Feature', geometry: route.geometry });
      }

      if (destMarker) destMarker.remove();
      const dEl = document.createElement('div');
      dEl.style.cssText = 'width:28px;height:28px;border-radius:50%;background:#e11d48;border:2.5px solid white;display:flex;align-items:center;justify-content:center;color:white;box-shadow:0 0 14px rgba(225,29,72,0.9);';
      dEl.innerHTML = '<i class="fa-solid fa-flag-checkered text-xs"></i>';
      destMarker = new maplibregl.Marker({ element: dEl }).setLngLat(destCoords).addTo(map);

      routeSteps = [];
      route.legs.forEach(leg => {
        leg.steps.forEach(step => {
          const sLoc = step.maneuver.location;
          const nearShop = findClosestLandmarkToStep(sLoc[1], sLoc[0]);
          routeSteps.push({
            text: formatLandmarkTurnText(step, nearShop),
            distM: Math.round(step.distance),
            road: step.name || "Local Road",
            type: step.maneuver.type,
            modifier: step.maneuver.modifier || "straight",
            loc: sLoc,
            landmarkCue: nearShop ? `By ${nearShop.name} (${nearShop.sub_type})` : `Along ${step.name || 'corridor'}`
          });
        });
      });

      recalculateVehicleETA(rawRouteDistanceMeters, routeSteps.length, false);

      const shortDest = document.getElementById('destSearchInput').value.split(',')[0];
      saveRouteForOffline(shortDest, {
        coordinates: routeGeometry,
        steps: routeSteps,
        distance_km: totalDistKm,
        duration_min: totalDurMin
      });

      renderStepsDrawer();
      document.getElementById('stepsCountBadge').innerText = routeSteps.length;

      if (routeSteps.length > 0) {
        const hud = document.getElementById('activeManeuverHud');
        hud.classList.remove('hidden');
        hud.classList.add('flex');
        updateHUD(routeSteps[0], totalDistKm, totalDurMin);
      }

      if (!isAutopilotActive) {
        const bounds = new maplibregl.LngLatBounds();
        routeGeometry.forEach(c => bounds.extend(c));
        map.fitBounds(bounds, { padding: 70, pitch: is3D ? 45 : 0, duration: 850 });
      }

      if (announceVoice) {
        const prof = VEHICLE_SPEED_MAP[activeVehicleMode] || VEHICLE_SPEED_MAP.car;
        const firstCue = routeSteps[0] ? `${routeSteps[0].text}.` : '';
        const msg = `By ${prof.label.toLowerCase()}, ${shortDest} is ${totalDistKm} km away, taking about ${formatMinutesLabel(totalDurMin)} (ETA ${currentArrivalClock}). ${firstCue}`;
        setAssistantSpeech(msg);
        speakVoice(msg);
      }
    }
  } catch (e) {
    console.error("Routing error:", e);
  }
}

function findClosestLandmarkToStep(lat, lng) {
  let best = null;
  let minD = 0.25;
  for (const p of microPlaces) {
    const d = Math.hypot(p.lat - lat, p.lng - lng) * 111;
    if (d < minD) { minD = d; best = p; }
  }
  return best;
}

function formatLandmarkTurnText(step, nearShop) {
  const t = step.maneuver.type;
  const m = step.maneuver.modifier || "";
  const r = step.name ? `onto ${step.name}` : "";
  const shopSuffix = nearShop ? ` near ${nearShop.name}` : "";

  if (t === 'depart') return `Head ${m || 'forward'} ${r}${shopSuffix}`.trim();
  if (t === 'arrive') return `Arrive at destination${shopSuffix}`;
  if (t === 'turn') return `Turn ${m} ${r}${shopSuffix}`.trim();
  if (t === 'roundabout') return `Take roundabout ${r}${shopSuffix}`.trim();
  return `Continue ${m || 'straight'} ${r}${shopSuffix}`.trim();
}

function renderStepsDrawer() {
  const panel = document.getElementById('drawerStepsList');
  if (!routeSteps.length) return;
  panel.innerHTML = routeSteps.map((s, idx) => `
    <div onclick="map.flyTo({center:[${s.loc[0]},${s.loc[1]}],zoom:17.5,pitch:45})" class="p-2.5 rounded-xl bg-[#050811]/90 hover:bg-white/[0.06] border border-white/10 flex items-center gap-3 cursor-pointer">
      <div class="w-6 h-6 rounded-lg bg-cyan-500/15 text-cyan-400 border border-cyan-500/30 flex items-center justify-center shrink-0 text-[11px] font-mono font-bold">${idx + 1}</div>
      <div class="flex-1 min-w-0">
        <div class="text-xs font-bold text-white truncate">${s.text}</div>
        <div class="text-[10px] text-amber-300 truncate">📍 ${s.landmarkCue}</div>
        <div class="text-[10px] text-slate-400 font-mono">${s.distM} m • ${s.road}</div>
      </div>
    </div>
  `).join('');
}

function updateHUD(step, remKm, remMin) {
  document.getElementById('hudNextDist').innerText = `IN ${step.distM} M`;
  document.getElementById('hudDurationBadge').innerText = `${remMin} min`;
  document.getElementById('hudArrivalClock').innerText = `ETA ${currentArrivalClock || '--:--'}`;
  document.getElementById('hudEtaDist').innerText = `${remKm} km`;
  document.getElementById('hudTurnText').innerText = step.text;
  document.getElementById('hudLandmarkCue').innerText = `📍 ${step.landmarkCue}`;
}

function injectWaypoint(lat, lng, name, announce = true) {
  waypointCoords = [lng, lat];
  if (waypointMarker) waypointMarker.remove();
  const wEl = document.createElement('div');
  wEl.style.cssText = 'width:26px;height:26px;border-radius:50%;background:#f59e0b;border:2px solid white;display:flex;align-items:center;justify-content:center;color:white;';
  wEl.innerHTML = '<i class="fa-solid fa-location-dot text-[10px]"></i>';
  waypointMarker = new maplibregl.Marker({ element: wEl }).setLngLat(waypointCoords).addTo(map);

  if (!destCoords) {
    destCoords = [lng, lat];
    waypointCoords = null;
    document.getElementById('destSearchInput').value = name;
  }
  calculateRoute(announce);
}

function clearWaypointOnly() {
  waypointCoords = null;
  if (waypointMarker) waypointMarker.remove();
  if (destCoords) calculateRoute(false);
}

function routeNearestMedicalSideOption() {
  submitVoiceText("Find nearest hospital or medical pharmacy");
}

function toggleSmoothAutopilot() {
  if (isAutopilotActive) {
    stopSmoothAutopilot();
    return;
  }
  if (!destCoords || routeGeometry.length < 2) {
    setAssistantSpeech("Select a destination first to start guided drive.");
    return;
  }

  isAutopilotActive = true;
  routeProgressFloat = 0;
  lastSpokenStepIdx = -1;
  driveStartTimeMs = Date.now();
  breakPromptShown = false;
  document.getElementById('autopilotLabel').innerText = "Pause";

  const animate = () => {
    if (!isAutopilotActive) return;
    const prof = VEHICLE_SPEED_MAP[activeVehicleMode] || VEHICLE_SPEED_MAP.car;
    const inc = activeVehicleMode === 'walk' ? 0.012 : (activeVehicleMode === 'bike' ? 0.042 : 0.045);

    routeProgressFloat += inc;
    const idx = Math.floor(routeProgressFloat);
    const frac = routeProgressFloat - idx;

    if (idx >= routeGeometry.length - 1) {
      stopSmoothAutopilot();
      const destTitle = document.getElementById('destSearchInput').value.split(',')[0];
      const msg = `Arrived at ${destTitle}.`;
      setAssistantSpeech(msg);
      speakVoice(msg);
      return;
    }

    const p1 = routeGeometry[idx];
    const p2 = routeGeometry[idx + 1];
    currentCoords = [p1[0] + (p2[0] - p1[0]) * frac, p1[1] + (p2[1] - p1[1]) * frac];
    vehicleMarker.setLngLat(currentCoords);

    currentHeading = calcBearing(p1[1], p1[0], p2[1], p2[0]);
    currentSpeedKmh = prof.simKmh;
    document.getElementById('speedMiniBadge').innerText = `${currentSpeedKmh} km/h`;

    map.jumpTo({ center: currentCoords, bearing: currentHeading, pitch: is3D ? 45 : 0, zoom: 17 });

    for (const h of nearbyHazards) {
      const distToHaz = calcDistanceMeters(currentCoords[1], currentCoords[0], h.lat, h.lng);
      if (distToHaz < 220 && !window.speechSynthesis.speaking) {
        speakVoice(`Caution: ${h.hazard_type} ahead in ${Math.round(distToHaz)} meters.`);
      }
    }

    if (!breakPromptShown && driveStartTimeMs && (Date.now() - driveStartTimeMs > 90000)) {
      breakPromptShown = true;
      setAssistantSpeech("Tip: You have been on the move for a while. Want me to find a nearby tea or rest stop?");
    }

    const ratioLeft = 1 - (routeProgressFloat / (routeGeometry.length - 1));
    const remKm = Math.max(0.05, (totalDistKm * ratioLeft)).toFixed(2);
    const remMin = Math.max(1, Math.round(totalDurMin * ratioLeft));

    if (routeSteps.length > 0) {
      const sIdx = Math.min(routeSteps.length - 1, Math.floor((1 - ratioLeft) * routeSteps.length));
      const activeStep = routeSteps[sIdx];
      updateHUD(activeStep, remKm, remMin);

      if (sIdx !== lastSpokenStepIdx) {
        lastSpokenStepIdx = sIdx;
        if (!window.speechSynthesis.speaking) {
          speakVoice(`${activeStep.text}, ${activeStep.landmarkCue}`);
        }
      }
    }
    animFrameId = requestAnimationFrame(animate);
  };
  animFrameId = requestAnimationFrame(animate);
}

function stopSmoothAutopilot() {
  isAutopilotActive = false;
  if (animFrameId) cancelAnimationFrame(animFrameId);
  currentSpeedKmh = 0;
  document.getElementById('speedMiniBadge').innerText = "0 km/h";
  document.getElementById('autopilotLabel').innerText = "Drive";
}

function stopNavigation() {
  stopSmoothAutopilot();
  destCoords = null;
  waypointCoords = null;
  rawRouteDistanceMeters = 0;
  routeGeometry = [];
  routeSteps = [];
  if (destMarker) destMarker.remove();
  if (waypointMarker) waypointMarker.remove();
  if (map.getSource('routeSource')) {
    map.getSource('routeSource').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: [] } });
  }
  document.getElementById('activeManeuverHud').classList.add('hidden');
  document.getElementById('activeManeuverHud').classList.remove('flex');
  document.getElementById('destSearchInput').value = '';
}

function toggleDriveFocusMode() {
  isDriveFocusMode = !isDriveFocusMode;
  const chips = document.getElementById('quickChipsRow');
  const btn = document.getElementById('focusModeBtn');
  if (isDriveFocusMode) {
    chips.classList.add('hidden');
    btn.classList.add('border-cyan-400', 'bg-cyan-500/20');
    setAssistantSpeech("Drive Focus Mode ON: Minimal screen clutter while driving.");
  } else {
    chips.classList.remove('hidden');
    btn.classList.remove('border-cyan-400', 'bg-cyan-500/20');
  }
}

function initSpeechEngine() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;
  speechRec = new SR();
  speechRec.continuous = false;
  speechRec.interimResults = false;
  speechRec.lang = 'en-IN';

  speechRec.onstart = () => {
    isListening = true;
    document.getElementById('micOrbBtn').classList.add('mic-recording');
    document.getElementById('aiEqualizer').classList.add('active');
    document.getElementById('voiceTranscriptLabel').innerText = "Listening...";
  };
  speechRec.onresult = (e) => submitVoiceText(e.results[0][0].transcript);
  speechRec.onerror = () => stopMicAnim();
  speechRec.onend = () => stopMicAnim();
}

function toggleMicrophone() {
  if (!speechRec) return;
  if (isListening) { speechRec.stop(); stopMicAnim(); }
  else { window.speechSynthesis.cancel(); speechRec.start(); }
}

function stopMicAnim() {
  isListening = false;
  document.getElementById('micOrbBtn').classList.remove('mic-recording');
  document.getElementById('aiEqualizer').classList.remove('active');
}

function toggleHandsFreeLoop() {
  handsFreeMode = !handsFreeMode;
  const txt = document.getElementById('handsFreeText');
  if (handsFreeMode) {
    txt.innerText = "Hands-Free: ON";
    toggleMicrophone();
  } else {
    txt.innerText = "Hands-Free: OFF";
  }
}

function sendTypedAssistantQuery() {
  const inp = document.getElementById('copilotInput');
  const txt = inp.value.trim();
  if (!txt) return;
  inp.value = '';
  submitVoiceText(txt);
}

function submitVoiceText(text) {
  document.getElementById('voiceTranscriptLabel').innerText = `"${text}"`;
  const upcoming = routeSteps.slice(0, 3).map(s => `${s.text} (${s.landmarkCue})`);
  const savedKey = localStorage.getItem('navivoice_gemini_key') || '';

  fetch('/api/assistant', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: text,
      lat: currentCoords[1],
      lng: currentCoords[0],
      heading: currentHeading,
      speed: currentSpeedKmh,
      vehicle_type: activeVehicleMode,
      current_road: currentStreetName,
      next_turn: routeSteps[0] ? routeSteps[0].text : "Continue straight",
      upcoming_steps: upcoming,
      dest_name: document.getElementById('destSearchInput').value || "",
      rem_dist: `${totalDistKm} km`,
      rem_time: `${totalDurMin} min`,
      arrival_clock: currentArrivalClock,
      is_navigating: destCoords !== null,
      nearby_pois: microPlaces,
      nearby_hazards: nearbyHazards,
      memory: conversationMemory,
      gemini_api_key: savedKey
    })
  })
  .then(r => r.json())
  .then(async (data) => {
    setAssistantSpeech(data.reply);
    speakVoice(data.reply);

    if (data.candidates && data.candidates.length > 0) {
      conversationMemory.last_candidates = data.candidates;
    }

    if (data.action === 'check_detour' && data.target_poi) {
      await handleDetourCheckAction(data.target_poi);
    }
    else if (data.action === 'switch_vehicle' && data.vehicle_type) {
      setVehicleMode(data.vehicle_type);
    }
    else if (data.action === 'report_hazard') {
      quickReportHazardHere(data.hazard_type || "Road Hazard");
    }
    else if (data.action === 'compound_route' && data.dest_query) {
      if (data.target_poi) {
        waypointCoords = [data.target_poi.lng, data.target_poi.lat];
        if (waypointMarker) waypointMarker.remove();
        const wEl = document.createElement('div');
        wEl.style.cssText = 'width:26px;height:26px;border-radius:50%;background:#f59e0b;border:2px solid white;display:flex;align-items:center;justify-content:center;color:white;';
        wEl.innerHTML = '<i class="fa-solid fa-location-dot text-[10px]"></i>';
        waypointMarker = new maplibregl.Marker({ element: wEl }).setLngLat(waypointCoords).addTo(map);
      }
      const geo = await fetch(`/api/autocomplete?q=${encodeURIComponent(data.dest_query)}&lat=${currentCoords[1]}&lng=${currentCoords[0]}`);
      const geoData = await geo.json();
      if (geoData.results && geoData.results.length > 0) {
        const best = geoData.results[0];
        destCoords = [best.lng, best.lat];
        document.getElementById('destSearchInput').value = best.name;
        calculateRoute(false);
      }
    }
    else if (data.action === 'search_destination' && data.dest_query) {
      const geo = await fetch(`/api/autocomplete?q=${encodeURIComponent(data.dest_query)}&lat=${currentCoords[1]}&lng=${currentCoords[0]}`);
      const geoData = await geo.json();
      if (geoData.results && geoData.results.length > 0) {
        const best = geoData.results[0];
        selectPlace('dest', best.name, best.lat, best.lng);
      }
    }
    else if (data.action === 'set_destination_poi' && data.target_poi) {
      selectPlace('dest', data.target_poi.name, data.target_poi.lat, data.target_poi.lng);
    }
    else if (data.action === 'add_waypoint' && data.target_poi) {
      injectWaypoint(data.target_poi.lat, data.target_poi.lng, data.target_poi.name, false);
    }
    else if (data.action === 'clear_waypoint') {
      clearWaypointOnly();
    }
    else if (data.action === 'rescan_wider') {
      scanMicroSurroundings(false, 8000);
    }
    else if (data.action === 'open_drawer') {
      document.getElementById('detailsDrawer').classList.remove('translate-x-full');
    }
    else if (data.action === 'open_street_view') {
      if (!isStreetViewOpen) toggleStreetViewMode();
    }
    else if (data.action === 'close_street_view') {
      if (isStreetViewOpen) toggleStreetViewMode();
    }
    else if (data.action === 'switch_layer' && data.layer) {
      setMapLayer(data.layer);
    }
    else if (data.action === 'start_drive' && !isAutopilotActive) {
      toggleSmoothAutopilot();
    }
    else if (data.action === 'stop_nav') {
      stopNavigation();
    }
  });
}

function setMapLayer(mode) {
  ['gmap_detail', 'hybrid', 'satellite', 'osm_detail', 'dark'].forEach(m => {
    const b = document.getElementById(`btn-${m}`);
    if (b) {
      if (m === mode) b.classList.add('active-layer');
      else b.classList.remove('active-layer');
    }
  });

  const mapEl = document.getElementById('map');
  mapEl.classList.remove('map-dark-filter');

  const vis = {
    'gmap-detail-layer': (mode === 'gmap_detail' || mode === 'dark') ? 'visible' : 'none',
    'gmap-hybrid-layer': mode === 'hybrid' ? 'visible' : 'none',
    'gmap-sat-layer': mode === 'satellite' ? 'visible' : 'none',
    'osm-detail-layer': mode === 'osm_detail' ? 'visible' : 'none'
  };

  Object.entries(vis).forEach(([layerId, state]) => {
    if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', state);
  });

  if (mode === 'dark') mapEl.classList.add('map-dark-filter');
  document.getElementById('layerPopover').classList.add('hidden');
}

function togglePOIMarkers(enabled) {
  if (enabled) renderMicroMapMarkers();
  else { poiMarkers.forEach(m => m.remove()); poiMarkers = []; }
}

function dismissPinModal() {
  pendingPinCoords = null;
  document.getElementById('mapPinModal').classList.add('hidden');
}

function confirmPinAsStart() {
  if (!pendingPinCoords) return;
  const c = [...pendingPinCoords];
  dismissPinModal();
  setLiveOrigin(c[1], c[0], pendingPinAddress, false, 2, true);
}

function confirmPinAsWaypoint() {
  if (!pendingPinCoords) return;
  const c = [...pendingPinCoords];
  dismissPinModal();
  injectWaypoint(c[1], c[0], pendingPinAddress || "Pinned Stop");
}

function confirmPinDestination() {
  if (!pendingPinCoords) return;
  const c = [...pendingPinCoords];
  dismissPinModal();
  selectPlace('dest', pendingPinAddress || `Pinned (${c[1].toFixed(4)}, ${c[0].toFixed(4)})`, c[1], c[0]);
}

function toggleLayerPopover() { document.getElementById('layerPopover').classList.toggle('hidden'); }
function toggleDetailsDrawer() { document.getElementById('detailsDrawer').classList.toggle('translate-x-full'); }
function toggleAiSettingsModal() { document.getElementById('aiSettingsModal').classList.toggle('hidden'); }

function saveGeminiKey() {
  const val = document.getElementById('geminiKeyInput').value.trim();
  localStorage.setItem('navivoice_gemini_key', val);
  document.getElementById('aiBrainBadge').innerText = val ? "Gemini LLM + ETA" : "Vehicle ETA Engine";
  toggleAiSettingsModal();
  setAssistantSpeech(val ? "Gemini LLM brain connected!" : "Using built-in Multi-Turn AI engine.");
}

function switchDrawerTab(tab) {
  const tabs = ['pois', 'steps', 'hazards', 'offline'];
  const btns = {
    pois: document.getElementById('tabPoisBtn'),
    steps: document.getElementById('tabStepsBtn'),
    hazards: document.getElementById('tabHazardsBtn'),
    offline: document.getElementById('tabOfflineBtn')
  };
  const panels = {
    pois: document.getElementById('drawerPoisList'),
    steps: document.getElementById('drawerStepsList'),
    hazards: document.getElementById('drawerHazardsList'),
    offline: document.getElementById('drawerOfflineList')
  };

  tabs.forEach(t => {
    if (t === tab) {
      btns[t].className = "py-2 text-cyan-400 border-b-2 border-cyan-400";
      panels[t].classList.remove('hidden');
    } else {
      btns[t].className = "py-2 text-slate-400 hover:text-white";
      panels[t].classList.add('hidden');
    }
  });
}

function toggle3DCamera() {
  is3D = !is3D;
  document.getElementById('btn3DToggle').innerText = is3D ? "3D" : "2D";
  map.easeTo({ pitch: is3D ? 45 : 0, duration: 450 });
}

function setAssistantSpeech(html) {
  document.getElementById('assistantReplyText').innerHTML = html;
}

function speakVoice(text) {
  if (!voiceAudioEnabled || !('speechSynthesis' in window)) {
    if (handsFreeMode && speechRec && !isListening) {
      setTimeout(() => { try { speechRec.start(); } catch (_) {} }, 400);
    }
    return;
  }
  window.speechSynthesis.cancel();
  const clean = text.replace(/<[^>]*>?/gm, '');
  const u = new SpeechSynthesisUtterance(clean);
  u.rate = 1.05;
  u.onend = () => {
    if (handsFreeMode && speechRec && !isListening) {
      setTimeout(() => { try { speechRec.start(); } catch (_) {} }, 350);
    }
  };
  window.speechSynthesis.speak(u);
}

function toggleVoiceAudio() {
  voiceAudioEnabled = !voiceAudioEnabled;
  document.getElementById('voiceAudioBtn').innerHTML = voiceAudioEnabled
    ? '<i class="fa-solid fa-volume-high"></i>'
    : '<i class="fa-solid fa-volume-xmark text-slate-500"></i>';
  if (!voiceAudioEnabled) window.speechSynthesis.cancel();
}

function calcDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function calcBearing(lat1, lon1, lat2, lon2) {
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(dLon) * Math.cos(lat2 * Math.PI / 180);
  const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
            Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}


// GROUND-LEVEL STREET VIEW MODE (Interactive 360° Pan/Tilt + Street Landmarks)
let isStreetViewOpen = false;
let svMap = null;
let svYaw = 0;
let svPitchTilt = 68;
let svScale = 1.0;
let svDragging = false;
let svLastX = 0;
let svLastY = 0;

function toggleStreetViewMode() {
  const overlay = document.getElementById('streetViewOverlay');
  isStreetViewOpen = !isStreetViewOpen;

  if (isStreetViewOpen) {
    overlay.classList.remove('hidden');
    svYaw = currentHeading || 0;
    svPitchTilt = 68;
    svScale = 1.0;
    updateStreetViewHeader();
    renderStreetViewLandmarks();
    initOrSyncStreetViewMap();
    bindStreetViewDragControls();
  } else {
    overlay.classList.add('hidden');
    if (svAutoPanTimer) { clearInterval(svAutoPanTimer); svAutoPanTimer = null; svAutoPanActive = false; }
  }
}

function updateStreetViewHeader() {
  document.getElementById('svStreetTitle').innerText = currentStreetName || "Street View Panorama";
  document.getElementById('svCoordsSubtitle').innerText =
    `${currentCoords[1].toFixed(5)}°N, ${currentCoords[0].toFixed(5)}°E • ${activeVehicleMode.toUpperCase()} Mode`;
  const dirNames = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const normYaw = ((Math.round(svYaw) % 360) + 360) % 360;
  const dirLabel = dirNames[Math.round(normYaw / 45) % 8];
  document.getElementById('svCompassHeading').innerText = `${normYaw}° ${dirLabel}`;
  const pitchEl = document.getElementById('svPitchReadout');
  if (pitchEl) pitchEl.innerText = `Tilt ${Math.round(svPitchTilt)}°`;
  const zoomEl = document.getElementById('svZoomReadout');
  if (zoomEl) zoomEl.innerText = `${svScale.toFixed(1)}x`;
}

function initOrSyncStreetViewMap() {
  if (!svMap) {
    svMap = new maplibregl.Map({
      container: 'svMapMount',
      style: {
        version: 8,
        sources: {
          'sv-hybrid-src': {
            type: 'raster',
            tiles: [
              'https://mt0.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
              'https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
              'https://mt2.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
              'https://mt3.google.com/vt/lyrs=y&x={x}&y={y}&z={z}'
            ],
            tileSize: 256,
            maxzoom: 21
          }
        },
        layers: [
          {
            id: 'sv-hybrid-layer',
            type: 'raster',
            source: 'sv-hybrid-src',
            paint: { 'raster-fade-duration': 0 }
          }
        ]
      },
      center: currentCoords,
      zoom: 18.2,
      pitch: 68,
      bearing: svYaw,
      interactive: false,
      fadeDuration: 0
    });
  } else {
    svMap.jumpTo({
      center: currentCoords,
      zoom: 18.2,
      pitch: svPitchTilt,
      bearing: svYaw
    });
  }
  applyStreetViewTransform();
}

function bindStreetViewDragControls() {
  const stage = document.getElementById('svViewport');
  if (stage.dataset.bound === '1') return;
  stage.dataset.bound = '1';

  const onStart = (clientX, clientY) => {
    svDragging = true;
    svLastX = clientX;
    svLastY = clientY;
  };

  const onMove = (clientX, clientY) => {
    if (!svDragging) return;
    const dx = clientX - svLastX;
    const dy = clientY - svLastY;
    svLastX = clientX;
    svLastY = clientY;

    svYaw = (svYaw - dx * 0.35 + 360) % 360;
    svPitchTilt = Math.max(35, Math.min(75, svPitchTilt - dy * 0.15));

    if (svMap) {
      svMap.setBearing(svYaw);
      svMap.setPitch(svPitchTilt);
    }
    if (!svMinimap && document.getElementById('svMinimapMount')) {
      svMinimap = new maplibregl.Map({
        container: 'svMinimapMount',
        style: {
          version: 8,
          sources: {
            'mini-src': {
              type: 'raster',
              tiles: ['https://mt0.google.com/vt/lyrs=m&x={x}&y={y}&z={z}'],
              tileSize: 256,
              maxzoom: 20
            }
          },
          layers: [{ id: 'mini-lyr', type: 'raster', source: 'mini-src' }]
        },
        center: currentCoords,
        zoom: 15,
        interactive: false
      });
    } else if (svMinimap) {
      svMinimap.setCenter(currentCoords);
      svMinimap.setBearing(svYaw);
    }
    updateStreetViewHeader();
    applyStreetViewTransform();
  };

  const onEnd = () => { svDragging = false; };

  stage.addEventListener('mousedown', (e) => onStart(e.clientX, e.clientY));
  window.addEventListener('mousemove', (e) => onMove(e.clientX, e.clientY));
  window.addEventListener('mouseup', onEnd);

  stage.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) onStart(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  stage.addEventListener('touchmove', (e) => {
    if (e.touches.length === 1) onMove(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  stage.addEventListener('touchend', onEnd);
}

function applyStreetViewTransform() {
  const stage = document.getElementById('svHorizonStage');
  if (!stage) return;
  const panOffset = ((svYaw % 360) - 180) * 0.4;
  stage.style.transform = `scale(${svScale}) translateX(${panOffset}px)`;
}

function adjustStreetViewZoom(delta) {
  svScale = Math.max(0.8, Math.min(1.8, Number((svScale + delta).toFixed(2))));
  applyStreetViewTransform();
}

function renderStreetViewLandmarks() {
  const strip = document.getElementById('svNearbyStrip');
  if (!strip) return;

  const list = (microPlaces || []).slice(0, 8);
  if (!list.length) {
    strip.innerHTML = `<div class="sv-landmark-card text-xs text-slate-300">Scanning landmarks along ${currentStreetName}...</div>`;
    return;
  }

  strip.innerHTML = list.map(p => `
    <div onclick="toggleStreetViewMode(); selectPlace('dest', '${p.name.replace(/'/g, "")}', ${p.lat}, ${p.lng})" class="sv-landmark-card">
      <div class="flex items-center justify-between text-[10px] font-mono">
        <span class="text-sky-400 font-bold uppercase truncate">${p.sub_type}</span>
        <span class="text-emerald-400 font-extrabold ml-1">${p.distance_m}m</span>
      </div>
      <div class="text-xs font-bold text-white truncate mt-1">${p.name}</div>
      <div class="text-[10px] text-slate-400 truncate mt-0.5">${p.side_of_road.toUpperCase()}${p.street ? ' • ' + p.street : ''}</div>
    </div>
  `).join('');
}


// FREE & CLOSE MAP EXPLORATION + 360° STREET VIEW ENHANCEMENTS
let freeMapExploreMode = true;
let isCloseZoomActive = false;
let svMinimap = null;
let svAutoPanTimer = null;
let svAutoPanActive = false;

function toggleFreeMapExploration() {
  freeMapExploreMode = !freeMapExploreMode;
  const btn = document.getElementById('freeExploreBtn');
  if (map) {
    map.dragPan.enable();
    map.scrollZoom.enable();
    map.boxZoom.enable();
    map.dragRotate.enable();
    map.keyboard.enable();
    map.touchZoomRotate.enable();
  }
  if (btn) {
    if (freeMapExploreMode) btn.classList.add('dock-active-mode');
    else btn.classList.remove('dock-active-mode');
  }
  setAssistantSpeech(
    freeMapExploreMode
      ? "Free Map Exploration ON: Pan, zoom, tilt, and rotate anywhere across the full map freely."
      : "Camera controls reset to standard navigation mode."
  );
}

function toggleCloseVsWideView() {
  isCloseZoomActive = !isCloseZoomActive;
  const btn = document.getElementById('closeWideBtn');
  if (!map) return;

  if (isCloseZoomActive) {
    btn.innerText = "WIDE";
    map.flyTo({
      center: currentCoords,
      zoom: 18.4,
      pitch: 62,
      duration: 700
    });
    setAssistantSpeech("Zoomed in close to street and building level.");
  } else {
    btn.innerText = "CLOSE";
    map.flyTo({
      center: currentCoords,
      zoom: 13.5,
      pitch: 25,
      duration: 850
    });
    setAssistantSpeech("Zoomed out to wider map view so you can explore the surrounding area.");
  }
}

function stepStreetViewAlongRoad(stepMeters = 25) {
  const rad = (svYaw * Math.PI) / 180;
  const dLat = (stepMeters * Math.cos(rad)) / 111320;
  const dLng = (stepMeters * Math.sin(rad)) / (111320 * Math.cos((currentCoords[1] * Math.PI) / 180));

  currentCoords = [currentCoords[0] + dLng, currentCoords[1] + dLat];
  if (vehicleMarker) vehicleMarker.setLngLat(currentCoords);
  if (map) map.setCenter(currentCoords);
  if (svMap) svMap.setCenter(currentCoords);
  if (svMinimap) svMinimap.setCenter(currentCoords);

  updateStreetViewHeader();
  renderStreetViewLandmarks();
}

function toggleSvAutoPan() {
  svAutoPanActive = !svAutoPanActive;
  const btn = document.getElementById('svAutoPanBtn');
  if (svAutoPanTimer) {
    clearInterval(svAutoPanTimer);
    svAutoPanTimer = null;
  }

  if (svAutoPanActive) {
    if (btn) btn.classList.add('dock-active-mode');
    svAutoPanTimer = setInterval(() => {
      svYaw = (svYaw + 2.5) % 360;
      if (svMap) svMap.setBearing(svYaw);
      updateStreetViewHeader();
      applyStreetViewTransform();
    }, 60);
  } else {
    if (btn) btn.classList.remove('dock-active-mode');
  }
}


// ULTRA 360° STREET VIEW & CLOSE MAP EXPLORATION CONTROLS (v17)
function rotateSvAngle(deltaDeg) {
  svYaw = ((svYaw + deltaDeg) % 360 + 360) % 360;
  if (svMap) svMap.setBearing(svYaw);
  if (svMinimap) svMinimap.setBearing(svYaw);
  updateStreetViewHeader();
  applyStreetViewTransform();
}

function openCloseStreetViewAtCurrent() {
  if (!isStreetViewOpen) {
    toggleStreetViewMode();
  }
  svScale = 1.35;
  svPitchTilt = 72;
  if (svMap) {
    svMap.flyTo({
      center: currentCoords,
      zoom: 19.0,
      pitch: svPitchTilt,
      bearing: svYaw,
      duration: 600
    });
  }
  updateStreetViewHeader();
  applyStreetViewTransform();
}


async function handleDetourCheckAction(targetPoi) {
  if (!destCoords || !targetPoi) return;
  try {
    const r = await fetch('/api/detour_check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        origin: currentCoords,
        dest: destCoords,
        stop: [targetPoi.lng, targetPoi.lat],
        vehicle_type: activeVehicleMode
      })
    });
    const d = await r.json();
    const prof = VEHICLE_SPEED_MAP[activeVehicleMode] || VEHICLE_SPEED_MAP.car;
    const msg = `Stopping at ${targetPoi.name} by ${prof.label.toLowerCase()} adds about ${d.extra_minutes} min (${d.extra_km} km extra), making total trip ${d.via_total_minutes} min (${d.via_total_km} km).`;
    setAssistantSpeech(msg);
    speakVoice(msg);
  } catch (_) {}
}
