/*
  AccessAssist — community accessibility map prototype
  ------------------------------------------------------
  Map layer: Leaflet + OpenStreetMap tiles. No API key, no billing account,
  no Google dependency of any kind.

  SETUP (run once in your React project):
    npm install leaflet react-leaflet

  Then drop this file in as a component and render <AccessAssistApp /> from
  anywhere (App.jsx, a route, etc). No environment variables, no keys, no
  network requests other than the OSM tile fetches (which is what draws the
  map imagery — everything else works fully offline once tiles are cached
  by the browser).
*/

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { MapContainer, TileLayer, Marker, Popup, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { createClient } from "@supabase/supabase-js";
import "./dashboard.css";

// ---------------------------------------------------------------------------
// Design tokens
// ---------------------------------------------------------------------------
const COLORS = {
  bg: "#15121f",
  panel: "#1d1930",
  panelBorder: "#33294f",
  text: "#f1edfb",
  textDim: "#a79cc7",
  accent: "#8b6bff",
  accentDim: "#5a4a8f",
  good: "#3ddc97",
  mid: "#f2c14e",
  bad: "#ef5b7c",
  chip: "#2a2244",
};

const FEATURE_LIBRARY = [
  { id: "ramp", label: "Step-free entrance", weight: 30 },
  { id: "doorway", label: "Wide doorways", weight: 15 },
  { id: "restroom", label: "Accessible restroom", weight: 20 },
  { id: "tactile", label: "Tactile paving", weight: 10 },
  { id: "elevator", label: "Elevator access", weight: 15 },
  { id: "parking", label: "Accessible parking", weight: 10 },
];

const BARRIER_LIBRARY = [
  { id: "entrance", label: "Entrance is blocked / no step-free access", icon: "🚪" },
  { id: "doorway", label: "Doorway is too narrow", icon: "↔️" },
  { id: "elevator", label: "Elevator is unavailable / broken", icon: "🛗" },
  { id: "restroom", label: "Accessible restroom is unavailable", icon: "🚻" },
  { id: "parking", label: "Accessible parking is blocked", icon: "🅿️" },
  { id: "tactile", label: "Tactile path is blocked / damaged", icon: "🦯" },
  { id: "surface", label: "Uneven or unsafe surface", icon: "⚠️" },
];

const VIJAYAWADA_CENTER = [16.5062, 80.648];

const REQUIREMENTS = [
  { id: "wheelchair", label: "Wheelchair", icon: "♿", weights: { ramp: 35, doorway: 20, restroom: 20, elevator: 15, parking: 10 } },
  { id: "walking", label: "Walking assistance", icon: "🦯", weights: { ramp: 25, doorway: 20, restroom: 15, elevator: 15, parking: 10, tactile: 15 } },
  { id: "lowvision", label: "Low vision", icon: "👁️", weights: { tactile: 35, doorway: 20, elevator: 15, restroom: 15, ramp: 15 } },
  { id: "stroller", label: "Stroller", icon: "👶", weights: { ramp: 35, doorway: 25, restroom: 15, elevator: 15, parking: 10 } },
  { id: "elderly", label: "Elderly-friendly", icon: "👴", weights: { ramp: 25, doorway: 15, restroom: 15, elevator: 20, parking: 10, tactile: 15 } },
];

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

const DEVICE_ID = (() => {
  const key = "accessassist_device_id";
  let id = localStorage.getItem(key);
  if (!id) { id = crypto.randomUUID ? crypto.randomUUID() : `device-${Date.now()}`; localStorage.setItem(key, id); }
  return id;
})();

// How many distinct signed-in accounts must independently confirm a place
// before it flips to "Verified". One tap from one account is no longer
// enough — this is what makes the badge mean something.
const VERIFICATION_THRESHOLD = 2;

// A photo, when attached, is stored downscaled to keep each row small.
// For a production deployment this should move to Supabase Storage
// (upload the file, store only the resulting URL) instead of embedding
// base64 in the table — this inline approach is a pragmatic prototype
// stand-in that needs no storage bucket / CORS setup to demo.
const MAX_PHOTO_DIMENSION = 640;
const PHOTO_JPEG_QUALITY = 0.6;

async function compressPhotoFile(file) {
  if (!file) return null;
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const img = await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not read image"));
    image.src = dataUrl;
  });
  const scale = Math.min(1, MAX_PHOTO_DIMENSION / Math.max(img.width, img.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", PHOTO_JPEG_QUALITY);
}

// ---------------------------------------------------------------------------
// Offline map pack — a fixed bounding box over central Vijayawada.
// IMPORTANT: raw tile.openstreetmap.org servers explicitly prohibit heavy /
// bulk automated downloading (see their tile usage policy). This pack is
// deliberately small (~150 tiles, zoom 13-15, one-time, user-initiated) and
// throttled to stay well inside "light use". For a production app that
// really needs offline map packs, switch the TileLayer to a provider whose
// terms allow caching for offline use (e.g. MapTiler, Stadia Maps,
// Thunderforest) instead of scaling this approach up.
// ---------------------------------------------------------------------------
const OFFLINE_BBOX = { latMin: 16.47, latMax: 16.56, lngMin: 80.58, lngMax: 80.70 };
const OFFLINE_ZOOMS = [13, 14, 15];
const OFFLINE_TILE_CACHE = "aa-osm-tiles"; // matches vite.config.js runtimeCaching cacheName
const OFFLINE_BATCH_SIZE = 6;
const OFFLINE_BATCH_DELAY_MS = 180;

function lonToTileX(lon, z) {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}
function latToTileY(lat, z) {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z
  );
}

function buildOfflineTileList() {
  const urls = [];
  for (const z of OFFLINE_ZOOMS) {
    const x1 = lonToTileX(OFFLINE_BBOX.lngMin, z);
    const x2 = lonToTileX(OFFLINE_BBOX.lngMax, z);
    const y1 = latToTileY(OFFLINE_BBOX.latMax, z);
    const y2 = latToTileY(OFFLINE_BBOX.latMin, z);
    for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
      for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
        urls.push(`https://a.tile.openstreetmap.org/${z}/${x}/${y}.png`);
      }
    }
  }
  return urls;
}

function personalizedScore(place, requirementId) {
  const req = REQUIREMENTS.find((r) => r.id === requirementId);
  if (!req) return scoreForFeatures(place.features);
  const score = place.features.reduce((sum, id) => sum + (req.weights[id] || 0), 0);
  return Math.min(100, score);
}

function formatVerified(date) {
  if (!date) return "Never verified";
  const diff = Math.max(0, Date.now() - new Date(date).getTime());
  const days = Math.floor(diff / 86400000);
  if (days === 0) return "Verified today";
  if (days === 1) return "Last verified 1 day ago";
  return `Last verified ${days} days ago`;
}


const SEED_PLACES = [
  { id: "p1", name: "Kanaka Durga Temple Approach", lat: 16.5193, lng: 80.6132, features: ["ramp", "elevator", "restroom"], verified: true, verifiedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), verifications: [], businessEmail: null, requestedBy: [] },
  { id: "p2", name: "Benz Circle Metro Stop", lat: 16.5062, lng: 80.648, features: ["ramp", "tactile"], verified: true, verifiedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), verifications: [], businessEmail: null, requestedBy: [] },
  { id: "p3", name: "PVP Square Mall", lat: 16.5, lng: 80.6425, features: ["ramp", "doorway", "restroom", "elevator", "parking"], verified: true, verifiedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), verifications: [], businessEmail: null, requestedBy: [] },
  { id: "p4", name: "Governorpet Bus Stand", lat: 16.5158, lng: 80.6203, features: ["parking"], verified: false, verifiedAt: null, updatedAt: new Date().toISOString(), verifications: [], businessEmail: null, requestedBy: [] },
  { id: "p5", name: "SRR & CVR College Gate", lat: 16.5348, lng: 80.6089, features: ["doorway"], verified: false, verifiedAt: null, updatedAt: new Date().toISOString(), verifications: [], businessEmail: null, requestedBy: [] },
  { id: "p6", name: "One Town Market Lane", lat: 16.5104, lng: 80.6151, features: [], verified: false, verifiedAt: null, updatedAt: new Date().toISOString(), verifications: [], businessEmail: null, requestedBy: [] },
];

const BARRIER_DURATION_MS = 24 * 60 * 60 * 1000; // 24h
const FAST_FORWARD_MULTIPLIER = 2400; // ~40 virtual minutes per real second

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function scoreForFeatures(featureIds) {
  const total = featureIds.reduce((sum, id) => {
    const f = FEATURE_LIBRARY.find((x) => x.id === id);
    return sum + (f ? f.weight : 0);
  }, 0);
  return Math.min(100, total);
}

function scoreColor(score) {
  if (score >= 70) return COLORS.good;
  if (score >= 40) return COLORS.mid;
  return COLORS.bad;
}

