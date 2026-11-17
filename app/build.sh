#!/usr/bin/env bash
# Costruisce l'app Android di Dichiaro.
#
#   bash app/build.sh
#
# Servono Python 3, Node >= 22, JDK 21 e l'Android SDK (ANDROID_HOME) con le
# licenze accettate.
#
# Senza chiave di firma esce un APK di debug, app/dichiaro-<VERSION_NAME>.apk,
# firmato con la chiave di debug pubblica del repo: va bene per passarlo agli
# amici, non per lo store.
#
# Con ANDROID_KEYSTORE (il file) piu' ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS
# e ANDROID_KEY_PASSWORD esce una build di rilascio firmata con la tua chiave:
# app/dichiaro-<VERSION_NAME>-release.apk e app/dichiaro-<VERSION_NAME>.aab
# (quest'ultimo e' quello che si carica su Play). Le password restano in
# variabili d'ambiente: non compaiono mai fra gli argomenti dei comandi.
#
# Pubblicita' (Google AdMob). Di default l'app mostra annunci di PROVA di Google
# ("Test Ad"): sono sicuri da cliccare. Gli id veri si danno con ADMOB_APP_ID
# (ca-app-pub-...~...), ADMOB_INTERSTITIAL_ID e ADMOB_APP_OPEN_ID
# (ca-app-pub-.../...), tutti e tre insieme, e solo una build di RILASCIO firmata
# li usa: in debug vengono ignorati. Cliccare i propri annunci veri puo' far
# sospendere l'account AdMob, quindi gli id veri vanno solo nella build che va
# in produzione.
#
# VERSION_NAME e VERSION_CODE finiscono nell'app. Android installa un APK sopra
# quello precedente solo se il VERSION_CODE e' uguale o piu' alto: la CI usa l'ora,
# in locale alzalo a mano.
#
# Il progetto Android (app/android/) non e' nel repo: lo genera "cap add"
# partendo da package.json e capacitor.config.json, quindi e' sempre quello che
# descrivono quei due file. Se un giorno serviranno modifiche native, basta
# togliere app/android/ dal .gitignore e committarlo.
set -euo pipefail
cd "$(dirname "$0")"

VERSION_NAME="${VERSION_NAME:-1.0.0}"
VERSION_CODE="${VERSION_CODE:-1}"

die() { echo "ERRORE: $*" >&2; exit 1; }

# Questi valori finiscono in un comando sed e nel nome dei file: solo forme note.
[[ "$VERSION_NAME" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$ ]] \
  || die "VERSION_NAME non valido: '$VERSION_NAME' (atteso 1.2.3 o 1.2.3-rc1)"
[[ "$VERSION_CODE" =~ ^[0-9]{1,10}$ ]] && [ "$VERSION_CODE" -le 2100000000 ] \
  || die "VERSION_CODE non valido: '$VERSION_CODE' (intero fino a 2100000000)"

# ------------------------------------------------------------------ AdMob
# ID app di prova di Google (pubblico, nella documentazione di AdMob).
TEST_ADMOB_APP_ID="ca-app-pub-3940256099942544~3347511713"

if [ -z "${ANDROID_KEYSTORE:-}" ]; then
  # Build di debug: sempre annunci di prova, qualunque cosa sia impostata.
  if [ -n "${ADMOB_APP_ID:-}${ADMOB_INTERSTITIAL_ID:-}${ADMOB_APP_OPEN_ID:-}" ]; then
    echo "Nota: build di debug, ignoro gli id AdMob veri e uso quelli di PROVA." >&2
  fi
  unset ADMOB_APP_ID ADMOB_INTERSTITIAL_ID ADMOB_APP_OPEN_ID
fi

