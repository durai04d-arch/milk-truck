# Milk Truck Live — PWA dashboard

Responsive website for the ESP32 Milk Truck tracker. Includes:
- Firebase Realtime Database live listener for `trucks/<truckId>/latest` and `trucks/<truckId>/history`
- Temperature, GPS, speed, Wi-Fi, timestamp, and temperature-status cards
- OpenStreetMap/Leaflet map and Google Maps link
- Built-in rule-based troubleshooting assistant (no AI API key and no external AI calls)
- PWA manifest, install prompt, service worker, and cached app shell

## 1. Configure Firebase

Deploy this folder to a static HTTPS host (Vercel, Netlify, or GitHub Pages). PWA service workers do not work from a local `file://` URL; use localhost for development or HTTPS after deployment.

Open the dashboard and enter:
- Firebase Web API key from Firebase Console → Project settings → General
- Realtime Database URL: `https://milk-truck-default-rtdb.asia-southeast1.firebasedatabase.app`
- Truck ID: `milkTruck01`
- Email/password for a Firebase Authentication user

Enable **Email/Password** in Firebase Authentication. The website signs in through the Firebase client SDK and reads:
- `/trucks/milkTruck01/latest`
- `/trucks/milkTruck01/history`

The website uses the same data schema as the ESP32 firmware. `timestamp` may be milliseconds since epoch or seconds; both are handled.

## 2. Firebase security

Do not use public test rules for a real deployment. Example starter rules are in `database.rules.example.json`. These restrict reads to authenticated users, but they are not a complete per-user/role system; customize rules for your project. Never publish Firebase user passwords in source code. Settings are saved in the current browser's localStorage for convenience. Clear them on shared devices.

## 3. Deploy to Vercel

1. Extract the ZIP.
2. Put the contents of this folder at the root of a GitHub repository.
3. Import the repository into Vercel.
4. Framework preset: **Other**; build command: leave empty; output directory: `.`.
5. Deploy. Open the HTTPS URL on your phone. Use the browser's Install app / Add to Home Screen option.

## 4. PWA/offline behavior

The app shell and static assets are cached. Live Firebase data and map tiles require internet. The website does not queue ESP32 data; firmware handles uploads separately. The chat bot is a deterministic FAQ helper, not a generative AI assistant.

## 5. ESP32 expected paths

- Latest record: `PUT /trucks/milkTruck01/latest.json`
- History records: `POST /trucks/milkTruck01/history.json`

Keep the truck ID consistent between firmware and dashboard.


## Temperature notification threshold
The dashboard displays a temperature alert and attempts a browser notification when the latest valid temperature is **above 6°C**. Browser notifications require permission and a secure HTTPS origin. This threshold is configurable in the website JavaScript and should be checked against approved cold-chain requirements.

## Analytics and location history
- The temperature analytics chart plots up to 30 recent Firebase temperature readings and shows a 6°C reference line.
- Recent History shows record GPS coordinates when the ESP32 record has a GPS fix; otherwise it shows the current browser-device coordinates when permission is granted. This fallback is current coordinates, not historical coordinates for each past record.
- Browser GPS points are stored locally in that browser and drawn as a map trail while the dashboard is used. They are not automatically synced to Firebase or shared with other devices.
- Standing/running is estimated from GPS movement on the browser device. For actual truck movement status, the ESP32 must upload its own GPS/speed fields.

## Saving GPS coordinates to Firebase
When location permission is granted and Firebase is connected, the dashboard writes the current GPS coordinates to:
- `/trucks/milkTruck01/gpsLocation` (latest coordinates)
- `/trucks/milkTruck01/gpsLocationHistory` (appended history)

Each record contains `latitude`, `longitude`, `accuracyMeters`, `timestamp`, and `locationName: "GPS"`. The browser must remain open to keep collecting new location points. The authenticated Firebase user needs write permission for these paths. Avoid public database rules for real tracking data.
