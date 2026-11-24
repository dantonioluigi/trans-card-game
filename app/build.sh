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
# VERSION_NAME e VERSION_CODE finiscono nell'app. Android installa un APK sopra
# quello precedente solo se il VERSION_CODE e' uguale o piu' alto: la CI lo ricava
# dal tag (X.Y.Z-rcN -> X*1000000 + Y*10000 + Z*100 + N, la finale +99); in locale
# alzalo a mano.
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

# Play ricava da "sensorLandscape" un requisito hardware (schermo orizzontale) e
# toglie la scheda ai dispositivi che non lo dichiarano. Il blocco e' una scelta
# dell'app, non un limite del telefono: il requisito si dichiara facoltativo.
grep -q 'android.hardware.screen.landscape' "$MANIFEST" \
  || sed -i 's|<application|<uses-feature android:name="android.hardware.screen.landscape" android:required="false" />\n\n    <application|' "$MANIFEST"
grep -q 'android:name="android.hardware.screen.landscape" android:required="false"' "$MANIFEST" \
  || die "non riesco a rendere facoltativo l'orientamento in $MANIFEST"

# Niente backup: sul telefono ci sono nome, id e segreto di rientro. Il segreto
# serve a un solo dispositivo: ripristinarlo da un backup su un altro lo
# duplicherebbe.
sed -i 's|android:allowBackup="true"|android:allowBackup="false"|' "$MANIFEST"
grep -q 'android:allowBackup="false"' "$MANIFEST" \
  || die "non riesco a disattivare il backup in $MANIFEST"

# L'app disegna a tutto schermo e la pagina resta fuori dalle barre di sistema
# con un margine. Dove la WebView e' piu' vecchia quel margine lo mette Android, e
# sotto le barre si vede lo sfondo della finestra: il tema e' "giorno/notte", quindi
# sul telefono in modo chiaro sarebbe una fascia bianca. Lo sfondo e' quello dell'app.
STYLES=android/app/src/main/res/values/styles.xml
grep -q 'android:windowBackground' "$STYLES" \
  || sed -i 's|<item name="android:background">@null</item>|<item name="android:background">@null</item>\n        <item name="android:windowBackground">#0b1512</item>|' "$STYLES"
grep -q 'android:windowBackground">#0b1512' "$STYLES" \
  || die "non riesco a impostare lo sfondo della finestra in $STYLES"

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