if [ -n "${ADMOB_APP_ID:-}${ADMOB_INTERSTITIAL_ID:-}${ADMOB_APP_OPEN_ID:-}" ]; then
  # Tutti e tre, validi, e dello stesso editore: una build mezza di prova e mezza
  # vera sarebbe un errore che non si vede finche' non e' in produzione.
  : "${ADMOB_APP_ID:?manca ADMOB_APP_ID}"
  : "${ADMOB_INTERSTITIAL_ID:?manca ADMOB_INTERSTITIAL_ID}"
  : "${ADMOB_APP_OPEN_ID:?manca ADMOB_APP_OPEN_ID}"
  [[ "$ADMOB_APP_ID" =~ ^ca-app-pub-([0-9]{16})~[0-9]{10}$ ]] \
    || die "ADMOB_APP_ID non valido (atteso ca-app-pub-0000000000000000~0000000000)"
  PUBLISHER="${BASH_REMATCH[1]}"
  for unit in "$ADMOB_INTERSTITIAL_ID" "$ADMOB_APP_OPEN_ID"; do
    [[ "$unit" =~ ^ca-app-pub-${PUBLISHER}/[0-9]{10}$ ]] \
      || die "id unita' AdMob non valido o di un altro editore: '$unit'"
  done
  ADS_MODE="VERI (ca-app-pub-${PUBLISHER})"
else
  ADMOB_APP_ID="$TEST_ADMOB_APP_ID"
  ADS_MODE="di PROVA di Google"
fi
# build.py legge dall'ambiente i due id delle unita' (senza, usa quelli di prova).
export ADMOB_APP_ID
[ -n "${ADMOB_INTERSTITIAL_ID:-}" ] && export ADMOB_INTERSTITIAL_ID ADMOB_APP_OPEN_ID

# Il sito, nella variante per l'app: link d'invito pubblico, PeerJS e CSP.
python3 ../site/build.py --app

npm ci
[ -d android ] || npx cap add android

# Icone e splash dalle immagini di resources/.
npx capacitor-assets generate --android --assetPath resources
npx cap sync android

sed -i -E "s/versionCode [0-9]+/versionCode ${VERSION_CODE}/; s/versionName \".*\"/versionName \"${VERSION_NAME}\"/" \
  android/app/build.gradle

MANIFEST=android/app/src/main/AndroidManifest.xml

# Solo orizzontale: in verticale il tavolo non ci sta. "sensorLandscape" lascia
# girare il telefono fra i due orizzontali. Se il modello di Capacitor cambia e
# la riga non si applica, meglio fermarsi che pubblicare un'app che gira in verticale.
grep -q 'android:screenOrientation' "$MANIFEST" \
  || sed -i 's|android:name="\.MainActivity"|android:name=".MainActivity"\n            android:screenOrientation="sensorLandscape"|' "$MANIFEST"
grep -q 'android:screenOrientation="sensorLandscape"' "$MANIFEST" \
  || die "non riesco a bloccare l'orientamento in $MANIFEST"

# Niente backup: sul telefono ci sono nome, id e segreto di rientro. Il segreto
# serve a un solo dispositivo: ripristinarlo da un backup su un altro lo
# duplicherebbe.
sed -i 's|android:allowBackup="true"|android:allowBackup="false"|' "$MANIFEST"
grep -q 'android:allowBackup="false"' "$MANIFEST" \
  || die "non riesco a disattivare il backup in $MANIFEST"

# AdMob vuole l'id dell'app nel manifest: senza, l'SDK ferma l'app all'avvio.
# Si toglie l'eventuale riga di una build precedente e si rimette quella giusta.
sed -i '/com.google.android.gms.ads.APPLICATION_ID/d' "$MANIFEST"
sed -i "s|    </application>|        <meta-data android:name=\"com.google.android.gms.ads.APPLICATION_ID\" android:value=\"${ADMOB_APP_ID}\" />\n    </application>|" "$MANIFEST"
grep -q "android:value=\"${ADMOB_APP_ID}\"" "$MANIFEST" \
  || die "non riesco a mettere l'id AdMob in $MANIFEST"

