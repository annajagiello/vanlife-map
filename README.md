# Camper Spots

A single-page web app for finding van and camper spots: Google Places results (campsites, aires, parking, rest stops, toilets, laundromats, supermarkets, malls) on a map, with weather per spot and an optional temperature map. Installable on a phone (PWA).

## Use

1. Open the app (served over https, or `python3 -m http.server` on localhost).
2. Paste your own Google Maps API key when asked. It is stored only in your browser (`localStorage`) and is never part of this repository.
3. In Google Cloud, restrict the key to your app's web address and to the Maps JavaScript API and Places API (New).

## Data sources

- Google Maps JavaScript API and Places API (New): needs your own key and billing account.
- [Open-Meteo](https://open-meteo.com/): weather, elevation and the temperature map, no key (free tier, non-commercial use).
- OpenStreetMap via Overpass: public toilets (ODbL licence). Servers are often busy.

Park4night is not used: its terms do not allow bulk extraction.

## Files

- `index.html`: the whole app (HTML, CSS, JavaScript)
- `manifest.webmanifest`, `sw.js`, `*.png`: install-to-home-screen support