function makeDivIcon(color, pulsing) {
  return L.divIcon({
    className: "",
    html: `
      <div style="position:relative;width:22px;height:22px;">
        ${pulsing ? `<div style="position:absolute;inset:-8px;border-radius:50%;background:${color};opacity:0.35;animation:aa-pulse 1.6s ease-out infinite;"></div>` : ""}
        <div style="position:absolute;inset:0;border-radius:50%;background:${color};border:2px solid #15121f;box-shadow:0 0 0 2px ${color}55;"></div>
      </div>
    `,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

function formatCountdown(ms) {
  if (ms <= 0) return "expired";
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function speak(text) {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1;
  window.speechSynthesis.speak(utterance);
}

function describePlaceForVoice(place, score) {
  const featureNames = place.features
    .map((id) => FEATURE_LIBRARY.find((f) => f.id === id)?.label)
    .filter(Boolean);
  const featureText = featureNames.length ? featureNames.join(", ") : "no tagged features yet";
  const barrierText = place.barrier ? "A barrier has been reported here and is still active." : "No active barriers reported.";
  const verifiedText = place.verified ? "This place is verified." : "This place is not yet verified.";
  return `${place.name}. Accessibility score ${score} out of 100. Tagged features: ${featureText}. ${verifiedText} ${barrierText}`;
}

// Straight-line distance in meters between two lat/lng points (haversine).
function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Free geocoding via OpenStreetMap's Nominatim — no key, no billing.
// Please respect Nominatim's usage policy (light traffic only, no bulk use):
// https://operations.osmfoundation.org/policies/nominatim/
async function geocodePlace(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(
    query
  )}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error("Search failed");
  const results = await res.json();
  if (!results.length) return null;
  const top = results[0];
  return { name: top.display_name.split(",")[0] || query, lat: parseFloat(top.lat), lng: parseFloat(top.lon) };
}

// ---------------------------------------------------------------------------
// Map click handler (used only while placing a new tagged pin)
// ---------------------------------------------------------------------------
function MapClickCatcher({ active, onPick }) {
  const map = useMap();

  useEffect(() => {
    const container = map.getContainer();
    if (active) {
      container.style.cursor = "crosshair";
      container.classList.add("aa-map-placing");
    } else {
      container.style.cursor = "";
      container.classList.remove("aa-map-placing");
    }

    return () => {
      container.style.cursor = "";
      container.classList.remove("aa-map-placing");
    };
  }, [active, map]);

  useMapEvents({
    click(e) {
      if (!active) return;
      e.originalEvent?.preventDefault?.();
      onPick({ lat: e.latlng.lat, lng: e.latlng.lng });
    },
  });

  return null;
}

// Pans/zooms the map whenever a new target location comes in (e.g. from search).
function FlyTo({ target }) {
  const map = useMap();
  useEffect(() => {
    if (target) map.flyTo([target.lat, target.lng], 16, { duration: 1.2 });
  }, [target, map]);
  return null;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function AccessAssistApp({ user, onSignOut }) {
  // Real, signed-in identity when available (this app requires login — see
  // App.jsx) — falls back to the anonymous per-browser DEVICE_ID only if
  // Supabase isn't configured at all. Tying confirmations to an account
  // instead of a device ID means clearing browser storage can't manufacture
  // fresh "independent" confirmations.
  const userId = user?.id || DEVICE_ID;
  const userEmail = user?.email || null;

  const [places, setPlaces] = useState(SEED_PLACES);
  const [requirement, setRequirement] = useState("wheelchair");
  const [profileOpen, setProfileOpen] = useState(false);
  const [emergencyOpen, setEmergencyOpen] = useState(false);
  const [businessRequest, setBusinessRequest] = useState(false);
  const [dbStatus, setDbStatus] = useState("local");
  const [contributor, setContributor] = useState({ points: 0, tagged: 0, barriers: 0, confirmed: 0 });
  const [selectedId, setSelectedId] = useState(null);
  const [taggingOpen, setTaggingOpen] = useState(false);
  const [draftFeatures, setDraftFeatures] = useState([]);
  const [placingPin, setPlacingPin] = useState(false);
  const [pendingLocation, setPendingLocation] = useState(null); // {name, lat, lng} — set when tagging comes from search
  const [barrierReportOpen, setBarrierReportOpen] = useState(false);
  const [localBarrierIssues, setLocalBarrierIssues] = useState({});

  const [verifyModalOpen, setVerifyModalOpen] = useState(false);
  const [verifyError, setVerifyError] = useState("");
  const [businessModalOpen, setBusinessModalOpen] = useState(false);
  const [offlineError, setOfflineError] = useState("");

  const [searchText, setSearchText] = useState("");
  const [searchStatus, setSearchStatus] = useState("idle"); // idle | loading | error
  const [unratedResult, setUnratedResult] = useState(null); // {name, lat, lng} — found via search, not yet tagged

  const [fastForward, setFastForward] = useState(false);
  const [voiceMode, setVoiceMode] = useState(false);
  const [offlineState, setOfflineState] = useState(() => {
    try {
      return localStorage.getItem("accessassist_offline_pack") ? "ready" : "idle";
    } catch {
      return "idle";
    }
  }); // idle | downloading | ready
  const [offlineProgress, setOfflineProgress] = useState(0);

  const [virtualNow, setVirtualNow] = useState(() => Date.now());
  const tickRef = useRef(null);

  // Virtual clock — advances faster when Demo Fast-Forward is on so a 24h
  // barrier countdown can visibly run out during a live pitch.
  useEffect(() => {
    tickRef.current = setInterval(() => {
      setVirtualNow((prev) => prev + (fastForward ? FAST_FORWARD_MULTIPLIER * 1000 : 1000));
    }, 1000); // ticks once per real second; fast-forward jumps the virtual clock further per tick
    return () => clearInterval(tickRef.current);
  }, [fastForward]);

  useEffect(() => { localStorage.setItem("accessassist_places", JSON.stringify(places)); }, [places]);

  // Auto-clear expired barriers as the virtual clock passes their expiry.
  useEffect(() => {
    setPlaces((prev) =>
      prev.map((p) => {
        if (p.barrier && p.barrier.expiresAt <= virtualNow) {
          return { ...p, barrier: null };
        }
        return p;
      })
    );
  }, [virtualNow]);

  const selectedPlace = useMemo(() => places.find((p) => p.id === selectedId) || null, [places, selectedId]);

  const lastUpdated = useMemo(() => {
    const timestamps = places.map((p) => p.updatedAt).filter(Boolean).map((d) => new Date(d).getTime()).filter(Number.isFinite);
    return timestamps.length ? new Date(Math.max(...timestamps)) : new Date();
  }, [places]);

  const formatLastUpdated = (date) => {
    if (!date) return "Not available";
    return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(date);
  };

  useEffect(() => {
    const cached = localStorage.getItem("accessassist_places");
    if (cached) { try { setPlaces(JSON.parse(cached)); } catch {} }
    const loadData = async () => {
      if (!supabase) { setDbStatus("local"); return; }
      try {
        const { data, error } = await supabase.from("places").select("*").order("created_at", { ascending: true });
        if (error) throw error;
        if (data?.length) {
          setPlaces(data.map((p) => ({
            ...p,
            features: p.features || [],
            barrier: p.barrier || null,
            verifiedAt: p.verified_at || null,
            requestCount: p.request_count || 0,
            updatedAt: p.updated_at || p.verified_at || null,
            verifications: p.verifications || [],
            businessEmail: p.business_email || null,
            requestedBy: p.requested_by || [],
          })));
        } else {
          for (const p of SEED_PLACES) await supabase.from("places").upsert({ id: p.id, name: p.name, lat: p.lat, lng: p.lng, features: p.features, verified: !!p.verified, verified_at: p.verifiedAt || null, barrier: p.barrier || null, request_count: 0, updated_at: p.updatedAt || new Date().toISOString() });
        }
        setDbStatus("connected");
        const { data: c } = await supabase.from("contributors").select("*").eq("device_id", userId).maybeSingle();
        if (c) setContributor({ points: c.points || 0, tagged: c.tagged || 0, barriers: c.barriers || 0, confirmed: c.confirmed || 0 });
      } catch { setDbStatus("local"); }
    };
    loadData();
  }, [userId]);

  const persistPlace = async (place) => {
    const cached = localStorage.getItem("accessassist_places");
    let current = places;
    if (cached) {
      try { current = JSON.parse(cached); } catch {}
    }
    const exists = current.some((p) => p.id === place.id);
    const nextPlaces = exists ? current.map((p) => p.id === place.id ? place : p) : [...current, place];
    localStorage.setItem("accessassist_places", JSON.stringify(nextPlaces));
    if (!supabase) return;
    try {
      await supabase.from("places").upsert({
        id: place.id, name: place.name, lat: place.lat, lng: place.lng, features: place.features,
        verified: !!place.verified, verified_at: place.verifiedAt || null, barrier: place.barrier || null,
        request_count: place.requestCount || 0, updated_at: place.updatedAt || new Date().toISOString(),
        verifications: place.verifications || [], business_email: place.businessEmail || null,
        requested_by: place.requestedBy || [],
      });
    } catch (err) {
      // Most likely cause: the verifications / business_email / requested_by
      // columns haven't been added to the places table yet (see README).
      // The change still lives in local state + localStorage either way.
      console.warn("Supabase sync skipped (place):", err?.message || err);
    }
  };

  const updateContributor = async (delta) => {
    const next = { points: contributor.points + (delta.points || 0), tagged: contributor.tagged + (delta.tagged || 0), barriers: contributor.barriers + (delta.barriers || 0), confirmed: contributor.confirmed + (delta.confirmed || 0) };
    setContributor(next);
    if (supabase) {
      try {
        await supabase.from("contributors").upsert({ device_id: userId, email: userEmail, ...next });
      } catch (err) {
        console.warn("Supabase sync skipped (contributor):", err?.message || err);
      }
    }
  };

  const selectPlace = useCallback(
    (id) => {
      setSelectedId(id);
      const place = places.find((p) => p.id === id);
      if (place && voiceMode) {
        const score = personalizedScore(place, requirement);
        speak(describePlaceForVoice(place, score));
      }
    },
    [places, voiceMode, requirement]
  );

  const handleSpeakerClick = () => {
    if (!selectedPlace) return;
    const score = personalizedScore(selectedPlace, requirement);
    speak(describePlaceForVoice(selectedPlace, score));
  };

  // Barrier reports are deliberately separate from verified accessibility data.
  // Selecting/fixing a barrier here changes only this website session, not the
  // place's accessibility features and not the Supabase database.
  const getBarrierIssuesForPlace = (place) => {
    if (!place) return [];
    if (Object.prototype.hasOwnProperty.call(localBarrierIssues, place.id)) {
      return localBarrierIssues[place.id];
    }
    return place.barrier?.issues?.length ? place.barrier.issues : [];
  };

  const openBarrierReport = () => {
    if (!selectedPlace) return;
    setLocalBarrierIssues((prev) => ({
      ...prev,
      [selectedPlace.id]: prev[selectedPlace.id] ?? (selectedPlace.barrier?.issues || []),
    }));
    setBarrierReportOpen(true);
  };

  const toggleBarrierIssue = (issueId) => {
    if (!selectedPlace) return;
    const current = getBarrierIssuesForPlace(selectedPlace);
    const next = current.includes(issueId)
      ? current.filter((id) => id !== issueId)
      : [...current, issueId];

    setLocalBarrierIssues((prev) => ({
      ...prev,
      [selectedPlace.id]: next,
    }));
  };

  const fixOneBarrierIssue = (issueId) => {
    if (!selectedPlace) return;
    const current = getBarrierIssuesForPlace(selectedPlace);
    setLocalBarrierIssues((prev) => ({
      ...prev,
      [selectedPlace.id]: current.filter((id) => id !== issueId),
    }));
  };

  const clearAllLocalBarrierIssues = () => {
    if (!selectedPlace) return;
    setLocalBarrierIssues((prev) => ({
      ...prev,
      [selectedPlace.id]: [],
    }));
  };

  const confirmBarrier = (stillPresent) => {
    if (!selectedPlace) return;
    if (!stillPresent) {
      clearAllLocalBarrierIssues();
      return;
    }
  };

  // Opens the "Verify this place" modal instead of instantly flipping the
  // badge. A single tap is not evidence — see submitVerification below.
  const handleVerifyPlace = () => {
    if (!selectedPlace || selectedPlace.verified) return;
    setVerifyError("");
    setVerifyModalOpen(true);
  };

  // Real corroboration: each signed-in account can confirm a place at most
  // once. A place only earns the "Verified" badge once VERIFICATION_THRESHOLD
  // distinct accounts have confirmed it — a photo is optional but strongly
  // encouraged, and is shown to the next person considering confirming.
  const submitVerification = async ({ photo, note }) => {
    if (!selectedPlace) return;
    const existing = selectedPlace.verifications || [];
    if (existing.some((v) => v.userId === userId)) {
      setVerifyError("You've already confirmed this place — thanks for double-checking though!");
      return;
    }
    const entry = { userId, email: userEmail, at: new Date().toISOString(), hasPhoto: !!photo, photo: photo || null, note: note || "" };
    const nextVerifications = [...existing, entry];
    const nowVerified = selectedPlace.verified || nextVerifications.length >= VERIFICATION_THRESHOLD;
    const updated = {
      ...selectedPlace,
      verifications: nextVerifications,
      verified: nowVerified,
      verifiedAt: nowVerified && !selectedPlace.verified ? new Date().toISOString() : selectedPlace.verifiedAt,
      updatedAt: new Date().toISOString(),
    };
    setPlaces((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    persistPlace(updated);
    updateContributor({ points: 5, confirmed: 1 });
    setVerifyModalOpen(false);
    setVerifyError("");
  };

  // Opens the business-request modal — see submitBusinessRequest for what
  // actually happens when the user sends it (mailto:, since a browser app
  // can't send email on its own — see README).
  const requestImprovement = () => {
    if (!selectedPlace) return;
    setBusinessModalOpen(true);
  };

  const submitBusinessRequest = async ({ email, message }) => {
    if (!selectedPlace) return;
    const alreadyRequested = (selectedPlace.requestedBy || []).includes(userId);
    const updated = {
      ...selectedPlace,
      businessEmail: email || selectedPlace.businessEmail || null,
      requestCount: alreadyRequested ? (selectedPlace.requestCount || 0) : (selectedPlace.requestCount || 0) + 1,
      requestedBy: alreadyRequested ? (selectedPlace.requestedBy || []) : [...(selectedPlace.requestedBy || []), userId],
      updatedAt: new Date().toISOString(),
    };
    setPlaces((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    persistPlace(updated);
    setBusinessRequest(true);
    setBusinessModalOpen(false);

    const missing = FEATURE_LIBRARY.filter((f) => !selectedPlace.features.includes(f.id)).map((f) => f.label);
    const activeBarriers = getBarrierIssuesForPlace(selectedPlace).map((id) => BARRIER_LIBRARY.find((b) => b.id === id)?.label).filter(Boolean);
    const subject = `Accessibility improvement request — ${selectedPlace.name}`;
    const bodyLines = [
      `Hi,`,
      ``,
      `A visitor using AccessAssist (a community accessibility map) flagged ${selectedPlace.name} for accessibility improvements.`,
      ``,
      missing.length ? `Currently missing:\n- ${missing.join("\n- ")}` : `No specific missing features tagged.`,
      activeBarriers.length ? `\nActive barrier reports:\n- ${activeBarriers.join("\n- ")}` : ``,
      message ? `\nMessage from the requester:\n${message}` : ``,
      ``,
      `This has now been requested by ${updated.requestCount} user${updated.requestCount === 1 ? "" : "s"} on AccessAssist.`,
      `— Sent via AccessAssist`,
    ].filter(Boolean);
    const body = bodyLines.join("\n");
    const mailto = `mailto:${encodeURIComponent(email || "")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.location.href = mailto;
  };

  const toggleDraftFeature = (id) => {
    setDraftFeatures((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const startTagging = (prefill) => {
    setDraftFeatures([]);
    setPendingLocation(prefill || null);
    setTaggingOpen(true);
  };

  const confirmTaggingAndPlace = () => {
    if (!draftFeatures.length) {
      setPlacingPin(false);
      return;
    }

    setTaggingOpen(false);
    if (pendingLocation) {
      // Came from search — we already know exactly where to put the pin.
      const newPlace = {
        id: `p${Date.now()}`,
        name: pendingLocation.name,
        lat: pendingLocation.lat,
        lng: pendingLocation.lng,
        features: draftFeatures,
        verified: false,
        barrier: null, verifiedAt: null, requestCount: 0, updatedAt: new Date().toISOString(),
        verifications: [], businessEmail: null, requestedBy: [],
      };
      setPlaces((prev) => [...prev, newPlace]);
      persistPlace(newPlace);
      updateContributor({ points: 20, tagged: 1 });
      setSelectedId(newPlace.id);
      setUnratedResult(null);
      setPendingLocation(null);
      setPlacingPin(false);
    } else {
      setPendingLocation(null);
      setUnratedResult(null);
      setSelectedId(null);
      setPlacingPin(true);
    }
  };

  const handleMapPick = (latlng) => {
    if (!latlng || !Number.isFinite(latlng.lat) || !Number.isFinite(latlng.lng)) return;

    const newPlace = {
      id: `p${Date.now()}`,
      name: "New tagged place",
      lat: latlng.lat,
      lng: latlng.lng,
      features: draftFeatures,
      verified: false,
      barrier: null, verifiedAt: null, requestCount: 0, updatedAt: new Date().toISOString(),
      verifications: [], businessEmail: null, requestedBy: [],
    };
    setPlaces((prev) => [...prev, newPlace]);
    persistPlace(newPlace);
    updateContributor({ points: 20, tagged: 1 });
    setPlacingPin(false);
    setSelectedId(newPlace.id);
    setTaggingOpen(false);
    setPendingLocation(null);
  };

  // Free lookup for any place name (VIT-AP, a hostel, a street) via Nominatim.
  // If a tagged place already exists nearby, jump straight to it. Otherwise
  // surface it as "not yet rated" with a one-click path to tag it.
  const handleSearch = async (e) => {
    e.preventDefault();
    if (!searchText.trim()) return;
    setSearchStatus("loading");
    setUnratedResult(null);
    try {
      const result = await geocodePlace(`${searchText}, Andhra Pradesh, India`);
      if (!result) {
        setSearchStatus("error");
        return;
      }
      const nearbyExisting = places.find((p) => distanceMeters(p.lat, p.lng, result.lat, result.lng) < 120);
      setSearchStatus("idle");
      if (nearbyExisting) {
        setSelectedId(nearbyExisting.id);
        setUnratedResult({ ...result, flyOnly: true });
      } else {
        setUnratedResult(result);
        setSelectedId(null);
      }
    } catch (err) {
      setSearchStatus("error");
    }
  };

  // Real offline pack download: actually fetches every tile in the
  // Vijayawada bounding box (see OFFLINE_BBOX/OFFLINE_ZOOMS above) and stores
  // each one in the Cache Storage entry the service worker also uses for
  // tiles, in small throttled batches. Place/rating data doesn't need this
  // step — it's already kept in localStorage and survives offline on its
  // own — this only covers map imagery, which the browser has no built-in
  // caching for.
  const startOfflineDownload = async () => {
    setOfflineError("");
    if (!("caches" in window)) {
      setOfflineError("This browser doesn't support offline caching.");
      return;
    }
    setOfflineState("downloading");
    setOfflineProgress(0);

    const tileUrls = buildOfflineTileList();
    const cache = await caches.open(OFFLINE_TILE_CACHE);
    let done = 0;
    let failed = 0;

    for (let i = 0; i < tileUrls.length; i += OFFLINE_BATCH_SIZE) {
      const batch = tileUrls.slice(i, i + OFFLINE_BATCH_SIZE);
      await Promise.all(
        batch.map(async (url) => {
          try {
            const existing = await cache.match(url);
            if (!existing) {
              const response = await fetch(url, { mode: "cors" }).catch(() => fetch(url, { mode: "no-cors" }));
              await cache.put(url, response);
            }
          } catch {
            failed += 1;
          } finally {
            done += 1;
          }
        })
      );
      setOfflineProgress(Math.round((done / tileUrls.length) * 100));
      // Small pause between batches — a deliberate throttle so this stays
      // "light use" against OSM's tile servers rather than a burst download.
      await new Promise((r) => setTimeout(r, OFFLINE_BATCH_DELAY_MS));
    }

    localStorage.setItem("accessassist_offline_pack", JSON.stringify({ downloadedAt: new Date().toISOString(), tiles: tileUrls.length, failed }));
    setOfflineProgress(100);
    setOfflineState("ready");
    if (failed > 0) setOfflineError(`${failed} of ${tileUrls.length} tiles couldn't be cached (you may be offline right now, or rate-limited) — the rest are saved.`);
  };

  const draftScore = scoreForFeatures(draftFeatures);

  return (
    <div className="aa-dashboard" style={styles.app}>
      <div className="aa-dynamic-background" aria-hidden="true">
        <div className="aa-bg-orb aa-bg-orb-1" />
        <div className="aa-bg-orb aa-bg-orb-2" />
        <div className="aa-bg-orb aa-bg-orb-3" />
        <div className="aa-bg-grid" />
        <div className="aa-bg-symbols">
          <span className="aa-bg-symbol s1">&lt;/&gt;</span>
          <span className="aa-bg-symbol s2">&#123; &#125;</span>
          <span className="aa-bg-symbol s3">&#9889;</span>
          <span className="aa-bg-symbol s4">&#9673;</span>
          <span className="aa-bg-symbol s5">&#9825;</span>
          <span className="aa-bg-symbol s6">&#35;</span>
          <span className="aa-bg-symbol s7">&#64;</span>
          <span className="aa-bg-symbol s8">&#9830;</span>
          <span className="aa-bg-symbol s9">&#128246;</span>
          <span className="aa-bg-symbol s10">&#128205;</span>
          <span className="aa-bg-symbol s11">&#9881;</span>
          <span className="aa-bg-symbol s12">&#43;</span>
          <span className="aa-bg-symbol s13">&#8734;</span>
          <span className="aa-bg-symbol s14">&#10024;</span>
          <span className="aa-bg-symbol s15">&#9745;</span>
          <span className="aa-bg-symbol s16">&#9875;</span>
        </div>
        <div className="aa-bg-data-line line1" />
        <div className="aa-bg-data-line line2" />
        <div className="aa-bg-scan" />
      </div>

      <div className="aa-live-shine" aria-hidden="true">
        <div className="aa-shine-orb aa-shine-orb-1" />
        <div className="aa-shine-orb aa-shine-orb-2" />
        <div className="aa-shine-orb aa-shine-orb-3" />
        <div className="aa-shine-wave aa-shine-wave-1" />
        <div className="aa-shine-wave aa-shine-wave-2" />
        <div className="aa-shine-glass" />
      </div>

      <style>{`
        @keyframes aa-pulse {
          0% { transform: scale(0.6); opacity: 0.45; }
          100% { transform: scale(1.6); opacity: 0; }
        }
        .leaflet-container { background: ${COLORS.bg} !important; font-family: inherit; }
        .leaflet-control-attribution { background: rgba(21,18,31,0.75) !important; color: ${COLORS.textDim} !important; }
        .leaflet-control-attribution a { color: ${COLORS.textDim} !important; }
        .leaflet-control-zoom a { background: ${COLORS.panel} !important; color: ${COLORS.text} !important; border-color: ${COLORS.panelBorder} !important; }
        .leaflet-popup-content-wrapper { background: ${COLORS.panel} !important; color: ${COLORS.text} !important; border: 1px solid ${COLORS.panelBorder}; border-radius: 10px !important; box-shadow: 0 8px 24px rgba(0,0,0,0.45) !important; }
        .leaflet-popup-tip { background: ${COLORS.panel} !important; border: 1px solid ${COLORS.panelBorder}; }
        .leaflet-popup-content { margin: 10px 12px !important; }
        .leaflet-popup-close-button { color: ${COLORS.textDim} !important; }
      `}</style>

      <header className="aa-header" style={styles.header}>
        <div>
          <div style={styles.brand}>AccessAssist</div>
          <div style={styles.brandSub}>Community-powered accessibility map</div>
        </div>
        <div className="aa-header-controls" style={styles.headerControls}>
          <div style={styles.dbBadge}>{dbStatus === "connected" ? "● Database connected" : "● Demo database"}</div>
          <div className="aa-last-updated" title="Latest accessibility data update">🕒 <span>Last updated</span> <strong>{formatLastUpdated(lastUpdated)}</strong></div>
          <button type="button" className="aa-hero-button" style={styles.toggle} onClick={() => setProfileOpen(true)} aria-haspopup="dialog" aria-label="Open Accessibility Hero">👤 Accessibility Hero</button>
          <ToggleButton label="Demo Fast-Forward" active={fastForward} onClick={() => setFastForward((v) => !v)} />
          <ToggleButton label="Voice-Guided Mode" active={voiceMode} onClick={() => setVoiceMode((v) => !v)} />
          <OfflineControl state={offlineState} progress={offlineProgress} error={offlineError} onStart={startOfflineDownload} />
          {onSignOut && (
            <button className="aa-signout-inside" onClick={onSignOut} title="Sign out">
              ↪ Sign Out
            </button>
          )}
        </div>
      </header>
      <div className="aa-requirement-bar" style={styles.requirementBar}>
        <span style={{fontSize:12,color:COLORS.textDim}}>Accessible for me:</span>
        {REQUIREMENTS.map((r) => <button key={r.id} onClick={() => setRequirement(r.id)} style={{...styles.reqChip, ...(requirement === r.id ? styles.reqActive : {})}}>{r.icon} {r.label}</button>)}
        <div className="aa-accessibility-key" aria-label="Accessibility key">
          <div className="aa-key-title">♿ KEY</div>
          <div className="aa-key-items">
            <span><i className="aa-key-dot aa-key-green" /> Accessible</span>
            <span><i className="aa-key-dot aa-key-yellow" /> Partial</span>
            <span><i className="aa-key-dot aa-key-red" /> Limited</span>
            <span><i className="aa-key-dot aa-key-gray" /> Not Tagged</span>
          </div>
        </div>
      </div>

      <div className="aa-dashboard-body" style={styles.body}>
        <div className="aa-map-wrap" style={styles.mapWrap}>
          <MapContainer
            center={VIJAYAWADA_CENTER}
            zoom={13}
            style={{ width: "100%", height: "100%" }}
            zoomControl={true}
          >
            <TileLayer
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            />
            <MapClickCatcher active={placingPin} onPick={handleMapPick} />
            {unratedResult && <FlyTo target={unratedResult} />}
            {unratedResult && !unratedResult.flyOnly && (
              <Marker
                position={[unratedResult.lat, unratedResult.lng]}
                icon={makeDivIcon(COLORS.textDim, false)}
              >
                <Popup closeButton={false} offset={[0, -6]}>
                  <div style={{ minWidth: 160 }}>
                    <div style={{ fontWeight: 700, fontSize: 13 }}>{unratedResult.name}</div>
                    <div style={{ fontSize: 12, color: COLORS.textDim, marginTop: 4 }}>
                      No accessibility score yet — you are the first to tag it
                    </div>
                    <button
                      type="button"
                      style={{ ...styles.primaryButton, marginTop: 8, width: "100%", fontSize: 12, padding: "6px 10px" }}
                      onClick={() => startTagging(unratedResult)}
                    >
                      Tag this place
                    </button>
                  </div>
                </Popup>
              </Marker>
            )}
            {places.map((p) => {
              const score = personalizedScore(p, requirement);
              const color = p.barrier ? COLORS.bad : scoreColor(score);
              return (
                <Marker
                  key={p.id}
                  position={[p.lat, p.lng]}
                  icon={makeDivIcon(color, !!p.barrier)}
                  eventHandlers={{ click: () => selectPlace(p.id) }}
                >
                  <Popup closeButton={false} offset={[0, -6]}>
                    <div style={{ minWidth: 140 }}>
                      <div style={{ fontWeight: 700, fontSize: 13 }}>{p.name}</div>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                        <span style={{ color, fontWeight: 700, fontSize: 15 }}>{score}</span>
                        <span style={{ fontSize: 11, color: COLORS.textDim }}>/ 100</span>
                        {p.verified && <span style={{ fontSize: 11, color: COLORS.good, marginLeft: "auto" }}>✓ Verified</span>}
                      </div>
                      {p.barrier && (
                        <div style={{ fontSize: 11, color: COLORS.bad, marginTop: 4, fontWeight: 600 }}>
                          ⚠ Barrier active
                        </div>
                      )}
                    </div>
                  </Popup>
                </Marker>
              );
            })}
          </MapContainer>

          {placingPin && (
            <div style={styles.placingBanner}>📍 Placement mode: click anywhere on the map to add your new place</div>
          )}

          <form className="aa-search-bar" style={styles.searchBar} onSubmit={handleSearch}>
            <input
              style={styles.searchInput}
              type="text"
              placeholder="Search any place — VIT-AP, a hostel, a street…"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
            />
            <button style={styles.searchButton} type="submit" disabled={searchStatus === "loading"}>
              {searchStatus === "loading" ? "Searching…" : "Search"}
            </button>
          </form>
          {searchStatus === "error" && (
            <div style={styles.searchError}>Couldn't find that place — try a more specific name.</div>
          )}
        </div>

        <div className="aa-side-panel-shell">
        <SidePanel
          place={selectedPlace}
          virtualNow={virtualNow}
          requirement={requirement}
          onReportBarrier={openBarrierReport}
          barrierIssues={selectedPlace ? getBarrierIssuesForPlace(selectedPlace) : []}
          onToggleBarrierIssue={toggleBarrierIssue}
          onFixBarrierIssue={fixOneBarrierIssue}
          onRequestImprovement={requestImprovement}
          onVerifyPlace={handleVerifyPlace}
          onSpeak={handleSpeakerClick}
          userId={userId}
        />
        </div>
      </div>

      <button
        type="button"
        className="aa-tag-place-fixed"
        onClick={() => {
          setPlacingPin(false);
          setPendingLocation(null);
          setUnratedResult(null);
          setDraftFeatures([]);
          setTaggingOpen(true);
        }}
        aria-label="Tag a new place"
      >
        ＋ Tag a Place
      </button>

      <button
        className="aa-emergency-button aa-emergency-button-fixed"
        style={{
          position: "fixed",
          left: "50%",
          right: "auto",
          bottom: 22,
          width: "max-content",
          maxWidth: "calc(100vw - 32px)",
          height: 52,
          minHeight: 52,
          margin: 0,
          padding: "0 26px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          transform: "translateX(-50%)",
          zIndex: 999999,
          borderRadius: 999,
          background: "linear-gradient(135deg,#ff3f70,#d7265b)",
          color: "#fff",
          border: "1px solid rgba(255,255,255,.22)",
          fontSize: 14,
          fontWeight: 800,
          lineHeight: 1,
          whiteSpace: "nowrap",
          boxSizing: "border-box",
          boxShadow: "0 12px 35px rgba(239,71,111,.30),0 0 22px rgba(255,72,120,.12)",
          cursor: "pointer"
        }}
        onClick={() => setEmergencyOpen(true)}
      >
        🚨 I Need Accessibility Now
      </button>

      {profileOpen && <ProfileModal contributor={contributor} onClose={() => setProfileOpen(false)} />}
      {emergencyOpen && (
        <EmergencyModal
          places={places}
          selectedPlace={selectedPlace}
          searchResult={unratedResult}
          requirement={requirement}
          onClose={() => setEmergencyOpen(false)}
        />
      )}

      {barrierReportOpen && selectedPlace && (
        <BarrierReportModal
          place={selectedPlace}
          selectedIssues={getBarrierIssuesForPlace(selectedPlace)}
          onToggle={toggleBarrierIssue}
          onClose={() => setBarrierReportOpen(false)}
          onDone={() => setBarrierReportOpen(false)}
        />
      )}

      {taggingOpen && (
        <TaggingModal
          draftFeatures={draftFeatures}
          draftScore={draftScore}
          onToggle={toggleDraftFeature}
          onCancel={() => setTaggingOpen(false)}
          onConfirm={confirmTaggingAndPlace}
        />
      )}

      {verifyModalOpen && selectedPlace && (
        <VerifyModal
          place={selectedPlace}
          error={verifyError}
          onCancel={() => { setVerifyModalOpen(false); setVerifyError(""); }}
          onSubmit={submitVerification}
        />
      )}

      {businessModalOpen && selectedPlace && (
        <BusinessRequestModal
          place={selectedPlace}
          onCancel={() => setBusinessModalOpen(false)}
          onSubmit={submitBusinessRequest}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------
function ToggleButton({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        ...styles.toggle,
        background: active ? COLORS.accent : COLORS.panel,
        borderColor: active ? COLORS.accent : COLORS.panelBorder,
        color: active ? "#100c1c" : COLORS.text,
      }}
    >
      {label}
    </button>
  );
}

function OfflineControl({ state, progress, error, onStart }) {
  if (state === "idle") {
    return (
      <button style={styles.toggle} onClick={onStart} title="Downloads map tiles for central Vijayawada so the map works with no internet">
        Enable Offline Mode
      </button>
    );
  }
  if (state === "downloading") {
    return (
      <div style={{ ...styles.toggle, display: "flex", alignItems: "center", gap: 8, cursor: "default" }}>
        <div style={styles.progressTrack}>
          <div style={{ ...styles.progressFill, width: `${progress}%` }} />
        </div>
        <span style={{ fontSize: 12, color: COLORS.textDim }}>{progress}%</span>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
      <button
        style={{ ...styles.toggle, background: COLORS.good, color: "#0c2018", borderColor: COLORS.good }}
        onClick={onStart}
        title="Click to re-download the offline pack"
      >
        ✓ Offline: Vijayawada Pack Ready
      </button>
      {error && <span style={{ fontSize: 10, color: COLORS.mid, maxWidth: 220, textAlign: "right" }}>{error}</span>}
    </div>
  );
}

function SidePanel({ place, virtualNow, requirement, onReportBarrier, barrierIssues, onToggleBarrierIssue, onFixBarrierIssue, onRequestImprovement, onVerifyPlace, onSpeak, userId }) {
  if (!place) {
    return (
      <aside style={{ ...styles.panel, position: "relative", overflow: "hidden" }}>
        <div className="aa-empty-panel-visual" aria-hidden="true">
          <div className="aa-empty-radar" />
          <div className="aa-empty-orbit aa-empty-orbit-1">
            <span>🌐</span>
          </div>
          <div className="aa-empty-orbit aa-empty-orbit-2">
            <span>📍</span>
          </div>
          <div className="aa-empty-orbit aa-empty-orbit-3">
            <span>🗺️</span>
          </div>
          <div className="aa-empty-float aa-empty-browser">
            <span className="aa-mini-dot" /> WEB
          </div>
          <div className="aa-empty-float aa-empty-map">
            <span className="aa-mini-dot" /> MAP
          </div>
          <div className="aa-empty-float aa-empty-access">
            <span className="aa-mini-dot" /> ACCESS
          </div>
          <div className="aa-empty-crosshair">+</div>
        </div>

        <div className="aa-empty-panel-copy">
          <div className="aa-empty-title">📍 Explore accessibility</div>
          <div className="aa-empty-text">Tap a pin on the map to see its accessibility details.</div>
          <div className="aa-empty-hint">Live map · Community data · Accessibility insights</div>
        </div>
      </aside>
    );
  }

  const score = personalizedScore(place, requirement);
  const color = scoreColor(score);
  const remaining = place.barrier ? place.barrier.expiresAt - virtualNow : 0;

  return (
    <aside style={styles.panel}>
      <div style={styles.panelHeaderRow}>
        <h2 style={{ ...styles.panelTitle, color: COLORS.text }}>
  📍 {place.name}</h2>
        <button style={styles.speakerButton} onClick={onSpeak} aria-label="Read details aloud">
          🔊
        </button>
      </div>

      {place.verified ? (
        <span style={styles.verifiedBadge}>✓ Verified · {formatVerified(place.verifiedAt)}</span>
      ) : (
        <div style={styles.verifyBox}>
          <div style={{ fontWeight: 700, color: COLORS.mid }}>🟡 Community data — not yet verified</div>
          <div style={{ fontSize: 12, color: COLORS.textDim, marginTop: 4 }}>
            {(place.verifications?.length || 0)} of {VERIFICATION_THRESHOLD} independent confirmations so far.
            {place.verifications?.some((v) => v.hasPhoto) ? " Includes photo evidence." : " Help confirm this location's accessibility information."}
          </div>
          <button style={styles.verifyButton} onClick={onVerifyPlace}>
            ✓ Confirm this place
          </button>
        </div>
      )}

      <div style={styles.scoreRow}>
        <div style={{ ...styles.scoreCircle, borderColor: color, color }}>{score}</div>
        <div>
          <div style={{ color, fontWeight: 600 }}>{REQUIREMENTS.find((r) => r.id === requirement)?.icon} {REQUIREMENTS.find((r) => r.id === requirement)?.label} suitability</div>
          <div style={{ color: COLORS.textDim, fontSize: 13 }}>out of 100</div>
        </div>
      </div>

      <div style={styles.chipRow}>
        {FEATURE_LIBRARY.map((f) => {
          const has = place.features.includes(f.id);
          return (
            <span
              key={f.id}
              style={{
                ...styles.chip,
                opacity: has ? 1 : 0.35,
                borderColor: has ? COLORS.accent : COLORS.panelBorder,
              }}
            >
              {f.label}
            </span>
          );
        })}
      </div>

      {barrierIssues.length ? (
        <div style={styles.barrierBox}>
          <div style={{ fontWeight: 700, color: COLORS.bad }}>⚠️ Reported barrier problems <span style={{ fontSize: 10, color: COLORS.mid, marginLeft: 6 }}>• pending report</span></div>
          <div style={{ fontSize: 12, color: COLORS.textDim, marginTop: 5 }}>Fix only the problem that has actually been resolved.</div>
          <div style={{ display: "grid", gap: 7, marginTop: 10 }}>
            {barrierIssues.map((id) => {
              const item = BARRIER_LIBRARY.find((x) => x.id === id);
              if (!item) return null;
              return (
                <div key={id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "8px 9px", borderRadius: 8, background: "rgba(239,91,124,0.08)", border: `1px solid ${COLORS.bad}55` }}>
                  <span style={{ fontSize: 12, color: COLORS.text }}>{item.icon} {item.label}</span>
                  <button style={styles.fixedButton} onClick={() => onFixBarrierIssue(id)}>Fix this</button>
                </div>
              );
            })}
          </div>
          <button style={{ ...styles.barrierButton, marginTop: 10 }} onClick={onReportBarrier}>Select / unselect barrier problems</button>
          <div style={{ fontSize: 11, color: COLORS.textDim, marginTop: 8 }}>These changes are manual for this website session and are not written to the database.</div>
        </div>
      ) : (
        <div>
          <button style={styles.barrierButton} onClick={onReportBarrier}>
            Report a Barrier
          </button>
          <div style={{ fontSize: 11, color: COLORS.textDim, marginTop: 7 }}>Choose the exact problem manually. Nothing is saved to the database.</div>
        </div>
      )}

      <div style={styles.requestBox}>
        <div style={{ fontWeight: 700 }}>🏢 Business Accessibility Request</div>
        <div style={{ fontSize: 12, color: COLORS.textDim, marginTop: 4 }}>
          Missing improvements? {place.requestCount || 0} users have requested better accessibility.
        </div>
        <button style={styles.primaryButton} onClick={onRequestImprovement}>
          {(place.requestedBy || []).includes(userId) ? "Send another request" : "Request Improvement"}
        </button>
      </div>
    </aside>
  );
}

function ProfileModal({ contributor, onClose }) {
  const level = contributor.points >= 100 ? 3 : contributor.points >= 50 ? 2 : 1;
  const badge = contributor.points >= 100
    ? "🥇 Accessibility Hero"
    : contributor.points >= 50
      ? "🥈 Accessibility Advocate"
      : "🥉 Helper";

  useEffect(() => {
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = oldOverflow;
    };
  }, []);

  return (
    <div
      className="aa-hero-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="aa-hero-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="aa-hero-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="aa-hero-modal-header">
          <div>
            <div className="aa-hero-kicker">YOUR CONTRIBUTION</div>
            <h3 id="aa-hero-title">👤 Accessibility Hero</h3>
            <div className="aa-hero-level">Level {level} · ⭐ {contributor.points} points</div>
          </div>
          <button type="button" className="aa-hero-x" onClick={onClose} aria-label="Close Accessibility Hero">✕</button>
        </div>

        <div className="aa-hero-stats">
          <div className="aa-hero-stat">
            <span>📍</span>
            <b>{contributor.tagged}</b>
            <small>places tagged</small>
          </div>
          <div className="aa-hero-stat">
            <span>⚠️</span>
            <b>{contributor.barriers}</b>
            <small>barriers reported</small>
          </div>
          <div className="aa-hero-stat">
            <span>✓</span>
            <b>{contributor.confirmed}</b>
            <small>reports confirmed</small>
          </div>
        </div>

        <div className="aa-hero-badge">{badge}</div>

        <button type="button" className="aa-hero-close" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

function EmergencyModal({ places, selectedPlace, searchResult, requirement, onClose }) {
  const target = selectedPlace || (searchResult ? { name: searchResult.name, lat: searchResult.lat, lng: searchResult.lng } : null);
  const MAX_DISTANCE_METERS = 2000;
  const req = REQUIREMENTS.find((r) => r.id === requirement) || REQUIREMENTS[0];

  const items = useMemo(() => {
    if (!target || !Number.isFinite(Number(target.lat)) || !Number.isFinite(Number(target.lng))) return [];

    return places
      .map((place) => {
        const distance = distanceMeters(
          Number(target.lat),
          Number(target.lng),
          Number(place.lat),
          Number(place.lng)
        );
        const relevantFeatures = (place.features || []).filter((id) => (req.weights[id] || 0) > 0);
        return {
          ...place,
          distance,
          relevantFeatures,
          score: personalizedScore(place, req.id),
        };
      })
      .filter(
        (place) =>
          Number.isFinite(place.distance) &&
          place.distance > 10 &&
          place.distance <= MAX_DISTANCE_METERS &&
          place.relevantFeatures.length > 0
      )
      .sort((a, b) => a.distance - b.distance);
  }, [places, target, req]);

  const formatDistance = (meters) => {
    if (meters < 1000) return `${Math.round(meters)} m`;
    return `${(meters / 1000).toFixed(1)} km`;
  };

  return (
    <div className="aa-emergency-overlay" onClick={onClose}>
      <div className="aa-emergency-modal" onClick={(e) => e.stopPropagation()}>
        <div className="aa-emergency-header">
          <div className="aa-emergency-icon">🚨</div>
          <div className="aa-emergency-title-wrap">
            <h2>Accessibility Nearby</h2>
            <p>
              {target
                ? `${req.icon} ${req.label} · within 2 km of ${target.name}`
                : `${req.icon} ${req.label} · search a place first`}
            </p>
          </div>
        </div>

        <div className="aa-emergency-context">
          {target
            ? `Showing tagged places with relevant ${req.label.toLowerCase()} facilities within a 2 km radius.`
            : "Search for a location or select a map pin to find nearby accessible places."}
        </div>

        {items.length === 0 ? (
          <div className="aa-emergency-empty">
            <div className="aa-emergency-empty-icon">📍</div>
            <strong>
              {target
                ? `No tagged ${req.label.toLowerCase()} facilities within 2 km.`
                : "No location selected yet."}
            </strong>
            <div>
              {target
                ? "Try another place or tag accessible facilities near this location."
                : "Search for a place first, then open Accessibility Nearby."}
            </div>
          </div>
        ) : (
          <div className="aa-emergency-list">
            {items.map((place) => (
              <div key={place.id} className="aa-emergency-item">
                <div className="aa-emergency-item-text">
                  <div className="aa-emergency-type">
                    {place.relevantFeatures
                      .map((id) => {
                        const feature = FEATURE_LIBRARY.find((f) => f.id === id);
                        return feature ? feature.label : null;
                      })
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                  <div className="aa-emergency-place">{place.name}</div>
                  <div className="aa-emergency-meta">
                    Score {place.score}/100{place.verified ? " · ✓ Verified" : " · Not verified"}
                  </div>
                </div>
                <div className="aa-emergency-distance">{formatDistance(place.distance)}</div>
              </div>
            ))}
          </div>
        )}

        <button type="button" className="aa-emergency-close" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

function BarrierReportModal({ place, selectedIssues, onToggle, onClose, onDone }) {
  const reportRef = useRef(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    reportRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  const selectedCount = selectedIssues.length;

  return (
    <div
      className="aa-report-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="aa-report-title"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="aa-report-dialog"
        ref={reportRef}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="aa-report-header">
          <div>
            <div className="aa-report-kicker">COMMUNITY REPORT</div>
            <h3 id="aa-report-title">Report a Barrier</h3>
            <p>Select only the problems you can actually see at <strong>{place.name}</strong>.</p>
          </div>
          <button className="aa-report-close" onClick={onClose} aria-label="Close barrier report">✕</button>
        </div>

        <div className="aa-report-principle">
          <span className="aa-report-principle-icon">✓</span>
          <div>
            <strong>Report ≠ accessibility change</strong>
            <div>Your report is shown as a local pending report. The accessibility score and tagged features stay unchanged until verification.</div>
          </div>
        </div>

        <div className="aa-report-count">
          <span>{selectedCount} problem{selectedCount === 1 ? "" : "s"} selected</span>
          <span className="aa-report-local">This website only</span>
        </div>

        <div className="aa-report-options" role="group" aria-label="Barrier problems">
          {BARRIER_LIBRARY.map((item) => {
            const checked = selectedIssues.includes(item.id);
            return (
              <label key={item.id} className={`aa-report-option ${checked ? "is-selected" : ""}`}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggle(item.id)}
                />
                <span className="aa-report-check" aria-hidden="true">{checked ? "✓" : ""}</span>
                <span className="aa-report-option-icon">{item.icon}</span>
                <span className="aa-report-option-text">{item.label}</span>
              </label>
            );
          })}
        </div>

        <div className="aa-report-footer-note">
          You can return later, unselect one problem, or use <strong>Fix this</strong> for only the problem that was resolved.
          Nothing here writes barrier changes to the database.
        </div>

        <div className="aa-report-actions">
          <button className="aa-report-clear" onClick={() => selectedCount && selectedIssues.forEach((id) => onToggle(id))} disabled={!selectedCount}>
            Clear selection
          </button>
          <button className="aa-report-save" onClick={onDone}>
            Done <span>→</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function TaggingModal({ draftFeatures, draftScore, onToggle, onCancel, onConfirm }) {
  const color = scoreColor(draftScore);
  return (
    <div className="aa-tagging-overlay" style={{ ...styles.modalOverlay, zIndex: 1000000, pointerEvents: "auto" }}>
      <div className="aa-tagging-modal" style={{ ...styles.modal, pointerEvents: "auto" }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: 0, color: COLORS.text }}>Tag a place</h3>
        <p style={{ color: COLORS.textDim, fontSize: 13, marginTop: 4 }}>
          Select the features present at this location.
        </p>

        <div style={styles.modalScorePreview}>
          <div style={{ ...styles.scoreCircle, borderColor: color, color, width: 48, height: 48, fontSize: 16 }}>
            {draftScore}
          </div>
          <span style={{ color: COLORS.textDim, fontSize: 13 }}>Live score preview</span>
        </div>

        <div style={styles.checkList}>
          {FEATURE_LIBRARY.map((f) => (
            <label key={f.id} style={styles.checkRow}>
              <input
                type="checkbox"
                checked={draftFeatures.includes(f.id)}
                onChange={() => onToggle(f.id)}
              />
              <span>{f.label}</span>
            </label>
          ))}
        </div>

        <div style={styles.modalActions}>
          <button style={styles.secondaryButton} onClick={onCancel}>
            Cancel
          </button>
          <button style={styles.primaryButton} onClick={onConfirm}>
            Place pin on map
          </button>
        </div>
      </div>
    </div>
  );
}

function VerifyModal({ place, error, onCancel, onSubmit }) {
  const [photoPreview, setPhotoPreview] = useState(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState("");

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLocalError("");
    try {
      const compressed = await compressPhotoFile(file);
      setPhotoPreview(compressed);
    } catch {
      setLocalError("Couldn't read that photo — try a different file.");
    }
  };

  const submit = async () => {
    setBusy(true);
    await onSubmit({ photo: photoPreview, note });
    setBusy(false);
  };

  const priorConfirmations = place.verifications || [];

  return (
    <div className="aa-verify-overlay" style={{ ...styles.modalOverlay, zIndex: 1000000 }} onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div style={styles.modal} onMouseDown={(e) => e.stopPropagation()}>
        <h3 style={{ margin: 0, color: COLORS.text }}>Confirm accessibility at {place.name}</h3>
        <p style={{ color: COLORS.textDim, fontSize: 13, marginTop: 6 }}>
          {priorConfirmations.length} of {VERIFICATION_THRESHOLD} confirmations so far. A photo isn't required, but it
          helps the next person trust the report — and helps moderators spot bad-faith submissions.
        </p>

        {priorConfirmations.length > 0 && (
          <div style={{ fontSize: 12, color: COLORS.textDim, marginTop: 4, marginBottom: 10 }}>
            Already confirmed by {priorConfirmations.length} other account{priorConfirmations.length === 1 ? "" : "s"}
            {priorConfirmations.some((v) => v.hasPhoto) ? ", including photo evidence." : "."}
          </div>
        )}

        <label style={{ display: "block", fontSize: 13, color: COLORS.text, marginTop: 8 }}>
          Add a photo (optional but recommended)
          <input type="file" accept="image/*" capture="environment" onChange={handleFile} style={{ display: "block", marginTop: 6, fontSize: 12, color: COLORS.textDim }} />
        </label>
        {photoPreview && (
          <img src={photoPreview} alt="Verification evidence preview" style={{ marginTop: 10, maxWidth: "100%", borderRadius: 8, border: `1px solid ${COLORS.panelBorder}` }} />
        )}

        <label style={{ display: "block", fontSize: 13, color: COLORS.text, marginTop: 14 }}>
          Note (optional)
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Ramp was clear and usable as of today"
            rows={2}
            style={{ width: "100%", marginTop: 6, padding: 8, borderRadius: 8, border: `1px solid ${COLORS.panelBorder}`, background: COLORS.chip, color: COLORS.text, fontSize: 13, resize: "vertical", boxSizing: "border-box" }}
          />
        </label>

        {(localError || error) && <div style={{ color: COLORS.bad, fontSize: 12, marginTop: 10 }}>{localError || error}</div>}

        <div style={styles.modalActions}>
          <button style={styles.secondaryButton} onClick={onCancel}>Cancel</button>
          <button style={styles.primaryButton} onClick={submit} disabled={busy}>
            {busy ? "Submitting…" : "Submit confirmation"}
          </button>
        </div>
      </div>
    </div>
  );
}

function BusinessRequestModal({ place, onCancel, onSubmit }) {
  const [email, setEmail] = useState(place.businessEmail || "");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const missing = FEATURE_LIBRARY.filter((f) => !place.features.includes(f.id)).map((f) => f.label);

  const buildBody = () => {
    const lines = [
      `Hi,`,
      ``,
      `A visitor using AccessAssist flagged ${place.name} for accessibility improvements.`,
      ``,
      missing.length ? `Currently missing:\n- ${missing.join("\n- ")}` : `No specific missing features tagged.`,
      message ? `\nMessage from the requester:\n${message}` : ``,
      ``,
      `— Sent via AccessAssist`,
    ].filter(Boolean);
    return lines.join("\n");
  };

  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(`Subject: Accessibility improvement request — ${place.name}\n\n${buildBody()}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    await onSubmit({ email: email.trim(), message: message.trim() });
    setBusy(false);
  };

  return (
    <div className="aa-business-overlay" style={{ ...styles.modalOverlay, zIndex: 1000000 }} onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div style={styles.modal} onMouseDown={(e) => e.stopPropagation()}>
        <h3 style={{ margin: 0, color: COLORS.text }}>Request improvement at {place.name}</h3>
        <p style={{ color: COLORS.textDim, fontSize: 13, marginTop: 6 }}>
          This opens your email app with a pre-filled message — AccessAssist doesn't send email on its own.
          If you know the business's contact email, add it below so it's remembered for next time.
        </p>

        <label style={{ display: "block", fontSize: 13, color: COLORS.text, marginTop: 10 }}>
          Business email (optional)
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="owner@business.com"
            style={{ width: "100%", marginTop: 6, padding: 8, borderRadius: 8, border: `1px solid ${COLORS.panelBorder}`, background: COLORS.chip, color: COLORS.text, fontSize: 13, boxSizing: "border-box" }}
          />
        </label>

        <label style={{ display: "block", fontSize: 13, color: COLORS.text, marginTop: 12 }}>
          Add a message (optional)
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={3}
            placeholder="Anything specific you'd like them to know"
            style={{ width: "100%", marginTop: 6, padding: 8, borderRadius: 8, border: `1px solid ${COLORS.panelBorder}`, background: COLORS.chip, color: COLORS.text, fontSize: 13, resize: "vertical", boxSizing: "border-box" }}
          />
        </label>

        <div style={{ fontSize: 11, color: COLORS.textDim, marginTop: 10 }}>
          No email app configured, or on a shared computer? Use "Copy request text" and paste it wherever you'll actually send it.
        </div>

        <div style={styles.modalActions}>
          <button style={styles.secondaryButton} onClick={copyText}>{copied ? "Copied ✓" : "Copy request text"}</button>
          <button style={styles.secondaryButton} onClick={onCancel}>Cancel</button>
          <button style={styles.primaryButton} onClick={submit} disabled={busy}>
            {busy ? "Opening…" : "Send via email"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const styles = {
  app: {
    fontFamily: "'Segoe UI', system-ui, sans-serif",
    background: COLORS.bg,
    color: COLORS.text,
    width: "100%",
    minHeight: "100vh",
    height: "auto",
    display: "flex",
    flexDirection: "column",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "14px 20px",
    borderBottom: `1px solid ${COLORS.panelBorder}`,
    flexWrap: "wrap",
    gap: 12,
  },
  brand: { fontSize: 20, fontWeight: 700, letterSpacing: 0.2 },
  brandSub: { fontSize: 12, color: COLORS.textDim, marginTop: 2 },
  headerControls: { display: "flex", gap: 8, flexWrap: "wrap" },
  toggle: {
    border: `1px solid ${COLORS.panelBorder}`,
    background: COLORS.panel,
    color: COLORS.text,
    borderRadius: 8,
    padding: "8px 12px",
    fontSize: 13,
    cursor: "pointer",
  },
  progressTrack: { width: 60, height: 6, borderRadius: 4, background: COLORS.panelBorder, overflow: "hidden" },
  progressFill: { height: "100%", background: COLORS.accent, transition: "width 0.15s linear" },
  requirementBar: { display: "flex", gap: 7, padding: "8px 14px", borderBottom: `1px solid ${COLORS.panelBorder}`, overflowX: "auto", alignItems: "center" },
  reqChip: { border: `1px solid ${COLORS.panelBorder}`, background: COLORS.panel, color: COLORS.text, borderRadius: 999, padding: "7px 10px", fontSize: 12, cursor: "pointer", whiteSpace: "nowrap" },
  reqActive: { background: COLORS.accent, color: "#100c1c", borderColor: COLORS.accent, fontWeight: 700 },
  body: { flex: 1, display: "flex", minHeight: 0 },
  mapWrap: { flex: 1, position: "relative" },
  placingBanner: {
    position: "absolute",
    top: 12,
    left: "50%",
    transform: "translateX(-50%)",
    background: COLORS.accent,
    color: "#100c1c",
    padding: "8px 14px",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    zIndex: 1000,
  },
  tagButton: {
    position: "absolute",
    bottom: 20,
    left: 20,
    zIndex: 1000,
    background: COLORS.accent,
    color: "#100c1c",
    border: "none",
    borderRadius: 10,
    padding: "12px 18px",
    fontSize: 14,
    fontWeight: 700,
    cursor: "pointer",
    boxShadow: "0 6px 20px rgba(139,107,255,0.4)",
  },
  searchBar: {
    position: "absolute",
    top: 12,
    left: 12,
    right: 12,
    zIndex: 1000,
    display: "flex",
    gap: 8,
    maxWidth: 480,
  },
  searchInput: {
    flex: 1,
    padding: "10px 12px",
    borderRadius: 8,
    border: `1px solid ${COLORS.panelBorder}`,
    background: COLORS.panel,
    color: COLORS.text,
    fontSize: 13,
    outline: "none",
  },
  searchButton: {
    padding: "10px 16px",
    borderRadius: 8,
    border: "none",
    background: COLORS.accent,
    color: "#100c1c",
    fontWeight: 700,
    fontSize: 13,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  searchError: {
    position: "absolute",
    top: 56,
    left: 12,
    zIndex: 1000,
    background: "rgba(239,91,124,0.15)",
    border: `1px solid ${COLORS.bad}`,
    color: COLORS.bad,
    fontSize: 12,
    padding: "6px 10px",
    borderRadius: 8,
  },
  panel: {
    width: 320,
    borderLeft: `1px solid ${COLORS.panelBorder}`,
    background: COLORS.panel,
    padding: 20,
    overflowY: "auto",
  },
  panelEmpty: { color: COLORS.textDim, fontSize: 14, marginTop: 40, textAlign: "center" },
  panelHeaderRow: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 },
  panelTitle: { fontSize: 18, margin: 0 },
  speakerButton: {
    background: "transparent",
    border: `1px solid ${COLORS.panelBorder}`,
    borderRadius: 8,
    fontSize: 16,
    padding: "4px 8px",
    cursor: "pointer",
  },
  verifiedBadge: {
    display: "inline-block",
    marginTop: 8,
    fontSize: 12,
    color: COLORS.good,
    border: `1px solid ${COLORS.good}`,
    borderRadius: 6,
    padding: "2px 8px",
  },
  scoreRow: { display: "flex", alignItems: "center", gap: 14, marginTop: 18 },
  scoreCircle: {
    width: 64,
    height: 64,
    borderRadius: "50%",
    border: "3px solid",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 20,
    fontWeight: 700,
  },
  chipRow: { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 18 },
  chip: {
    fontSize: 12,
    padding: "5px 10px",
    borderRadius: 999,
    border: "1px solid",
    background: COLORS.chip,
    color: COLORS.text,
  },
  barrierBox: {
    marginTop: 22,
    padding: 12,
    borderRadius: 10,
    border: `1px solid ${COLORS.bad}`,
    background: "rgba(239,91,124,0.1)",
  },
  barrierButton: {
    marginTop: 22,
    width: "100%",
    padding: "10px 14px",
    borderRadius: 8,
    border: `1px solid ${COLORS.bad}`,
    background: "transparent",
    color: COLORS.bad,
    fontWeight: 600,
    cursor: "pointer",
  },
  fixedButton: {
    padding: "6px 9px",
    borderRadius: 7,
    border: `1px solid ${COLORS.good}66`,
    background: "rgba(61,220,151,.13)",
    color: COLORS.good,
    fontWeight: 700,
    fontSize: 11,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  resolveButton: {
    marginTop: 10,
    width: "100%",
    padding: "8px 12px",
    borderRadius: 8,
    border: "none",
    background: COLORS.good,
    color: "#0c2018",
    fontWeight: 700,
    fontSize: 13,
    cursor: "pointer",
  },
  modalOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(10,8,16,0.6)",
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "center",
    zIndex: 2000,
    overflowY: "auto",
    overflowX: "hidden",
    padding: "24px 14px",
    boxSizing: "border-box",
  },
  modal: {
    width: 360,
    maxWidth: "90vw",
    background: COLORS.panel,
    border: `1px solid ${COLORS.panelBorder}`,
    borderRadius: 14,
    padding: 22,
  },
  modalScorePreview: { display: "flex", alignItems: "center", gap: 10, marginTop: 14 },
  checkList: { marginTop: 16, display: "flex", flexDirection: "column", gap: 10 },
  checkRow: { display: "flex", alignItems: "center", gap: 10, fontSize: 14, cursor: "pointer" },
  modalActions: { display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 20 },
  secondaryButton: {
    padding: "9px 14px",
    borderRadius: 8,
    border: `1px solid ${COLORS.panelBorder}`,
    background: "transparent",
    color: COLORS.text,
    cursor: "pointer",
  },
  dbBadge: { fontSize: 11, color: COLORS.good, border: `1px solid ${COLORS.good}`, borderRadius: 999, padding: "6px 9px" },
  emergencyButton: { position: "fixed", right: 20, bottom: 20, zIndex: 1200, background: COLORS.bad, color: "white", border: "none", borderRadius: 999, padding: "12px 16px", fontWeight: 700, cursor: "pointer", boxShadow: "0 6px 20px rgba(0,0,0,.35)" },
  verifyBox: { marginTop: 10, padding: 10, border: `1px solid ${COLORS.mid}`, borderRadius: 10, background: "rgba(242,193,78,0.07)" },
  verifyButton: { marginTop: 9, width: "100%", padding: "9px 12px", borderRadius: 8, border: `1px solid ${COLORS.good}`, background: COLORS.good, color: "#0c2018", fontWeight: 700, cursor: "pointer" },
  unverifiedBadge: { display: "inline-block", marginTop: 8, fontSize: 12, color: COLORS.mid, border: `1px solid ${COLORS.mid}`, borderRadius: 6, padding: "2px 8px" },
  fixedButton: { flex: 1, padding: "8px 10px", borderRadius: 8, border: `1px solid ${COLORS.good}`, background: "transparent", color: COLORS.good, fontWeight: 700, cursor: "pointer" },
  requestBox: { marginTop: 18, padding: 12, borderRadius: 10, border: `1px solid ${COLORS.panelBorder}`, background: "rgba(139,107,255,.07)" },
  heroLevel: { color: COLORS.accent, fontWeight: 700, marginTop: 8 },
  profileGrid: { display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, marginTop: 16 },
  profileGrid: { display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, marginTop: 16 },
  badgeCard: { marginTop: 16, padding: 14, borderRadius: 10, background: COLORS.chip, textAlign: "center", fontWeight: 700 },
  emergencyRow: { display: "flex", justifyContent: "space-between", gap: 10, padding: 10, marginTop: 8, border: `1px solid ${COLORS.panelBorder}`, borderRadius: 8 },
  primaryButton: {
    padding: "9px 14px",
    borderRadius: 8,
    border: "none",
    background: COLORS.accent,
    color: "#100c1c",
    fontWeight: 700,
    cursor: "pointer",
  },
};
