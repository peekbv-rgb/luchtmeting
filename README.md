# Toren — luchthoeveelheidsmeting

Browser-tool om het luchtdebiet van een (neerwaartse) toren te bepalen uit een
Pitot-/verschildruk- of anemometermeting. Rekent `Δp -> v -> Q` met dynamische
dichtheidscompensatie voor vochtige lucht, equal-area traverse met tekening en
heatmap van de verdeling, verdampingskoeling en Accutrol-kalibratie.

Kan op twee manieren draaien:
1. **Statisch** (alleen `index.html`) — handmatige condities, of live ThingsEye
   mits die CORS toestaat.
2. **Node-service** (`server.js`) — serveert de app én proxyt ThingsEye, zodat er
   geen CORS-probleem is en de sensor-inloggegevens veilig als env-variabelen op
   de server staan. Aanbevolen als je live data wilt.

## Functies

- Geometrie: bovenring, venturi (keel) en opening onderzijde; keuze van de meetlocatie.
- Dynamische dichtheid uit temperatuur, RV en barometerdruk (Magnus/WMO, vochtige lucht).
- Live condities via **ThingsEye** (ThingsBoard REST): temperatuur en RV realtime,
  naast handmatige invoer, met auto-verversen. Direct of via de meegeleverde proxy.
- Instrument: **Pitotbuis (Δp)** of **anemometer (v direct)**; sondetype Prandtl / S-type / handmatige Cp.
- Δp-invoer in **Pa of mbar**.
- Modus **Enkele waarde** of **Traverse (grid)**: equal-area grid (3 of 5 ringen),
  doorsnedetekening, radiaal profiel en **heatmap** van de snelheidsverdeling met
  zwaartepunt (richt-straal voor de nozzles).
- Debiet Q in m3/s en m3/h, met v en verwachte Δp per doorsnede via continuiteit.
- Verdampingskoeling: max. waterinbreng (100% verzadiging), water per kg lucht,
  natteboltemperatuur en uitblaascondities.
- Accutrol-bol: kalibratie (k = Q_referentie / Accutrol) en gecorrigeerd debiet.
- Stromingsschema met snelheid boven, in de venturi en onderin.

## Publiceren via Render — Node-service (met ThingsEye-proxy)

1. Push alle bestanden naar een GitHub-repo (`index.html` in de **root**).
2. Render -> **New** -> **Blueprint** -> kies de repo -> **Apply**.
   Render leest `render.yaml` en maakt een Node web service.
3. Zet in Render onder **Environment** de sensor-secrets:
   - `TE_URL`  (bv. `https://app.thingseye.io`)
   - `TE_USER` (ThingsEye e-mail)
   - `TE_PASS` (ThingsEye wachtwoord)
   - `TE_DEVICE` (device-ID / uuid)
   - `TE_KEY_T` / `TE_KEY_H` (telemetrie-sleutels; standaard `temperature` / `humidity`)
4. In de app: kaart 2 -> **Live (ThingsEye)** -> vink **via proxy (/api/te)** aan
   en zet **auto-verversen** aan. De inloggegevens hoef je in de app dan niet in te vullen.

## Publiceren als statische site (zonder proxy)

Render -> **New** -> **Static Site** -> Publish Directory `.`. Werkt handmatig altijd;
live ThingsEye werkt alleen als ThingsEye CORS toestaat voor je Render-URL.

## Lokaal

```
npm install
TE_URL=... TE_USER=... TE_PASS=... TE_DEVICE=... node server.js
# open http://localhost:3000
```

Of zonder proxy: open index.html rechtstreeks.

## Structuur

```
.
├── index.html      # de applicatie
├── server.js       # Node/Express: serveert app + /api/te proxy
├── package.json
├── render.yaml     # Render Blueprint (Node web service)
└── README.md
```
