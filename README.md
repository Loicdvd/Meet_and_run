# Meet and Run (React Native)

Mobile app prototype to plan a running route on a map, calculate distance, schedule a run, and share it so others can join.

## Features
- Tap to set start and finish points
- Auto-generate a walking route using Google Directions API
- Distance calculation (km) from the generated route
- Schedule date and time for the run
- Save planned runs locally
- Share a run invitation via the native share sheet
- Join toggle for local plans

## Run it
1. Install dependencies
   - `npm install`
2. Start Expo
   - `npm run start`

## Docker (reproducible dev)
1. Build and run
   - `docker compose up --build`
2. Open Expo DevTools
   - `http://localhost:19000`

Notes:
- The container runs `npm run start -- --lan` so devices on the same network can connect.
- If LAN discovery doesn’t work in your environment, change the command in `Dockerfile` to `--tunnel`.

## Google Maps setup (Android)
1. Create a Google Cloud project and enable:
   - Maps SDK for Android
   - Directions API
2. Create an API key.
   - For Maps SDK: restrict to Android apps (recommended).
   - For Directions API: use a separate key or leave unrestricted during prototyping.
3. Add the key in `app.json` under `expo.android.config.googleMaps.apiKey`.
4. Also set `GOOGLE_MAPS_API_KEY` in `App.js` for Directions API calls.

## Notes
- Uses Expo + `react-native-maps` and `expo-location`.
- This is a local prototype with in-app sharing (no backend yet).