# Il plugin AdMob chiede play-services-ads "25.4.+" (qualunque 25.4.x del
# momento): lo fisso, cosi' due build dello stesso codice usano lo stesso SDK.
VARS=android/variables.gradle
sed -i '/playServicesAdsVersion\|userMessagingPlatformVersion/d' "$VARS"
sed -i "\$s|^}\$|    playServicesAdsVersion = '25.4.0'\n    userMessagingPlatformVersion = '4.0.0'\n}|" "$VARS"
grep -q "playServicesAdsVersion = '25.4.0'" "$VARS" \
  || die "non riesco a fissare la versione dell'SDK pubblicitario in $VARS"

echo "Annunci: ${ADS_MODE}"
if [ -n "${ANDROID_KEYSTORE:-}" ] && [ -z "${ADMOB_INTERSTITIAL_ID:-}" ]; then
  echo "ATTENZIONE: rilascio con annunci di PROVA. Va bene per il test chiuso, NON per la produzione (mancano le variabili ADMOB_*)." >&2
fi

if [ -n "${ANDROID_KEYSTORE:-}" ]; then
  # ----------------------------------------------------------- rilascio firmato
  : "${ANDROID_KEYSTORE_PASSWORD:?manca ANDROID_KEYSTORE_PASSWORD}"
  : "${ANDROID_KEY_ALIAS:?manca ANDROID_KEY_ALIAS}"
  : "${ANDROID_KEY_PASSWORD:?manca ANDROID_KEY_PASSWORD}"
  [ -f "$ANDROID_KEYSTORE" ] || die "il file ANDROID_KEYSTORE non esiste: $ANDROID_KEYSTORE"
  ANDROID_KEYSTORE="$(cd "$(dirname "$ANDROID_KEYSTORE")" && pwd)/$(basename "$ANDROID_KEYSTORE")"
  export ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_PASSWORD

  (cd android && ./gradlew --no-daemon assembleRelease bundleRelease)

  TOOLS="$(ls -d "${ANDROID_HOME:?manca ANDROID_HOME}"/build-tools/* | sort -V | tail -1)"
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT
  "$TOOLS/zipalign" -p -f 4 android/app/build/outputs/apk/release/app-release-unsigned.apk "$WORK/aligned.apk"
  "$TOOLS/apksigner" sign --ks "$ANDROID_KEYSTORE" --ks-key-alias "$ANDROID_KEY_ALIAS" \
    --ks-pass env:ANDROID_KEYSTORE_PASSWORD --key-pass env:ANDROID_KEY_PASSWORD \
    --out "dichiaro-${VERSION_NAME}-release.apk" "$WORK/aligned.apk"
  "$TOOLS/apksigner" verify "dichiaro-${VERSION_NAME}-release.apk"

  cp android/app/build/outputs/bundle/release/app-release.aab "dichiaro-${VERSION_NAME}.aab"
  jarsigner -keystore "$ANDROID_KEYSTORE" -storepass:env ANDROID_KEYSTORE_PASSWORD \
    -keypass:env ANDROID_KEY_PASSWORD -sigalg SHA256withRSA -digestalg SHA-256 \
    "dichiaro-${VERSION_NAME}.aab" "$ANDROID_KEY_ALIAS" >/dev/null
  jarsigner -verify "dichiaro-${VERSION_NAME}.aab" >/dev/null

  echo "Rilascio firmato pronto: app/dichiaro-${VERSION_NAME}-release.apk e app/dichiaro-${VERSION_NAME}.aab"
else
  # --------------------------------------------------------------------- debug
  # Chiave di debug fissa: senza, ogni macchina ne genera una nuova e Android
  # rifiuta l'aggiornamento sopra un'installazione fatta con un'altra chiave. E'
  # la chiave pubblica di debug (password "android"), non un segreto. Non
  # sovrascrive quella che uno ha gia' in locale.
  mkdir -p "${ANDROID_USER_HOME:-$HOME/.android}"
  cp -n debug.keystore "${ANDROID_USER_HOME:-$HOME/.android}/debug.keystore" || true

  (cd android && ./gradlew --no-daemon assembleDebug)

  cp android/app/build/outputs/apk/debug/app-debug.apk "dichiaro-${VERSION_NAME}.apk"
  echo "APK di debug pronto: app/dichiaro-${VERSION_NAME}.apk"
fi
