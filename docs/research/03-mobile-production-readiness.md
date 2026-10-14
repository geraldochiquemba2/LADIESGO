# LadiesGo — Mobile Production Readiness for National Scale (Angola, 2026)

**Baseline assumed:** Expo SDK ≈56/57 (RN 0.86, React 19.2), New Architecture (mandatory since SDK 55 / RN 0.82), raw WebSocket per trip + REST polling, Cloudflare Workers backend. Angola is Android-dominant; target is low-end Transsion/Samsung/Xiaomi on 3G/4G with expensive prepaid data.

Two framing facts:
- **New Architecture can no longer be disabled** (SDK 55+).
- **The driver app is the hard part** — a driver whose GPS silently dies loses money and abandons the platform.

---

## 1. Background location tracking (driver app)

### P0 — Ship a foreground service with the right type + a self-healing watchdog
- Use a **location foreground service** (`FOREGROUND_SERVICE_LOCATION`, Android 14+ API 34), with a **persistent notification**, and `START_STICKY`.
- Add an independent **watchdog** that checks a *persisted* session flag and restarts tracking if killed. `react-native-background-fetch`:
  ```js
  { minimumFetchInterval: 8 /*min*/, stopOnTerminate: false, startOnBoot: true,
    enableHeadless: true, forceAlarmManager: true, requiredNetworkType: NETWORK_TYPE_NONE }
  ```
  `forceAlarmManager: true` matters — default JobScheduler is Doze-batched.
- **Do not** rely on `expo-location` alone: its background task **stops if the user force-quits** and a terminated app **will not auto-restart** on a location event. Watchdog is mandatory.

### P0 — Decide: expo-location vs react-native-background-geolocation (TSBG)
| | `expo-location` + TaskManager | `react-native-background-geolocation` v5 |
|---|---|---|
| Cost | Free | **License required for RELEASE builds** (~$299 CAD Starter) |
| Battery intelligence | Manual | Accelerometer motion detection; SQLite persistence; HTTP upload queue |
| Fit for ride-hailing | Adequate for MVP with a watchdog | Best-in-class |

**Recommendation:** Start on `expo-location` + watchdog for MVP, budget for TSBG if location gaps hurt retention.

