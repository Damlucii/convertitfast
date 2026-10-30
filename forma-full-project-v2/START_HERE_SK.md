> **Pre MP4 → GIF pozri nový jednoduchý postup: [DEPLOY_NETLIFY_RENDER_SK.md](DEPLOY_NETLIFY_RENDER_SK.md)**. Netlify samotné nestačí na video konverziu.

# FORMA — ako spustiť vlastný webový konvertor

**Aktuálny stav:** Je to skutočná fungujúca aplikácia s webovým rozhraním a samostatným backendom, nie iba grafický návrh. Odskúšané boli lokálne konverzie PNG → WebP, backendové obrázkové konverzie a viaceré prevody videa cez FFmpeg. Plná kompatibilita so všetkými fotoaparátmi, mobilmi a video formátmi nie je garantovaná; pozri technické obmedzenia nižšie.

## 1. Netlify — samotná stránka (najjednoduchšie)

1. Rozbaľ `forma-netlify-site.zip`.
2. Otvor https://app.netlify.com/drop a prihlás sa.
3. Pretiahni tam rozbalený priečinok obsahujúci `index.html`.
4. Získaš vlastnú verejnú Netlify adresu.
5. Už teraz funguje základná konverzia **JPG / PNG / WebP** priamo v prehliadači, bez backendu. Má obmedzenia pri metadátach a farebných profiloch.

## 2. HEIC, RAW a videá — pripoj konverzný server

**Dôležité:** Netlify dokáže hostovať web, ale pre veľké súbory a vysokokvalitné dlhšie video konverzie treba samostatný backend, ktorý má nainštalované FFmpeg a obrazové knižnice. V projekte je pripravený ako Docker kontajner (`backend/`, `docker-compose.yml`).

- Spusti tento kontajner na vlastnom počítači, VPS alebo hostingu podporujúcom Docker (napríklad Render / Railway).
- Pre verejný web potrebuje backend vlastnú verejnú **HTTPS** adresu.
- V `docker-compose.yml` nahraď `https://YOUR-SITE.netlify.app` skutočnou adresou svojej stránky, inak bude prehliadač blokovať pripojenie.
- Vo webovej aplikácii klikni na **Settings**, vlož HTTPS adresu backendu, klikni **Test** a **Save changes**.
- Aplikácia potom ponúkne skutočné serverové dekodéry a enkodéry podľa toho, ktoré sú dostupné.

## 3. Ako backend spustiť v Dockeri

V priečinku celého projektu spusti:

```
docker compose up --build -d
```

Na tomto počítači potom API počúva na `http://localhost:8000`. Toto je lokálna adresa a samo osebe sa **nedá používať z iného zariadenia cez verejný Netlify web**. Na sprístupnenie internetu použi hosting kontajnerov s HTTPS.

## Upozornenia

- Netlify sám osebe nestačí na všetky náročné video konverzie. Plný balík preto obsahuje samostatnú serverovú časť.
- RAW sa do bežných obrázkov vyvoláva v 8 bitoch na kanál; RAW → TIFF používa 16-bitové dáta, keď sú dostupné potrebné knižnice.
- Video, HDR a farebný priestor môžu byť pri prekódovaní zmenené. Ak je možné iba zmeniť kontajner bez prekódovania, engine to preferuje.
- Pri verejne dostupnom backende je potrebné pred ostrým nasadením doplniť autentifikáciu a ochranu proti zneužitiu. Súčasná verzia je primárne pre osobné použitie.
- Stránka má zatiaľ anglické rozhranie; pripravená architektúra sa dá rozšíriť o slovenskú lokalizáciu.

Technický návod, limity a architektúra sú podrobnejšie v `README.md`.
