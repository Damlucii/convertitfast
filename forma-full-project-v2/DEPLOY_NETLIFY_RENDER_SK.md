# Ako sfunkčniť konverziu videí vo Forma (Netlify + Render)

## Prečo sa objaví chyba

`A conversion server is required for video transcoding` znamená, že web je nasadený iba ako statická stránka. Netlify stránka sama nedokáže spustiť FFmpeg proces pre tvoje 4K video. Ak nechceš ďalší hosting, použi lokálne Docker + verejný HTTPS tunel; inak Render alebo podobný server.

## Rýchly postup

1. Rozbaľ **forma-full-project-v2.zip**.
2. V GitHub vytvor súkromný repozitár a nahraj **celý obsah** rozbaleného priečinka vrátane `backend/` a `render.yaml` (nie ZIP archív ako jediný súbor).
3. Na https://dashboard.render.com zvoľ **New → Blueprint** a prepoj repozitár. Render nájde `render.yaml`.
4. Pri vytváraní nastav silný náhodný `API_ACCESS_KEY` (aspoň 24 náhodných znakov), ktorý nikomu neposielaš. Potom nastav `CORS_ORIGINS` na **presnú** adresu svojho webu, napr. `https://moj-konvertor.netlify.app` (bez koncového `/`). Ak máš viac domén, oddeľ ich čiarkou.
5. Spusti nasadenie. Po dokončení dostaneš adresu napr. `https://forma-conversion-api.onrender.com`. Toto je **príklad**, nie hotová adresa.
6. Over `https://TVOJA-RENDER-ADRESA/api/health` – musí vrátiť `"ok": true`.
7. Otvor web na Netlify → **Settings** → **Conversion server URL**. Vlož svoju Render HTTPS adresu **bez `/api`** a v poli **Server access key** vlož hodnotu `API_ACCESS_KEY` z Render.
8. Klikni na **Test**, potom **Save changes**. Vľavo má byť `Server engine online`.
9. Teraz otvor video → **GIF**. Zvoľ Width 960px, FPS 12, dĺžku Entire video alebo prvých 5/10 sekúnd, podľa potreby. Spusti konverziu.

## Limity a súkromie

- Render Free má 512 MB RAM a iba 0,1 CPU. Veľké 4K videá s 287 MB vstupom nemusia prejsť: môže dôjsť k nedostatku RAM, miesta alebo k časovému limitu. Pre veľké videá je vhodnejší silnejší server (napr. Render `1c-2g`: 2 GB RAM) alebo vlastný počítač s Dockerom.
- Pri službe Render Free môže štart z režimu spánku trvať približne minútu. Webový klient má pri teste spojenia iba 8-sekundový timeout, takže po prebudení servera spusti **Test** ešte raz.
- Zadanie Netlify adresy v CORS obmedzuje prístup z prehliadača, **ale nie je to autentifikácia**. Priložený backend vie kontrolovať súkromný `API_ACCESS_KEY` pre upload/konverziu. Vkladaj ho len do vlastnej aplikácie; pred verejnou prevádzkou pridaj rate limiting a kvóty. Kľúč sa v prehliadači ukladá do localStorage. Nahrané súbory sa odosielajú na backend.
- GIF nikdy nemá rovnakú farebnú vernosť ako originálne video: iba 256 farieb v palete, bez zvuku, potenciálne veľmi veľké súbory. Na zachovanie kvality videa použi MP4/MKV.
- Na Netlify nahraj **iba priečinok `site`** z novej verzie. Starú stránku aktualizuj novým deployom; samotné nasadenie Render backendu starú webovú stránku nedoplní o nové GIF ovládače.