### P0 — Handle Android 14/16 foreground-service bugs in `expo-location`
- FATAL `SecurityException` from `LocationTaskService.startForeground` when the app leaves the FGS-eligible state. Mitigation: start tracking only while `AppState === 'active'`; pin the fixed version.
- FGS permission check evaluated unconditionally (issue #49641).
- Config: `isAndroidBackgroundLocationEnabled: true`, `isAndroidForegroundServiceEnabled: true`; monochrome notification icon.

### P1 — OEM battery killers (Xiaomi/Huawei/Samsung/Transsion)
- Build an **onboarding "reliability" step**: foreground location → `POST_NOTIFICATIONS` → battery-optimization exemption → background location → **OEM-specific deep-link guidance**, non-blocking.
- Deep links at **dontkillmyapp.com**:
  - **Xiaomi (MIUI/HyperOS):** enable *Autostart*; battery *No restrictions*; lock app in Recents.
  - **Huawei (EMUI/HarmonyOS):** *App launch → Manage manually*; add to *Protected apps*. PowerGenie can hard-kill ~60 min; **new Huawei has no GMS → no FCM/Play** (~6%, declining).
  - **Samsung (One UI):** remove from *Sleeping/Deep sleeping apps*; disable *Adaptive battery*.
- Add **telemetry**: log watchdog restarts by manufacturer/model.

### P1 — Tune accuracy vs battery
- Live trip: `BALANCED_POWER_ACCURACY`, `distanceFilter 50–100 m`, ~10–15 s.
- Waiting: motion detection or `LOW_POWER`, or stop and rely on heartbeat.
- iOS: `pausesUpdatesAutomatically` + `activityType: automotiveNavigation`; `UIBackgroundModes: ["location","fetch","processing"]`. Significant-location-change is the only Apple relaunch after force-quit (~500 m / ~15 min). Dev builds only.

### P2 — Heartbeat + kill detection
Send a server heartbeat every 30–60 s while online. "No heartbeat for N minutes" → on-call/driver-support alert.

---

## 2. Reliable realtime & offline-first

### P0 — Reconnect with exponential backoff + jitter, AppState/NetInfo aware
- `onclose` → reconnect `min(base * 2^attempt, 30s)` **plus jitter** (`0.5 + random*0.5`) to avoid thundering herd.
- **Reset backoff on `onopen`**; cap attempts (10–15 tries or 2–5 min).
- **Close the socket on `AppState: background`**; reconnect immediately on foreground and on `NetInfo` restored.
- Jittered heartbeat + client-side stale-timer forcing reconnect.

### P0 — Gap-fill + idempotency
- On reconnect, pull a REST **delta with a cursor** (`?since=<lastSeqId>`).
- Tag every outbound action with a client UUID **idempotency key**; server dedupes.
- **Dedupe inbound** by `message.id`.

### P0 — Offline queue + optimistic UI
- Persist a **request queue** in `AsyncStorage`/MMKV (accept, location, chat). Flush on reconnect; pace flushes.
- **Optimistic UI** for driver accept with local persistence, reconcile with server ack.
- Treat WebSocket as an **optimization**: exact REST fallback polling. State source of truth = REST snapshot + WS deltas (TanStack Query `setQueryData`).

### P1 — Low-bandwidth mode
- Explicit **"data saver"**: coarser map refresh, skip asset preloads, compress payloads (deltas). Angola data ≈ **$1.65–3.20/GB**.
- Poll intervals: foreground 15–30 s; background 60–300 s or push-triggered. Never keep a socket open in background.

### P2 — Session identity separate from connection identity
Server issues a session id; client presents it on reconnect to resume subscriptions/presence. TTL 2–5 min.

---

## 3. Push notifications & the "ring"

### P0 — Transport: Expo Push to start, swappable sender
- `expo-notifications` + Expo Push Service is pragmatic (free, handles FCM v1/APNs creds). Wrap the backend sender behind an interface.
- **Migrate to direct APNs/FCM HTTP v1** when you need iOS **critical alerts**, Live Activities, per-platform payload control, or >~100k/day. Legacy FCM API retired.
- Push unavailable in **Expo Go on Android (SDK 53+)** — use a development build.

### P0 — Make the ring robust (Android)
- Use **Notifee** as the rendering layer. It is the only RN library with **full-screen intent**.
  - Dedicated **high-importance channel** with `sound: 'default'`, `importance: HIGH`. **Channel sound & importance are frozen at creation** → ship **versioned channel ids** (`trip-ring-v2`).
  - `fullScreenAction` + `category: CALL`.
- **Android 14+ restricts `USE_FULL_SCREEN_INTENT`** to calling/alarm apps → declare + request per-app permission (`android.settings.MANAGE_APP_USE_FULL_SCREEN_INTENT`).
- Needs `android:showWhenLocked="true"` and `android:turnScreenOn="true"` on MainActivity → **Expo config plugin**.
- Send rings with **`priority: "high"`** (reserve for rings, not marketing).

### P0 — iOS ring
- Request **Time Sensitive** entitlement (`interruption-level: time-sensitive`).
- **Critical alerts** require a special Apple entitlement + `allowCriticalAlerts`; Notifee supports `ios.critical: true`. Treat Time Sensitive as baseline.
- iOS plays no ring when silent/focus → design voice/visual fallback.

### P1 — Token lifecycle & delivery measurement
- Sync tokens on **cold start**; dedupe; delete on `DeviceNotRegistered`/410. Poll receipts within 24 h.
- Instrument **device-side received**. Real-world gap: ~12–18% Android, ~4–8% iOS.
- Wake the app + reconnect WS when the ring is tapped.

### P2 — Huawei
FCM doesn't reach GMS-less Huawei. If >5% usage, integrate **HMS Push**.

---

## 4. Performance & stability on low-end devices

### P0 — Verify Hermes and update off the SDK 56 regression
- Hermes v1 is default in SDK 56, but **SDK 56 has a Hermes v1 memory regression** with Reanimated/worklets. **Upgrade to SDK 57 (`expo@>=57.0.17`)**. Verify Hermes at runtime (`HermesInternal`) in a **release** build.
- Keep the JS bundle **uncompressed** for Hermes bytecode mmap.

### P0 — Crash + performance monitoring (Sentry)
- `@sentry/react-native` via the **Sentry wizard** (`@sentry/react-native/expo` config plugin + `getSentryExpoConfig` in Metro for Debug IDs).
- Upload source maps: automatic for native; **for EAS Update run `npx @sentry/expo-upload-sourcemaps dist` after `eas update`**.
- Set `tracesSampleRate` ~0.1–0.2 in prod. Track **crash-free sessions** (>99.8%) and **P90 time-to-interactive** (Expo target **<3 s**).

### P0 — App size
- Ship **AAB**; if sideloading, build **arm64-v8a only** (minSdk 29+).
- Enable **R8 full mode** (`minifyEnabled` + `shrinkResources`) via `expo-build-properties`. ~20–40% size reduction.
- Trim languages (`resConfigs`: pt + en), WebP, `crunchPngs`. Test R8 on real hardware.

### P1 — EAS Update staged rollouts
- `runtimeVersion.policy: "fingerprint"` so native changes force a new build.
- `eas update --rollout-percentage=10` (SDK 55+: `--environment` required). Gates: 1% → 10% → 50% → 100%.
- Built-in error recovery falls back to last-good update. SDK 56+ **Hermes bytecode diffing default**.
- Free-tier: 1,000 monthly active update users; Production tier 50,000.

### P1 — Rendering
- **FlashList** for trip lists/history; avoid inline functions; memoize driver cards.

### P2 — Version support policy
- Support ~1 year of SDKs; force-update via a **minimum-version check** at startup.

---

## 5. Maps & navigation in Angola

### P0 — Routing/ETA: prefer a provider with Angola traffic data
- **Mapbox Directions** lists **Angola** among countries with **real-time + typical traffic** ETA. Use `mapbox/driving-traffic`.
- **Google Maps Platform** covers Angola for maps/roads/places but **no transit**; weaker traffic ETA.
- **OSRM on OpenStreetMap** as self-hosted fallback: Geofabrik `angola-latest.osm.pbf` is only **~85 MB**.
- **Pragmatic mix:** Mapbox for display + traffic ETA, **OSRM as offline/self-hosted fallback**.

### P0 — Offline maps
- **`@rnmapbox/maps`** with **OfflineManager + TileStore**: download Luanda (and later provincial capitals) as **tile regions**.
  - Limits: max **750 tile packs**; per-region tens–hundreds of MB. Set `diskQuota` (e.g. 500 MB); exclude tile path from Android backup.
  - **v2 tile packs save up to ~40% storage** (SDK ≥11.16). Preload on Wi-Fi.
- Show "download maps for offline use" as Wi-Fi-only; cache route polylines.

### P1 — Display choice
- `@rnmapbox/maps`: best offline + custom style. `react-native-maps` works for basic; `expo-maps` is native but weaker offline.
- **Do not** assume Google Maps quality is uniform outside Luanda.

### P2 — Cost hygiene
- Google Maps per-API caps (2025). OSRM self-host + Mapbox offline packs cut spend.

---

## 6. App store, devices & payments in Angola (2026 realities)

### Market facts
- **Android overwhelmingly dominant**; iOS ~3% premium-only.
- Handset mix: **Transsion ~34%**, **Samsung ~24%**, **Xiaomi ~14%**, **Huawei ~6% falling**, Apple ~3%.
- Smartphone penetration ~42% (Luanda ~62%, rural 12–18%). 4G population coverage ~45%.

### P0 — Distribution via Google Play, with sideload first-class
- **Google Play available in Angola.** Ship an AAB, but expect significant **direct APK sideload** (WhatsApp, retail).
- **In-app updates must not depend on Play Core** — use **EAS Update** for JS; self-hosted APK + signature check for native.

### P0 — Payments: Play Billing is legally awkward from Angola
- **Angola does not support Google Play Merchant registration** → cannot run Play Billing as an Angola-based merchant.
- **Multicaixa Express** (EMIS GPO): integrate via **vPOS** (`developer.vpos.ao`), **ProxyPay** (`api.proxypay.co.ao`), or **Paybyrd** (`mcxwallet://` deeplink + QR).
  - Flow: backend pre-authorizes → user accepts in MCX Express → `callback_url` webhook.
- **Recommendation:** cash first; integrate **Multicaixa Express** for cashless rides / top-ups. For digital subscriptions, route through a merchant in a Google-Billing-supported country or Paybyrd.

### P1 — Store review posture
- FGS + background location require **Play Console declarations**. Prepare demo video + justification (driver live location + rider safety). The FGS location form is the most common rejection vector.

### P2 — Analytics & growth
- Instrument install source (Play referrer vs sideload), activation, driver "online-hours".

---

## Consolidated priority summary

| Priority | Item | Tooling |
|---|---|---|
| **P0** | Android location FGS + watchdog | `expo-location` (or TSBG) + `react-native-background-fetch`; OEM deep links |
| **P0** | Upgrade to SDK 57 (Hermes memory fix) | `expo@>=57.0.17` |
| **P0** | Resilient WS: backoff+jitter, AppState/NetInfo, heartbeats, delta gap-fill, idempotency | Native WS or `robosocket`; MMKV queue |
| **P0** | Offline queue + optimistic UI + REST fallback | TanStack Query / MMKV |
| **P0** | Robust ring: high-importance channel + full-screen intent | `expo-notifications` + **Notifee** |
| **P0** | Time-sensitive alerts (iOS) + high-priority (Android) | APNs entitlement / FCM priority |
| **P0** | Crash + perf monitoring with OTA context | `@sentry/react-native` |
| **P0** | App size: AAB, arm64-only sideload, R8 | `expo-build-properties` |
| **P0** | Angola payment path (Multicaixa Express) | EMIS GPO via vPOS / ProxyPay / Paybyrd |
| **P0** | Routing/ETA with Angola traffic + self-hosted fallback | Mapbox Directions (+ OSRM) |
| **P0** | Offline map packs | `@rnmapbox/maps` OfflineManager/TileStore |
| **P1** | EAS Update staged rollouts + fingerprint | `eas update --rollout-percentage` |
| **P1** | Battery-optimization onboarding + restart telemetry | native module / community lib |
| **P1** | Token lifecycle + device-received instrumentation | Expo/FCM receipts |
| **P1** | FlashList, memoization, low-bandwidth mode | FlashList, data-saver |
| **P2** | iOS app (secondary), Huawei HMS push, min-version force update | — |

---

## Sources

**Background location**
- Expo Location (SDK 57): https://docs.expo.dev/versions/v57.0.0/sdk/location/
- expo-location FGS crash bug: https://github.com/expo/expo/issues/49424
- expo-location FGS permission bug: https://github.com/expo/expo/issues/49641
- react-native-background-geolocation: https://github.com/transistorsoft/react-native-background-geolocation
- react-native-background-fetch: https://github.com/transistorsoft/react-native-background-fetch
- dontkillmyapp: https://dontkillmyapp.com/xiaomi , https://dontkillmyapp.com/samsung
- Android Doze: https://source.android.google.cn/docs/core/power/platform_mgmt

**Realtime / offline**
- WebSocket reconnection state sync: https://websocket.org/guides/reconnection/
- robosocket: https://www.npmjs.com/package/robosocket

**Push / ring**
- Expo Notifications: https://docs.expo.dev/versions/latest/sdk/notifications/
- Notifee full-screen action: https://notifee.app/react-native/reference/notificationfullscreenaction/
- Notifee USE_FULL_SCREEN_INTENT (Android 14): https://github.com/invertase/notifee/issues/1027

**Performance / stability / OTA**
- Expo SDK 57 changelog: https://expo.dev/changelog/sdk-57
- Expo SDK 56 changelog: https://expo.dev/changelog/sdk-56
- EAS Update production playbook: https://expo.dev/blog/the-production-playbook-for-ota-updates
- Staged rollout: https://expo.dev/articles/updates-and-rollouts/staged-rollout
- Sentry for Expo: https://docs.sentry.io/platforms/react-native/manual-setup/expo/
- R8 app optimization: https://developer.android.com/topic/performance/app-optimization/enable-app-optimization

**Maps / navigation in Angola**
- Google Maps coverage: https://developers.google.com/maps/coverage
- Mapbox traffic coverage (incl. Angola): https://docs.mapbox.com/help/dive-deeper/directions/
- Mapbox offline (limits, tile packs): https://docs.mapbox.com/help/dive-deeper/mobile-offline/
- Mapbox offline v2 (-40% size): https://www.mapbox.com/blog/more-efficient-offline-map-tiles-save-up-to-40-storage-space
- rnmapbox TileStore: https://rnmapbox-maps.mintlify.app/api/tile-store
- Geofabrik Angola OSM (~85 MB): https://download.geofabrik.de/africa/angola.html
- OSRM: https://project-osrm.org/

**Angola market / store / payments**
- Google Play paid apps by country: https://support.google.com/googleplay/answer/143779
- Developer/merchant registration by country: https://support.google.com/googleplay/android-developer/answer/9306917
- EMIS GPO / Multicaixa: https://multicaixa.ao/pt/oferta/canais/comerciantes/gateway-de-pagamentos-online/
- ProxyPay OPG API: https://developer.proxypay.co.ao/opg/v1/
- vPOS: https://developer.vpos.ao
- Paybyrd Multicaixa Express: https://docs.paybyrd.com/accept-payments/bank-transfers/multicaixa-express
- Digital Angola device/connectivity: https://digitalangola.com/market/consumer-device-market/ , https://datareportal.com/reports/digital-2026-angola
- Statcounter Angola: https://gs.statcounter.com/os-market-share/all/angola

**Note:** current Expo is **SDK 57 (RN 0.86, React 19.2)**; SDK 56 has a Hermes v1 memory regression that makes **upgrading to 57 the single cheapest stability win**.
